/**
 * The whole world as pure functions of one seed: the road, the ground height, rivers, mountains,
 * surfaces and where scenery stands. The main thread and the terrain worker both import this file and
 * build exactly the same world, so chunks made at different times always meet without a seam.
 *
 * The road is described by its heading as a smooth function of distance along it (s). Heading stays
 * within ±1.4 rad of +Z, so the road always makes progress along +Z when s grows and along -Z when s
 * shrinks. That keeps it from looping back over itself, makes it endless in both directions, and lets
 * any part of it be rebuilt identically from s = 0 outwards.
 */
import { createNoise2D } from 'simplex-noise';

export const WORLD_SEED = 'everdribe';

// ---- Road cross section (metres) ----
export const ROAD_HALF_WIDTH = 5;      // asphalt, two lanes
export const ROAD_SHOULDER = 2.5;      // gravel either side
export const ROAD_HALF_TOTAL = ROAD_HALF_WIDTH + ROAD_SHOULDER;
export const ROAD_STEP = 2;            // metres between centre-line samples

export const WATER_LEVEL = -7;         // one sea level for every river and lake

// ---------------------------------------------------------------------------------------------
// Seeded noise
// ---------------------------------------------------------------------------------------------

function seededRandom(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const noiseA = createNoise2D(seededRandom(WORLD_SEED + ':a'));
const noiseB = createNoise2D(seededRandom(WORLD_SEED + ':b'));
const noiseC = createNoise2D(seededRandom(WORLD_SEED + ':c'));

/** Plain 2D noise in -1..1 for colouring and scattering. */
export const noise2 = (x: number, z: number) => noiseC(x, z);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Integer hash to 0..1, for deterministic scatter. */
export function hash2(x: number, z: number, k = 0): number {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(k | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// Land shape without the road
// ---------------------------------------------------------------------------------------------

function fbm(x: number, z: number): number {
    let sum = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 4; o++) {
        sum += amp * noiseA(x * f, z * f);
        f *= 2.03;
        amp *= 0.5;
    }
    return sum; // about -1..1
}

/** 0 on open plains, 1 in hill country. Changes over a couple of kilometres. */
export function hilliness(x: number, z: number): number {
    return smoothstep(-0.25, 0.45, noiseB(x / 2600, z / 2600));
}

/** How wooded the country is here, 0 (open meadow) .. 1 (thick woods). Changes over ~1 km. */
export function forestAmount(x: number, z: number): number {
    return smoothstep(-0.15, 0.55, noiseC(x / 700 + 3, z / 700 - 9));
}

/** How much of a river channel is at this point, 0..1. Rivers wind across the land as noise valleys. */
export function riverAmount(x: number, z: number): number {
    const r = Math.abs(noiseB(x / 1300 + 40, z / 1300 - 70));
    return smoothstep(0.034, 0.012, r);
}

/** Rolling ground plus rivers, before mountains and before the road flattens its corridor. */
export function baseHeight(x: number, z: number): number {
    const hills = hilliness(x, z);
    let h = noiseA(x / 900 + 11, z / 900 - 7) * 5;                // broad swells, even on the plains
    h += fbm(x / 420, z / 420) * 30 * hills;                        // hills
    h += noiseC(x / 60, z / 60) * 0.35;                             // small bumps you feel in the seat
    const river = riverAmount(x, z);
    if (river > 0) h = lerp(h, WATER_LEVEL - 2.2, river);
    return h;
}

/** Big mountains, only allowed far from the road. */
function mountainHeight(x: number, z: number): number {
    const ridge = 1 - Math.abs(noiseA(x / 1100 - 300, z / 1100 + 200));
    const m = Math.pow(ridge, 2.2) * 150 + fbm(x / 300 + 50, z / 300) * 25;
    return Math.max(0, m);
}

// ---------------------------------------------------------------------------------------------
// The road
// ---------------------------------------------------------------------------------------------

const roadNoise = (s: number, k: number) => noiseC(s, k * 31.7 + 5);

/** Heading at distance s along the road; 0 = +Z, positive turns towards +X. */
export function roadHeading(s: number): number {
    return 0.82 * roadNoise(s / 900, 1) + 0.38 * roadNoise(s / 260, 2) + 0.2 * roadNoise(s / 95, 3);
}

export interface RoadQuery {
    distance: number;  // metres from the centre line (always >= 0)
    side: number;      // -1 left, +1 right (looking along +s)
    s: number;         // distance along the road of the nearest point
    y: number;         // road surface height there (centre)
    tx: number;        // unit tangent (x, z) along +s
    tz: number;
}

const HASH_CELL = 40;           // fine grid for exact nearest-point queries
const COARSE_CELL = 400;        // coarse grid for "how far is the road" (mountains)
const COARSE_EVERY = 10;        // coarse grid keeps every 10th sample (20 m)
const SMOOTH_SAMPLES = 35;      // road height = terrain averaged over ±70 m

class Road {
    // Samples for i >= 0 live in pos*, for i <= 0 in neg* (index -i). Both hold i = 0.
    private posX: number[] = [0];
    private posZ: number[] = [0];
    private negX: number[] = [0];
    private negZ: number[] = [0];
    private posBase: number[] = [];
    private negBase: number[] = [];
    private yCache = new Map<number, number>();
    private grid = new Map<number, number[]>();
    private coarse = new Map<number, number[]>();

    constructor() {
        this.index(0);
    }

    get minIndex() { return -(this.negX.length - 1); }
    get maxIndex() { return this.posX.length - 1; }

    x(i: number) { return i >= 0 ? this.posX[i] : this.negX[-i]; }
    z(i: number) { return i >= 0 ? this.posZ[i] : this.negZ[-i]; }

    private key(cx: number, cz: number) { return cx * 73856093 + cz * 19349663; }

    private index(i: number) {
        const x = this.x(i), z = this.z(i);
        const k = this.key(Math.floor(x / HASH_CELL), Math.floor(z / HASH_CELL));
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(i);
        if (i % COARSE_EVERY === 0) {
            const ck = this.key(Math.floor(x / COARSE_CELL), Math.floor(z / COARSE_CELL));
            let cl = this.coarse.get(ck);
            if (!cl) this.coarse.set(ck, (cl = []));
            cl.push(i);
        }
    }

    /** Make sure samples exist for every index in [iMin, iMax]. */
    ensure(iMin: number, iMax: number) {
        while (this.maxIndex < iMax) {
            const i = this.maxIndex;
            const h = roadHeading((i + 0.5) * ROAD_STEP);
            this.posX.push(this.posX[i] + Math.sin(h) * ROAD_STEP);
            this.posZ.push(this.posZ[i] + Math.cos(h) * ROAD_STEP);
            this.index(i + 1);
        }
        while (this.minIndex > iMin) {
            const i = this.minIndex;
            const h = roadHeading((i - 0.5) * ROAD_STEP);
            this.negX.push(this.x(i) - Math.sin(h) * ROAD_STEP);
            this.negZ.push(this.z(i) - Math.cos(h) * ROAD_STEP);
            this.index(i - 1);
        }
    }

    /** Make sure the road covers every point with z in [zMin, zMax] plus a margin. */
    ensureZ(zMin: number, zMax: number) {
        while (this.z(this.maxIndex) < zMax + 1000) this.ensure(this.minIndex, this.maxIndex + 200);
        while (this.z(this.minIndex) > zMin - 1000) this.ensure(this.minIndex - 200, this.maxIndex);
    }

    private base(i: number): number {
        const arr = i >= 0 ? this.posBase : this.negBase;
        const j = Math.abs(i);
        let v = arr[j];
        if (v === undefined) {
            this.ensure(i, i);
            v = baseHeight(this.x(i), this.z(i));
            arr[j] = v;
        }
        return v;
    }

    /** Road height at sample i: the land averaged along the road, never under the river level. */
    y(i: number): number {
        let v = this.yCache.get(i);
        if (v !== undefined) return v;
        this.ensure(i - SMOOTH_SAMPLES, i + SMOOTH_SAMPLES);
        let sum = 0, wsum = 0;
        for (let k = -SMOOTH_SAMPLES; k <= SMOOTH_SAMPLES; k++) {
            const w = SMOOTH_SAMPLES + 1 - Math.abs(k);
            sum += this.base(i + k) * w;
            wsum += w;
        }
        v = sum / wsum;
        // Over rivers the road stays up as a bridge; a soft max keeps the deck smooth
        const floor = WATER_LEVEL + 4.5;
        v = (v + floor + Math.sqrt((v - floor) * (v - floor) + 9)) / 2;
        this.yCache.set(i, v);
        return v;
    }

    /** Interpolated centre point and height at any s. */
    at(s: number): { x: number; z: number; y: number; tx: number; tz: number } {
        const f = s / ROAD_STEP;
        const i = Math.floor(f);
        const t = f - i;
        this.ensure(i - 1, i + 2);
        const x = lerp(this.x(i), this.x(i + 1), t);
        const z = lerp(this.z(i), this.z(i + 1), t);
        const y = lerp(this.y(i), this.y(i + 1), t);
        const h = roadHeading(s);
        return { x, z, y, tx: Math.sin(h), tz: Math.cos(h) };
    }

    /** Nearest point on the road within ~40 m, or null if the road is further away. */
    query(px: number, pz: number): RoadQuery | null {
        const cx = Math.floor(px / HASH_CELL), cz = Math.floor(pz / HASH_CELL);
        let best = Infinity, bi = 0, bt = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const list = this.grid.get(this.key(cx + dx, cz + dz));
                if (!list) continue;
                for (const i of list) {
                    // Check both segments that touch sample i
                    for (const j of [i - 1, i]) {
                        if (j < this.minIndex || j + 1 > this.maxIndex) continue;
                        const ax = this.x(j), az = this.z(j);
                        const bx = this.x(j + 1), bz = this.z(j + 1);
                        const ex = bx - ax, ez = bz - az;
                        let t = ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez);
                        t = t < 0 ? 0 : t > 1 ? 1 : t;
                        const qx = ax + ex * t - px, qz = az + ez * t - pz;
                        const d2 = qx * qx + qz * qz;
                        if (d2 < best) { best = d2; bi = j; bt = t; }
                    }
                }
            }
        }
        if (best === Infinity) return null;
        const ax = this.x(bi), az = this.z(bi);
        const ex = this.x(bi + 1) - ax, ez = this.z(bi + 1) - az;
        const len = Math.hypot(ex, ez);
        const tx = ex / len, tz = ez / len;
        // Right of +s is (tz, -tx) in this world (heading 0 = +Z, positive heading turns to +X)
        const rx = tz, rz = -tx;
        const lateral = (px - ax) * rx + (pz - az) * rz;
        return {
            distance: Math.sqrt(best),
            side: lateral >= 0 ? 1 : -1,
            s: (bi + bt) * ROAD_STEP,
            y: lerp(this.y(bi), this.y(bi + 1), bt),
            tx, tz,
        };
    }

    /** Rough distance to the road (20 m accuracy), Infinity if more than ~400 m away. */
    roughDistance(px: number, pz: number): number {
        const cx = Math.floor(px / COARSE_CELL), cz = Math.floor(pz / COARSE_CELL);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const list = this.coarse.get(this.key(cx + dx, cz + dz));
                if (!list) continue;
                for (const i of list) {
                    const qx = this.x(i) - px, qz = this.z(i) - pz;
                    const d2 = qx * qx + qz * qz;
                    if (d2 < best) best = d2;
                }
            }
        }
        return Math.sqrt(best);
    }

    /** The index of the sample nearest to a point, searching outwards from a hint. */
    nearestIndex(px: number, pz: number): number {
        const q = this.query(px, pz);
        if (q) return Math.round(q.s / ROAD_STEP);
        // Far from the road: the road progresses along z, so search by z
        this.ensureZ(pz, pz);
        let lo = this.minIndex, hi = this.maxIndex;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (this.z(mid) < pz) lo = mid; else hi = mid;
        }
        return lo;
    }
}

export const road = new Road();

// ---------------------------------------------------------------------------------------------
// Final ground
// ---------------------------------------------------------------------------------------------

/** Height of the land itself (not the road deck) at any point. Matches the terrain mesh exactly. */
export function terrainHeight(x: number, z: number): number {
    road.ensureZ(z, z);
    const base = baseHeight(x, z);
    const rough = road.roughDistance(x, z);
    let h = base + mountainHeight(x, z) * smoothstep(160, 420, rough);
    const q = rough < 60 ? road.query(x, z) : null;
    if (q) {
        // Flatten a corridor around the road, with soft cut and fill slopes beyond the shoulders.
        // Rivers still run under the road, which leaves the road standing on a bridge.
        const keep = smoothstep(ROAD_HALF_TOTAL + 0.5, ROAD_HALF_TOTAL + 26, q.distance);
        const river = riverAmount(x, z);
        const corridor = q.y - 0.12;
        h = lerp(corridor, h, Math.max(keep, river));
    }
    return h;
}

export type Surface = 'asphalt' | 'shoulder' | 'grass' | 'water';

export interface GroundSample {
    height: number;     // where a wheel would rest
    surface: Surface;
    grip: number;       // tyre friction multiplier
    roll: number;       // rolling resistance, m/s²
}

/** What a wheel touches at (x, z): the road deck near the centre line, the land elsewhere. */
export function groundAt(x: number, z: number): GroundSample {
    road.ensureZ(z, z);
    const q = road.query(x, z);
    if (q && q.distance <= ROAD_HALF_TOTAL) {
        if (q.distance <= ROAD_HALF_WIDTH) {
            // The asphalt has a slight crown
            const crown = 0.03 * (1 - (q.distance / ROAD_HALF_WIDTH) ** 2);
            return { height: q.y + 0.04 + crown, surface: 'asphalt', grip: 1.0, roll: 0.25 };
        }
        const t = (q.distance - ROAD_HALF_WIDTH) / ROAD_SHOULDER;
        return { height: q.y + 0.04 - 0.08 * t, surface: 'shoulder', grip: 0.82 - 0.12 * t, roll: 0.6 + t * 0.6 };
    }
    const h = terrainHeight(x, z);
    if (h < WATER_LEVEL - 0.6) return { height: h, surface: 'water', grip: 0.3, roll: 6 };
    return { height: h, surface: 'grass', grip: 0.68, roll: 1.3 };
}

/**
 * How bare the land is at (x, z), 0 = meadow grass, 1 = soil or sand: the dirt patches and wet banks
 * the terrain worker paints (same noise), so the tyre sound matches what the player sees under the car.
 */
export function groundBareness(x: number, z: number): number {
    const patches = noise2(x / 45 + 3, z / 45 - 8) * 0.7 + noise2(x / 9, z / 9) * 0.3;
    const dirt = smoothstep(0.45, 0.8, patches) * 0.8;
    const wet = smoothstep(WATER_LEVEL + 2.8, WATER_LEVEL + 0.6, terrainHeight(x, z)) + riverAmount(x, z) * 0.6;
    return Math.min(1, Math.max(dirt, wet));
}

// ---------------------------------------------------------------------------------------------
// Scenery placement
// ---------------------------------------------------------------------------------------------

export type PropKind =
    | 'treeGreen' | 'treeAutumn' | 'birch' | 'pine' | 'bush' | 'rock'
    | 'house' | 'barn' | 'fence' | 'guardrail';

export interface Prop {
    kind: PropKind;
    x: number;
    y: number;
    z: number;
    rot: number;        // yaw, radians
    scale: number;
    radius: number;     // collision radius in metres (0 = drive through)
    halfLength?: number; // for long props (fence, guardrail, buildings): half length along rot
}

export const PROP_CELL = 48;

/** Collision footprint per kind at scale 1 (metres). */
const RADIUS: Record<PropKind, number> = {
    treeGreen: 0.55, treeAutumn: 0.55, birch: 0.35, pine: 0.45, bush: 0, rock: 1.1,
    house: 4.5, barn: 5.5, fence: 0.15, guardrail: 0.2,
};

/**
 * Natural scenery for one grid cell: trees, bushes and rocks. Forest density follows a noise field,
 * so there are open meadows, scattered trees and thick woods. Nothing grows on the road or in water.
 */
export function cellProps(cx: number, cz: number): Prop[] {
    const out: Prop[] = [];
    const x0 = cx * PROP_CELL, z0 = cz * PROP_CELL;
    const mx = x0 + PROP_CELL / 2, mz = z0 + PROP_CELL / 2;
    road.ensureZ(z0, z0 + PROP_CELL);

    const forest = forestAmount(mx, mz);
    const hills = hilliness(mx, mz);
    // Woods thick enough to read as woods from the road and on far hillsides (v0.15.0: was 1 + 9 + 2, about
    // one tree per 200 m² at most, which left the hills looking bare)
    const count = Math.floor(1 + forest * 17 + hills * 5);

    for (let k = 0; k < count; k++) {
        const r1 = hash2(cx, cz, k * 7 + 1);
        const r2 = hash2(cx, cz, k * 7 + 2);
        const r3 = hash2(cx, cz, k * 7 + 3);
        const r4 = hash2(cx, cz, k * 7 + 4);
        const x = x0 + r1 * PROP_CELL;
        const z = z0 + r2 * PROP_CELL;

        let kind: PropKind;
        if (r3 < 0.1) kind = 'rock';
        else if (r3 < 0.32) kind = 'bush';
        else kind = treeSpecies(x, z, hills, hash2(cx, cz, k * 7 + 5));
        // Outside forests, only a few lone trees and bushes
        if (forest < 0.2 && kind !== 'bush' && kind !== 'rock' && r4 > 0.35) continue;

        const q = road.query(x, z);
        const clearance = kind === 'bush' ? 3 : kind === 'rock' ? 5 : 7;
        if (q && q.distance < ROAD_HALF_TOTAL + clearance) continue;
        if (riverAmount(x, z) > 0.15) continue;
        const y = terrainHeight(x, z);
        if (y < WATER_LEVEL + 0.8) continue;

        const scale = kind === 'rock' ? 0.6 + r4 * 1.4 : 0.75 + r4 * 0.6;
        out.push({ kind, x, y, z, rot: hash2(cx, cz, k * 7 + 6) * Math.PI * 2, scale, radius: RADIUS[kind] * scale });
    }
    roadsideWoods(cx, cz, forest, hills, out);
    return out;
}

/**
 * Which tree grows here. The mix changes slowly across the map, so the drive passes through different
 * woods: birch groves, patches of autumn colour, pine forest on the hills, mixed broadleaf elsewhere.
 * `r` is the tree's own random number (0..1).
 */
function treeSpecies(x: number, z: number, hills: number, r: number): PropKind {
    const pine = 0.1 + hills * 0.6;
    const birch = smoothstep(0.15, 0.6, noiseB(x / 900 + 5.3, z / 900 - 3.1)) * 0.75;
    const autumn = smoothstep(0.3, 0.75, noiseC(x / 1100 - 7.7, z / 1100 + 2.4)) * 0.65;
    if (r < pine) return 'pine';
    const rest = (r - pine) / (1 - pine);
    if (rest < birch) return 'birch';
    if (rest < birch + (1 - birch) * autumn) return 'treeAutumn';
    return 'treeGreen';
}

/**
 * Roadside woods: where the country is wooded or hilly, trees and undergrowth come right up to the
 * road (4–17 m past the gravel), so the road runs through a green corridor with trees shading it,
 * as on a forest mountain pass. Open farmland gets a thinner line of trees. Farms are kept clear.
 */
const WOODS_NEAR = 4, WOODS_FAR = 17;
function roadsideWoods(cx: number, cz: number, forest: number, hills: number, out: Prop[]) {
    const x0 = cx * PROP_CELL, z0 = cz * PROP_CELL;
    const centre = road.query(x0 + PROP_CELL / 2, z0 + PROP_CELL / 2);
    if (!centre || centre.distance > PROP_CELL * 0.72 + ROAD_HALF_TOTAL + WOODS_FAR) return;
    // Some trees along every road, a full green corridor in wooded or hilly country
    const woods = 0.3 + 0.7 * smoothstep(0.15, 0.6, forest * 0.75 + hills * 0.7);
    const tries = Math.round(woods * 26);
    const block = Math.floor(centre.s / 600);
    const farm = [...farmProps(block - 1), ...farmProps(block), ...farmProps(block + 1)];
    for (let k = 0; k < tries; k++) {
        const x = x0 + hash2(cx, cz, 900 + k * 5) * PROP_CELL;
        const z = z0 + hash2(cx, cz, 901 + k * 5) * PROP_CELL;
        const q = road.query(x, z);
        if (!q) continue;
        const verge = q.distance - ROAD_HALF_TOTAL;
        if (verge < WOODS_NEAR || verge > WOODS_FAR) continue;
        if (riverAmount(x, z) > 0.1) continue;
        if (farm.some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 < 18 * 18)) continue;
        const y = terrainHeight(x, z);
        if (y < WATER_LEVEL + 0.8) continue;
        const r3 = hash2(cx, cz, 902 + k * 5), r4 = hash2(cx, cz, 903 + k * 5);
        // Undergrowth in front, tall trees behind it
        const kind: PropKind = verge < 7 && r3 < 0.45 ? 'bush' : treeSpecies(x, z, hills, hash2(cx, cz, 905 + k * 5));
        const scale = kind === 'bush' ? 0.9 + r4 * 0.8 : 0.85 + r4 * 0.55;
        out.push({ kind, x, y, z, rot: hash2(cx, cz, 904 + k * 5) * Math.PI * 2, scale, radius: RADIUS[kind] * scale });
    }
}

/**
 * Farms: every ~600 m of road there may be a farmhouse and barn set back from the road on flat
 * ground, with a fence along the road in front of them. Placed relative to the road so they face it.
 */
export function farmProps(block: number): Prop[] {
    const BLOCK = 600;
    const out: Prop[] = [];
    if (hash2(block, 7, 1) > 0.55) return out;
    const s = block * BLOCK + hash2(block, 7, 2) * BLOCK * 0.6;
    const p = road.at(s);
    if (hilliness(p.x, p.z) > 0.55) return out;
    const side = hash2(block, 7, 3) < 0.5 ? -1 : 1;
    const rx = p.tz * side, rz = -p.tx * side;   // pointing away from the road on the chosen side
    const yaw = Math.atan2(p.tx, p.tz);         // along the road

    const place = (kind: PropKind, along: number, out_: number, rot: number) => {
        const x = p.x + p.tx * along + rx * out_;
        const z = p.z + p.tz * along + rz * out_;
        if (riverAmount(x, z) > 0.05) return;
        const q = road.query(x, z);
        if (q && q.distance < ROAD_HALF_TOTAL + 9) return;
        const y = terrainHeight(x, z);
        if (y < WATER_LEVEL + 1.5) return;
        out.push({ kind, x, y, z, rot, scale: 1, radius: RADIUS[kind], halfLength: kind === 'barn' ? 6 : 5 });
    };
    // House faces the road, barn beside and a little further back
    place('house', 0, 26, yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
    place('barn', 24, 38, yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2));

    // A fence line parallel to the road, in front of the yard
    for (let f = -6; f <= 9; f++) {
        const along = f * 4;
        const fx = p.x + p.tx * along + rx * 14;
        const fz = p.z + p.tz * along + rz * 14;
        const q = road.query(fx, fz);
        if (q && q.distance < ROAD_HALF_TOTAL + 3) continue;
        const y = terrainHeight(fx, fz);
        if (y < WATER_LEVEL + 1) continue;
        out.push({ kind: 'fence', x: fx, y, z: fz, rot: yaw, scale: 1, radius: 0, halfLength: 2 });
    }
    return out;
}

/** Whether a guardrail runs along this road sample, on the given side (-1 left, +1 right). */
export function hasGuardrail(i: number, side: number): boolean {
    // On sharp bends (outside of the curve), and wherever the land drops away (bridges, embankments)
    road.ensure(i - 3, i + 3);
    const curvature = roadHeading((i + 2) * ROAD_STEP) - roadHeading((i - 2) * ROAD_STEP);
    const outside = curvature > 0 ? -1 : 1; // turning right (+) means the left side is the outside
    if (Math.abs(curvature) > 0.07 && side === outside) return true;
    const p = road.at(i * ROAD_STEP);
    const rx = p.tz * side, rz = -p.tx * side;
    const ox = p.x + rx * (ROAD_HALF_TOTAL + 6), oz = p.z + rz * (ROAD_HALF_TOTAL + 6);
    const drop = p.y - baseHeight(ox, oz);
    return drop > 3.5 || riverAmount(p.x, p.z) > 0.2;
}

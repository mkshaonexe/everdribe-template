import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
    BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4,
    SRGBColorSpace,
} from 'three';
import { road, riverAmount, terrainHeight, smoothstep, hash2, noise2, ROAD_HALF_TOTAL, WATER_LEVEL } from './WorldGen';
import { playerPose, useGameStore } from '../stores/gameStore';
import { GRAPHICS } from '../graphics/GraphicsProfile';
import { grassUniforms, makeGrass } from '../graphics/Foliage';
import { inViewCone, viewConeChanged } from '../graphics/ViewCone';
import type { ViewCone } from '../graphics/ViewCone';

/**
 * The sward: a continuous carpet of fine grass blades over the ground near the car, thick in some places
 * and thin in others, with taller clumps, dry patches and flowers here and there.
 *
 * The ground is cut into 1 m cells and every cell gets the same patch of blades spread over its whole
 * square (turned and mirrored per cell), so the carpet has no gaps between tufts. What makes it look
 * natural happens per blade in the vertex shader, from smooth noise over the world: whether the blade is
 * there at all (bare spots, thick patches), how tall it is (clumps, short mown grass at the road edge),
 * whether its tip is dry, and whether a flower opens. Neighbouring cells blend into each other, so no cell
 * edges or repeats show.
 *
 * Four levels of detail. The mid patch is the first two fifths of the near patch's blades (same
 * places), drawn wider; the shader thins and widens near blades towards it with distance, so the switch is
 * not seen. Far away, patches are 2 x 2 m with an eighth of the near density, wider still: a quarter of
 * the cells to gather and place, which is where the CPU time of a rebuild went. Farthest out (v0.15.0),
 * 4 x 4 m patches of wide blades carry the meadow on to the woods, so it no longer ends in a line ~50 m
 * from the car with bare ground behind it.
 */
const REBUILD = 5;                // rebuild the lists after the car moves this far (m)
const BLADES = 180;               // blades in the near patch (per m²)
const FLOWERS = 10;
/**
 * Per level: blades and flowers in one patch, rows per blade, patch size (m), and for the shader the rank
 * limit (share of the near patch's blades, see makeGrass) and blade width, each at the start and at the
 * end of the level's fade towards the next level.
 */
const LODS: { blades: number; flowers: number; segs: number; size: number; keep: [number, number]; widen: [number, number] }[] = [
    { blades: BLADES, flowers: FLOWERS, segs: 3, size: 1, keep: [1, 72 / BLADES], widen: [1, 1.7] },
    { blades: 72, flowers: 5, segs: 2, size: 1, keep: [72 / BLADES, 24 / BLADES], widen: [1.7, 3.4] },
    // 96 blades on 4 m² = 24 per m², the density the mid level fades out to; it thins to 45 (11 per m²)
    { blades: 96, flowers: 0, segs: 1, size: 2, keep: [96 / BLADES, 45 / BLADES], widen: [3.4, 5.5] },
    // 180 blades on 16 m² = 11 per m² at entry, fading to half towards the outer edge
    { blades: BLADES, flowers: 0, segs: 1, size: 4, keep: [1, 0.5], widen: [5.5, 7] },
];
const KEEP_NEAR = 4;              // grass behind the camera beyond this is not drawn (m)
// A cell gets a level while it is still this far out: the near level thins out over 3 m past grassNear
// (the mid level over 4 m past grassMid, in the shader), and the car moves up to REBUILD m between
// rebuilds, so a cell is always at the finer level by the time the car is close enough to need it
const nearAssign = (near: number) => near + 3 + REBUILD;
const midAssign = (mid: number) => mid + 4 + REBUILD;
const farAssign = (far: number) => far + 6 + REBUILD;

const col = (h: number, s: number, l: number) => new Color().setHSL(h / 360, s / 100, l / 100, SRGBColorSpace);

/**
 * One patch: `blades` grass blades (the first ones of the near patch, same places) and `flowers` small
 * flowers, scattered over a `size` x `size` m square standing on y = 0.
 *
 * Attributes for the shader:
 * - aBlade: the blade's root (x, z), its rank (0..1, which blades go first where the grass is thin) and
 *   how far up the blade the vertex is (0 root .. 1 tip; 2 for flower vertices);
 * - aSide: the vertex's offset across the blade, so the shader can widen blades for distance.
 * Colours are per vertex, dark at the root; normals lean to the sky, so blades are lit like soft grass.
 */
function patch(blades: number, flowers: number, segs: number, size: number): BufferGeometry {
    let s = 9241;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const pos: number[] = [], nrm: number[] = [], clr: number[] = [], blade: number[] = [], side: number[] = [], idx: number[] = [];
    for (let b = 0; b < Math.max(BLADES, blades); b++) {
        // Draw every random number even for blades this level skips, so all levels share the same blades
        const x0 = (r() - 0.5) * size, z0 = (r() - 0.5) * size;
        const stalk = r() < 0.07;                         // a few thin, tall seed stalks
        const h = stalk ? 0.5 + r() * 0.35 : 0.14 + Math.pow(r(), 1.6) * 0.46;
        const w = stalk ? 0.007 : 0.011 + r() * 0.012;    // half-width at the root
        const lean = 0.08 + r() * 0.32;
        const dir = r() * Math.PI * 2;
        const tip = stalk ? col(46 + r() * 8, 40 + r() * 12, 58 + r() * 10) : col(70 + r() * 32, 34 + r() * 22, 27 + r() * 17);
        const rootDark = 0.32 + r() * 0.12;
        if (b >= blades) continue;
        const root = tip.clone().multiplyScalar(rootDark);
        const rank = (b + 0.5) / BLADES;
        const fx = -Math.sin(dir), fz = Math.cos(dir);    // across the blade
        const nx = Math.cos(dir) * 0.45, nz = Math.sin(dir) * 0.45, nl = Math.hypot(nx, 1, nz);
        const base = pos.length / 3;
        const vertex = (t: number, across: number) => {
            const bend = lean * t * t;
            const cx = x0 + Math.cos(dir) * bend * h, cz = z0 + Math.sin(dir) * bend * h;
            const cy = h * t * (1 - 0.25 * lean * t);
            const half = w * (1 - t * 0.85) * across;
            pos.push(cx + fx * half, cy, cz + fz * half);
            side.push(fx * half, fz * half);
            nrm.push(nx / nl, 1 / nl, nz / nl);
            const c = root.clone().lerp(tip, Math.pow(t, 0.7));
            clr.push(c.r, c.g, c.b);
            blade.push(x0, z0, rank, t);
        };
        // Rows of two up the blade, then a single tip vertex
        for (let i = 0; i < segs; i++) {
            const t = (i / segs) * 0.92;
            vertex(t, -1); vertex(t, 1);
        }
        vertex(1, 0);
        for (let i = 0; i < segs - 1; i++) {
            const v = base + i * 2;
            idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        }
        const last = base + (segs - 1) * 2;
        idx.push(last, last + 2, last + 1);
    }
    // Flowers: small four-petal stars on stalk tops, yellow or white (the shader opens them in patches)
    let rf = 5333;
    const q = () => { rf = (rf * 16807) % 2147483647; return rf / 2147483647; };
    for (let f = 0; f < FLOWERS; f++) {
        const x = (q() - 0.5) * size, z = (q() - 0.5) * size;
        const y = 0.3 + q() * 0.3;
        const petal = 0.03 + q() * 0.02;
        const c = q() < 0.6 ? col(50, 90, 62) : col(45, 20, 93);
        if (f >= flowers) continue;
        const base = pos.length / 3;
        pos.push(x, y, z, x + petal, y + 0.004, z, x, y + 0.008, z + petal, x - petal, y + 0.004, z, x, y, z - petal);
        for (let k = 0; k < 5; k++) {
            nrm.push(0, 1, 0); clr.push(c.r, c.g, c.b); side.push(0, 0);
            blade.push(x, z, (f + 0.5) / FLOWERS, 2);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 4, base, base + 4, base + 1);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new Float32BufferAttribute(clr, 3));
    g.setAttribute('aBlade', new Float32BufferAttribute(blade, 4));
    g.setAttribute('aSide', new Float32BufferAttribute(side, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
}

/**
 * One ground cell: its height and slope (the patch is sheared so the roots follow the ground while the
 * blades stay upright; worked out only near the car, where it shows), the direction away from the road and
 * the verge distance at its centre (the shader keeps blades off the gravel with these), and how thick the
 * grass is there.
 */
interface Cell {
    y: number; sx: number; sz: number; sloped: boolean; nx: number; nz: number; verge: number; dense: number; turn: number;
}

/**
 * A grid of cells of one size (1 m near the car, 2 m far away), with the cells and the ground height at
 * each cell centre cached. The height is the one expensive lookup per cell (it may ask the road where it
 * is) and is shared by the cell itself and by its neighbours' slopes.
 */
interface Grid { size: number; cells: Map<number, Cell | null>; heights: Map<number, number> }
const FINE: Grid = { size: 1, cells: new Map(), heights: new Map() };
const COARSE: Grid = { size: 2, cells: new Map(), heights: new Map() };
const FARTHEST: Grid = { size: 4, cells: new Map(), heights: new Map() };
// Exact cell key (unique while |cz| < 2^21 cells), so two cells never share a patch
const key = (cx: number, cz: number) => cx * 4194304 + cz;

function heightAt(g: Grid, cx: number, cz: number): number {
    const k = key(cx, cz);
    let h = g.heights.get(k);
    if (h === undefined) { h = terrainHeight((cx + 0.5) * g.size, (cz + 0.5) * g.size); g.heights.set(k, h); }
    return h;
}

function cellAt(g: Grid, cx: number, cz: number): Cell | null {
    const x = (cx + 0.5) * g.size, z = (cz + 0.5) * g.size;
    const q = road.query(x, z);
    const verge = q ? q.distance - ROAD_HALF_TOTAL : 99;
    if (verge < -0.75 * g.size) return null;              // fully on the road (a patch reaches 0.71 x size out)
    if (riverAmount(x, z) > 0.1) return null;
    const y = heightAt(g, cx, cz);
    if (y < WATER_LEVEL + 0.4) return null;
    // Thick on the verge and in the meadows, thinner where the ground breaks into patches
    const patchy = smoothstep(0.05, 0.55, noise2(x / 38, z / 38));
    const dense = verge < 9 ? 1 : 0.6 + patchy * 0.4;
    // Away from the road: right of the direction of travel is (tz, -tx)
    const nx = q ? q.tz * q.side : 0, nz = q ? -q.tx * q.side : 0;
    return {
        y: y - 0.03, sx: 0, sz: 0, sloped: false, nx, nz, verge: q ? verge : 99, dense,
        turn: Math.floor(hash2(cx, cz, 6 + g.size) * 8),
    };
}

/** Slope (height change per metre) from the neighbouring cells' heights, the first time a cell is near. */
function slope(g: Grid, c: Cell, cx: number, cz: number) {
    c.sx = (heightAt(g, cx + 1, cz) - heightAt(g, cx - 1, cz)) / (2 * g.size);
    c.sz = (heightAt(g, cx, cz + 1) - heightAt(g, cx, cz - 1)) / (2 * g.size);
    c.sloped = true;
}

// Patch turned by a quarter turn (cos, sin) per `turn & 3`, mirrored for turn >= 4
const TURN_C = [1, 0, -1, 0], TURN_S = [0, 1, 0, -1];

export function Grass() {
    const quality = useGameStore((s) => s.quality);
    const { grassRadius: radius, grassNear: near, grassMid: mid, grassFar: far } = GRAPHICS[quality];
    const camera = useThree((s) => s.camera);
    const meshes = useRef<(InstancedMesh | null)[]>([]);
    const last = useRef<ViewCone>({ x: Infinity, z: Infinity, fx: 0, fz: 0, all: true });

    const { geometries, materials, capacity } = useMemo(() => {
        // Room for the largest reach of any quality level (drone view keeps the whole circle)
        const area = (a: number, b: number, size: number) => Math.ceil(Math.PI * (b * b - a * a) * 1.05 / (size * size)) + 64;
        const levels = Object.values(GRAPHICS);
        // Maximise each complete annulus, not just the outer radius: lower settings can have
        // a larger coarse ring because their fine detail ends closer to the car.
        const capacity = [
            Math.max(...levels.map((g) => area(0, nearAssign(g.grassNear), 1))),
            Math.max(...levels.map((g) => area(nearAssign(g.grassNear) - 2, midAssign(g.grassMid), 1))),
            Math.max(...levels.map((g) => area(midAssign(g.grassMid) - 3, farAssign(g.grassFar), 2))),
            Math.max(...levels.map((g) => area(farAssign(g.grassFar) - 6, g.grassRadius + REBUILD, 4))),
        ];
        const geometries = LODS.map((l, i) => {
            const g = patch(l.blades, l.flowers, l.segs, l.size);
            const a = new InstancedBufferAttribute(new Float32Array(capacity[i] * 4), 4);
            a.setUsage(DynamicDrawUsage);
            g.setAttribute('aCell', a);
            return g;
        });
        // Each level fades towards the next one's density and width as it nears its outer edge
        const materials = LODS.map((l, i) => makeGrass({ fraction: l.keep, widen: l.widen, level: i }));
        return { geometries, materials, capacity };
    }, []);
    useEffect(() => { last.current = { x: Infinity, z: Infinity, fx: 0, fz: 0, all: true }; }, [radius, near, mid, far]);

    const m4 = useMemo(() => new Matrix4(), []);

    useFrame(() => {
        if (!radius) return;
        const px = playerPose.x, pz = playerPose.z;
        // The shader grows, thins and widens blades with the distance from the car, every frame
        grassUniforms.uCentre.value.set(px, pz);
        grassUniforms.uRadius.value = radius;
        grassUniforms.uNear.value = near;
        grassUniforms.uMid.value = mid;
        grassUniforms.uFar.value = far;
        if (!viewConeChanged(last.current, camera, px, pz, REBUILD)) return;
        const cone = last.current;
        // Gather a little past the fade radius: the car moves up to REBUILD m before the next rebuild
        const reach = radius + REBUILD;
        road.ensureZ(pz - reach, pz + reach);

        const counts = [0, 0, 0, 0];
        const nearA2 = nearAssign(near) ** 2, midA2 = midAssign(mid) ** 2;
        const cells = geometries.map((g) => g.getAttribute('aCell') as InstancedBufferAttribute);
        const gather = (g: Grid, inner2: number, outer: number) => {
            const r2 = outer * outer, S = g.size;
            const c0x = Math.floor((px - outer) / S), c1x = Math.floor((px + outer) / S);
            for (let cx = c0x; cx <= c1x; cx++) {
                // Only the cells inside the circle, column by column
                const ox = (cx + 0.5) * S - px;
                const half = Math.sqrt(Math.max(0, r2 - ox * ox));
                const c0z = Math.floor((pz - half) / S), c1z = Math.floor((pz + half) / S);
                for (let cz = c0z; cz <= c1z; cz++) {
                    const oz = (cz + 0.5) * S - pz;
                    const d2 = ox * ox + oz * oz;
                    if (d2 > r2 || d2 < inner2 || !inViewCone(cone, ox, oz, d2, KEEP_NEAR)) continue;
                    const k = key(cx, cz);
                    let c = g.cells.get(k);
                    if (c === undefined) { c = cellAt(g, cx, cz); g.cells.set(k, c); }
                    if (!c) continue;
                    const lod = S > 2 ? 3 : S > 1 ? 2 : d2 < nearA2 ? 0 : 1;
                    const mesh = meshes.current[lod];
                    const n = counts[lod];
                    if (!mesh || n >= capacity[lod]) continue;
                    // Every level follows the slope: a flat 4 m patch on a hillside would float or sink by half a metre.
                    // Heights are cached per grid, so a cell's slope costs its four neighbours' heights once
                    if (!c.sloped) slope(g, c, cx, cz);
                    // Quarter turn and mirror, then shear so the roots follow the slope and blades stay upright
                    const tc = TURN_C[c.turn & 3], ts = TURN_S[c.turn & 3], mir = c.turn >= 4 ? -1 : 1;
                    m4.set(
                        tc * mir, 0, ts, (cx + 0.5) * S,
                        mir * (c.sx * tc - c.sz * ts), 1, c.sx * ts + c.sz * tc, c.y,
                        -ts * mir, 0, tc, (cz + 0.5) * S,
                        0, 0, 0, 1,
                    );
                    mesh.setMatrixAt(n, m4);
                    cells[lod].setXYZW(n, c.nx, c.nz, c.verge, c.dense);
                    counts[lod] = n + 1;
                }
            }
        };
        // 1 m cells out to the mid level's edge, 2 m cells out to the far level's edge, 4 m cells beyond
        const fineReach = Math.min(reach, Math.sqrt(midA2));
        const coarseReach = Math.min(reach, farAssign(far));
        gather(FINE, 0, fineReach);
        if (coarseReach > fineReach) gather(COARSE, fineReach * fineReach, coarseReach);
        if (reach > coarseReach) gather(FARTHEST, coarseReach * coarseReach, reach);
        for (const g of [FINE, COARSE, FARTHEST]) if (g.cells.size > 150000) { g.cells.clear(); g.heights.clear(); }
        meshes.current.forEach((m, i) => {
            if (!m) return;
            m.count = counts[i];
            const n = Math.max(1, counts[i]);
            m.instanceMatrix.clearUpdateRanges();
            m.instanceMatrix.addUpdateRange(0, n * 16);
            m.instanceMatrix.needsUpdate = true;
            cells[i].clearUpdateRanges();
            cells[i].addUpdateRange(0, n * 4);
            cells[i].needsUpdate = true;
        });
    });

    if (!radius) return null;
    return (
        <group>
            {geometries.map((g, i) => (
                <instancedMesh
                    key={i}
                    ref={(m) => {
                        meshes.current[i] = m;
                        // Grass stays out of the AO pass: it would darken the sward into a dirty halo
                        if (m && !m.userData.ready) { m.count = 0; m.userData.ready = true; m.userData.noAO = true; }
                    }}
                    args={[g, materials[i], capacity[i]]}
                    receiveShadow
                    frustumCulled={false}
                />
            ))}
        </group>
    );
}

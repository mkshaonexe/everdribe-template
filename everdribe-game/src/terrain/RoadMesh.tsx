import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import {
    BufferGeometry,
    CanvasTexture,
    Float32BufferAttribute,
    MeshStandardMaterial,
    RepeatWrapping,
    SRGBColorSpace,
    LinearMipmapLinearFilter,
} from 'three';
import { useGameStore } from '../stores/gameStore';
import { GRAPHICS } from '../graphics/GraphicsProfile';
import { road, roadHeading, terrainHeight, ROAD_HALF_WIDTH, ROAD_HALF_TOTAL, ROAD_STEP } from '../world/WorldGen';

interface RoadMeshProps {
    centerIndex: number;   // road sample nearest the car
}

// ---- Layout ----
const SAMPLES_PER_SEGMENT = 50;   // 100 m per mesh: small meshes get culled cheaply
const VIEW_SAMPLES = 650;         // build the road this many samples (x 2 m) ahead and behind
const TILE_LENGTH = 18;           // metres of road one texture tile covers (two dash cycles of 9 m)
const SKIRT_DEPTH = 1.6;          // deck edge that shows on bridges and embankments

// Vertex offsets across the road and how far each sits above the road base.
// The asphalt has a slight crown; the shoulder falls away towards the grass.
const CROSS_OFFSETS = [-1, -0.8125, -0.625, -0.3125, 0, 0.3125, 0.625, 0.8125, 1]; // x halfTotal
const CROSS_HEIGHTS = [-0.08, -0.03, 0.0, 0.015, 0.03, 0.015, 0.0, -0.03, -0.08];
const ROAD_LIFT = 0.04;

// ---- Small deterministic noise helpers (no Math.random, so rebuilds look identical) ----
const hash = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
};
const valueNoise = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash(i) * (1 - u) + hash(i + 1) * u;
};
const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/**
 * One tile of road, drawn once: asphalt grain and stones, polished wheel tracks, dust at the edges,
 * worn lane markings, and a gravel shoulder whose outer edge is ragged (alpha cut-out) so it melts into
 * the grass. The tile repeats along the road; what must not repeat is added by `roadVariation`.
 */
let roadTextureCache: CanvasTexture | null = null;
function createRoadTexture(halfWidth: number, halfTotal: number): CanvasTexture {
    if (roadTextureCache) return roadTextureCache;

    const total = halfTotal * 2;
    const W = 1024;
    const H = Math.round((W / total) * TILE_LENGTH); // square texels
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(W, H);
    const data = image.data;

    // Deterministic pseudo random from pixel coordinates
    const rnd = (x: number, y: number, k: number) => hash(x * 12.9898 + y * 78.233 + k * 37.719);

    // Tileable low frequency mottling: sums of sines with whole wave counts across the tile
    const mottle = (mx: number, my: number) => {
        const a = Math.sin(2 * Math.PI * (3 * mx + 2 * my) + 1.3);
        const b = Math.sin(2 * Math.PI * (5 * mx - 4 * my) + 4.1);
        const c = Math.sin(2 * Math.PI * (9 * mx + 7 * my) + 2.2);
        const d = Math.sin(2 * Math.PI * (17 * mx - 13 * my) + 0.4);
        return a * 0.4 + b * 0.3 + c * 0.2 + d * 0.1; // roughly -1..1
    };

    const laneCenter = halfWidth / 2;
    const markHalf = 0.075;           // lines are 15 cm wide
    const edgeLineAt = halfWidth - 0.45;
    const dashLen = 3;                // metres
    const dashCycle = TILE_LENGTH / 2;

    for (let py = 0; py < H; py++) {
        const along = (py / H) * TILE_LENGTH;
        for (let px = 0; px < W; px++) {
            const x = (px / W) * total - halfTotal;  // metres across the road
            const ax = Math.abs(x);
            const mx = px / W;
            const my = py / H;
            const i = (py * W + px) * 4;
            const m = mottle(mx, my);

            let r: number, g: number, b: number, a = 255;

            if (ax <= halfWidth) {
                // ---- Asphalt ----
                let base = 92 + m * 7; // dark warm grey
                const grain = (rnd(px, py, 1) - 0.5) * 20;
                base += grain;
                // Pale stones in the surface
                const stone = rnd(px, py, 2);
                if (stone > 0.985) base += 38 + rnd(px, py, 3) * 28;
                else if (stone < 0.01) base -= 22;

                // Polished wheel tracks either side of each lane's centre, dusty ridge in between
                const lane = Math.abs(ax - laneCenter);
                const track = Math.exp(-Math.pow((lane - 0.85) / 0.35, 2));
                base -= track * 9;
                base += Math.exp(-Math.pow(lane / 0.5, 2)) * 5;

                // Dust and loose grit gather near the edge
                base += smooth(halfWidth - 1.1, halfWidth, ax) * 14;

                r = base + 2;
                g = base + 1;
                b = base + 4;

                // ---- Lane markings ----
                const onEdgeLine = Math.abs(ax - edgeLineAt) < markHalf;
                const onCentreDash = ax < markHalf && (along % dashCycle) < dashLen;
                if (onEdgeLine || onCentreDash) {
                    // Paint is chipped and faded unevenly
                    const wear = 0.55 + 0.4 * (0.5 + 0.5 * mottle(mx * 1.7 + 0.2, my * 3.1)) - rnd(px, py, 4) * 0.35;
                    const paint = 236 * Math.max(0.25, Math.min(1, wear));
                    const blend = Math.max(0, Math.min(1, wear * 1.15));
                    r = r + (paint - r) * blend;
                    g = g + (paint - 2 - g) * blend;
                    b = b + (paint - 12 - b) * blend;
                }
            } else {
                // ---- Gravel shoulder ----
                const t = (ax - halfWidth) / (halfTotal - halfWidth); // 0 at asphalt .. 1 at outer edge
                let base = 128 + m * 12 + (rnd(px, py, 5) - 0.5) * 34;
                if (rnd(px, py, 6) > 0.97) base += 34;
                r = base + 6;
                g = base + 1;
                b = base - 14;
                // Tufts of grass and soil creeping in
                const green = smooth(0.35, 1, t) * (0.55 + 0.45 * mottle(mx * 2.3, my * 1.1));
                r += (96 - r) * green * 0.8;
                g += (112 - g) * green * 0.8;
                b += (62 - b) * green * 0.8;
                // Ragged outer edge: alpha is cut where noise exceeds the fade
                const ragged = rnd(px, py, 7) * 0.6 + 0.4 * (0.5 + 0.5 * mottle(mx * 3 + 0.5, my * 5));
                a = ragged > smooth(0.55, 1, t) ? 255 : 0;
            }

            data[i] = Math.max(0, Math.min(255, r));
            data[i + 1] = Math.max(0, Math.min(255, g));
            data[i + 2] = Math.max(0, Math.min(255, b));
            data[i + 3] = a;
        }
    }
    ctx.putImageData(image, 0, 0);

    // Cracks, patches and stains are not drawn here: drawn once per tile, they came back every 18 m and
    // gave the road away as a repeated picture. The material adds them in world space (roadVariation).

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    roadTextureCache = tex;
    return tex;
}

/**
 * Wear that never repeats, added to the road material in world space (along the road and across it, in
 * metres), on top of the repeating tile:
 * - resurfaced sections: lane-wide rectangles of slightly darker or paler asphalt, 6-30 m long;
 * - oil and rubber down the middle of each lane, dust and grit drifting in from the edges.
 * Runs after three's map_fragment (colour); `vMapUv` carries the road coordinates (u across 0..1, v along in tiles).
 */
function roadVariation(shader: { fragmentShader: string }, halfWidth: number, halfTotal: number) {
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
            float rh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
            float rn(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(mix(rh(i), rh(i + vec2(1.0, 0.0)), u.x), mix(rh(i + vec2(0.0, 1.0)), rh(i + vec2(1.0, 1.0)), u.x), u.y);
            }
`)
        .replace('#include <map_fragment>', `#include <map_fragment>
            {
                float across = (vMapUv.x - 0.5) * ${(halfTotal * 2).toFixed(3)};
                float along = vMapUv.y * ${TILE_LENGTH.toFixed(1)};
                float ax = abs(across);
                float asphalt = 1.0 - smoothstep(${(halfWidth - 0.15).toFixed(3)}, ${halfWidth.toFixed(3)}, ax);
                // Resurfaced sections, one lane wide, soft-edged
                float lane = step(0.0, across);
                float sec = floor(along / 23.0);
                float pick = rh(vec2(sec, lane + 3.0));
                float start = rh(vec2(sec, lane + 7.0)) * 10.0, len = 6.0 + rh(vec2(sec, lane + 11.0)) * 24.0;
                float inSec = smoothstep(0.0, 0.25, along - sec * 23.0 - start) * smoothstep(0.0, 0.25, sec * 23.0 + start + len - along);
                float inLane = smoothstep(0.05, 0.25, ax) * (1.0 - smoothstep(${(halfWidth - 0.6).toFixed(3)}, ${(halfWidth - 0.35).toFixed(3)}, ax));
                float patchMask = step(0.8, pick) * inSec * inLane * asphalt;
                diffuseColor.rgb *= mix(1.0, pick > 0.9 ? 1.04 : 0.92, patchMask);
                // No crack or tar-seal lines (v0.12.0): long dark squiggles all over the lanes read as random
                // scribbles, and their distance fade made them appear and vanish as the car moved. A kept
                // road is plain asphalt with soft tonal wear, like the references.
                // Oil and rubber down the middle of each lane, in blotches
                float mid = exp(-pow((ax - ${(halfWidth / 2).toFixed(3)}) / 0.45, 2.0));
                diffuseColor.rgb *= 1.0 - mid * smoothstep(0.45, 0.8, rn(vec2(across * 1.5, along * 0.4))) * 0.12 * asphalt;
                // Dust and grit blown in from the verge, uneven along the road
                float dust = smoothstep(${(halfWidth - 1.4).toFixed(3)}, ${halfWidth.toFixed(3)}, ax) * smoothstep(0.35, 0.75, rn(vec2(along / 9.0, ax)));
                diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.1, 0.98), dust * asphalt * 0.6);
                // Slow brightness drift over tens of metres
                diffuseColor.rgb *= 0.95 + 0.1 * rn(vec2(along / 31.0, across / 6.0 + 1.7));
            }`);
}

/** Brightness and tint for one row of road: slow wear, medium mottling, and the odd repair strip. */
function rowShade(dist: number): [number, number, number] {
    let b = 1 + 0.2 * (valueNoise(dist / 85) - 0.5) * 2 + 0.07 * (valueNoise(dist / 11 + 50) - 0.5) * 2;

    const cell = Math.floor(dist / 17);
    const into = dist - cell * 17;
    if (hash(cell * 3.7 + 1) > 0.84) {
        const edge = smooth(0, 1.5, into) * smooth(0, 1.5, 17 - into);
        const repair = hash(cell * 1.9 + 3) > 0.5 ? 0.9 : 1.09; // fresh dark patch or sun-bleached one
        b *= 1 + (repair - 1) * edge;
    }
    const warm = (valueNoise(dist / 140 + 9) - 0.5) * 0.06;
    return [b * (1 + warm), b, b * (1 - warm)];
}


/**
 * One 100 m piece of road, built from road samples [k*50, k*50+50]. The road is a pure function of
 * its sample index, so a piece looks the same whenever it is rebuilt and always meets its neighbours.
 * Besides the top surface it has short vertical sides (visible on bridges and embankments) and,
 * where the land falls away under it, concrete pillars.
 */
function buildSegment(k: number, halfWidth: number, halfTotal: number): BufferGeometry {
    const i0 = k * SAMPLES_PER_SEGMENT;
    const i1 = i0 + SAMPLES_PER_SEGMENT;
    road.ensure(i0 - 1, i1 + 1);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const columns = CROSS_OFFSETS.length;

    // Rows every metre (half a sample), interpolated along the road
    const rows = SAMPLES_PER_SEGMENT * 2;
    const edge: { x: number; y: number; z: number; rx: number; rz: number }[] = [];
    for (let r = 0; r <= rows; r++) {
        const s = (i0 + r / 2) * ROAD_STEP;
        const p = road.at(s);
        const h = roadHeading(s);
        const tx = Math.sin(h), tz = Math.cos(h);
        const rx = tz, rz = -tx; // right of the direction of travel
        const [sr, sg, sb] = rowShade(s);
        const v = s / TILE_LENGTH;
        edge.push({ x: p.x, y: p.y, z: p.z, rx, rz });

        for (let c = 0; c < columns; c++) {
            const lateral = CROSS_OFFSETS[c] * halfTotal;
            positions.push(p.x + rx * lateral, p.y + ROAD_LIFT + CROSS_HEIGHTS[c], p.z + rz * lateral);
            normals.push(0, 1, 0);
            uvs.push(CROSS_OFFSETS[c] * 0.5 + 0.5, v);
            const isShoulder = Math.abs(CROSS_OFFSETS[c]) * halfTotal > halfWidth;
            const jitter = 1 + (hash(s * 0.37 + c * 11.3) - 0.5) * 0.05;
            const dull = isShoulder ? 0.92 : 1;
            colors.push(sr * jitter * dull, sg * jitter * dull, sb * jitter * dull);
        }
        if (r < rows) {
            const base = r * columns;
            for (let c = 0; c < columns - 1; c++) {
                const a = base + c, b = base + c + 1, a2 = base + columns + c, b2 = base + columns + c + 1;
                indices.push(a, a2, b, b, a2, b2);
            }
        }
    }

    // Deck sides: a strip down from each outer edge, dark concrete
    const side = (sign: number) => {
        const start = positions.length / 3;
        for (const e of edge) {
            const ex = e.x + e.rx * halfTotal * sign, ez = e.z + e.rz * halfTotal * sign;
            const top = e.y + ROAD_LIFT + CROSS_HEIGHTS[sign > 0 ? columns - 1 : 0];
            positions.push(ex, top, ez, ex, top - SKIRT_DEPTH, ez);
            normals.push(e.rx * sign, 0, e.rz * sign, e.rx * sign, 0, e.rz * sign);
            uvs.push(sign > 0 ? 1 : 0, 0, sign > 0 ? 1 : 0, 0);
            colors.push(0.42, 0.41, 0.4, 0.3, 0.3, 0.3);
        }
        for (let r = 0; r < edge.length - 1; r++) {
            const a = start + r * 2, b = a + 1, c = a + 2, d = a + 3;
            if (sign > 0) indices.push(a, b, c, c, b, d); else indices.push(a, c, b, c, d, b);
        }
    };
    side(1);
    side(-1);

    // Pillars every 12 m where the ground is more than 2 m below the deck
    for (let r = 0; r <= rows; r += 24) {
        const e = edge[r];
        const groundUnder = terrainHeight(e.x, e.z);
        if (e.y - groundUnder < 2.5) continue;
        for (const sign of [-0.6, 0.6]) {
            const cx = e.x + e.rx * halfWidth * sign, cz = e.z + e.rz * halfWidth * sign;
            const bottom = groundUnder - 1.5;
            const w = 0.7;
            const start = positions.length / 3;
            // Four faces of a square column (no caps needed)
            const corners = [[-w, -w], [w, -w], [w, w], [-w, w]];
            for (let f = 0; f < 4; f++) {
                const [ax, az] = corners[f];
                const [bx, bz] = corners[(f + 1) % 4];
                const nx = (ax + bx) / 2, nz = (az + bz) / 2;
                const nl = Math.hypot(nx, nz);
                for (const [px, pz] of [[ax, az], [bx, bz]]) {
                    positions.push(cx + px, e.y - SKIRT_DEPTH, cz + pz, cx + px, bottom, cz + pz);
                    normals.push(nx / nl, 0, nz / nl, nx / nl, 0, nz / nl);
                    uvs.push(0, 0, 0, 0);
                    colors.push(0.5, 0.49, 0.47, 0.36, 0.35, 0.34);
                }
                const a = start + f * 4;
                indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
            }
        }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
}

const segmentCache = new Map<number, BufferGeometry>();

export const RoadMesh = ({ centerIndex }: RoadMeshProps) => {
    const halfWidth = ROAD_HALF_WIDTH;
    const halfTotal = ROAD_HALF_TOTAL;
    const gl = useThree((s) => s.gl);

    const texture = useMemo(() => {
        const tex = createRoadTexture(halfWidth, halfTotal);
        tex.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        return tex;
    }, [halfWidth, halfTotal, gl]);

    const msaa = GRAPHICS[useGameStore((s) => s.quality)].msaa > 0;
    const material = useMemo(() => {
        const m = new MeshStandardMaterial({
            map: texture,
            // The same tile as a height map: stones and grain catch the sun, paint sits slightly proud
            bumpMap: texture,
            bumpScale: 1.4,
            vertexColors: true,
            roughness: 0.86,
            metalness: 0,
            envMapIntensity: 0.2,  // little sky reflection: otherwise every shadow on the road turns blue-purple
            alphaTest: 0.4,       // the ragged gravel edge is cut out, not blended
            alphaToCoverage: msaa, // with MSAA the cut-out edge is feathered instead of stair-stepped
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        m.onBeforeCompile = (shader) => roadVariation(shader, halfWidth, halfTotal);
        m.customProgramCacheKey = () => `everdribe-road-${msaa ? 1 : 0}`;
        return m;
    }, [texture, msaa, halfWidth, halfTotal]);

    // Only rebuild the visible list when the car moves into another 100 m piece
    const kCenter = Math.floor(centerIndex / SAMPLES_PER_SEGMENT);
    const segments = useMemo(() => {
        const span = Math.ceil(VIEW_SAMPLES / SAMPLES_PER_SEGMENT);
        const list: { k: number; geo: BufferGeometry }[] = [];
        for (let k = kCenter - span; k <= kCenter + span; k++) {
            let geo = segmentCache.get(k);
            if (!geo) {
                geo = buildSegment(k, halfWidth, halfTotal);
                segmentCache.set(k, geo);
            }
            list.push({ k, geo });
        }
        // Forget pieces far behind or ahead
        for (const [k, geo] of segmentCache) {
            if (Math.abs(k - kCenter) > span + 3) {
                geo.dispose();
                segmentCache.delete(k);
            }
        }
        return list;
    }, [kCenter, halfWidth, halfTotal]);

    useEffect(() => () => material.dispose(), [material]);

    return (
        <group>
            {segments.map(({ k, geo }) => (
                <mesh key={k} geometry={geo} material={material} renderOrder={10} receiveShadow />
            ))}
        </group>
    );
};

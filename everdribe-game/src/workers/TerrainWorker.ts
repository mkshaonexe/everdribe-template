/**
 * Terrain Worker - builds one terrain chunk off the main thread from the shared world functions.
 *
 * The chunk is a (res + 2)² grid: the inner res² vertices cover the chunk, the outer ring repeats the
 * edge vertices 8 m lower. That "skirt" hides the cracks where a detailed chunk meets a coarser one.
 */
import {
    terrainHeight, road, riverAmount, hilliness, forestAmount, noise2, smoothstep, WATER_LEVEL, ROAD_HALF_TOTAL,
} from '../world/WorldGen';
import type { TerrainWorkerInput, TerrainWorkerOutput, TerrainWorkerError } from './workerTypes';

const SKIRT_DROP = 8;

function generate(input: TerrainWorkerInput): TerrainWorkerOutput {
    const { chunkX, chunkZ, resolution: res, chunkSize } = input;
    const half = chunkSize / 2;
    const step = chunkSize / (res - 1);
    road.ensureZ(chunkZ - half - 50, chunkZ + half + 50);

    // Heights on the inner grid plus one extra ring for normals
    const n = res + 2;
    const hgrid = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
            const wx = chunkX - half + (ix - 1) * step;
            const wz = chunkZ - half + (iz - 1) * step;
            hgrid[iz * n + ix] = terrainHeight(wx, wz);
        }
    }

    const count = n * n; // output grid is also (res + 2)², with the outer ring as skirt
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const splat = new Float32Array(count * 4); // grass, dirt, rock, riverbed

    for (let oz = 0; oz < n; oz++) {
        for (let ox = 0; ox < n; ox++) {
            const o = oz * n + ox;
            const skirt = ox === 0 || oz === 0 || ox === n - 1 || oz === n - 1;
            // Inner grid index (1..res in hgrid), clamped for the skirt ring
            const gx = Math.min(res, Math.max(1, ox));
            const gz = Math.min(res, Math.max(1, oz));
            const lx = -half + (gx - 1) * step;
            const lz = -half + (gz - 1) * step;
            const wx = chunkX + lx, wz = chunkZ + lz;
            const h = hgrid[gz * n + gx];

            positions[o * 3] = lx;
            positions[o * 3 + 1] = skirt ? h - SKIRT_DROP : h;
            positions[o * 3 + 2] = lz;

            // Normal from central differences
            const hl = hgrid[gz * n + gx - 1], hr = hgrid[gz * n + gx + 1];
            const hd = hgrid[(gz - 1) * n + gx], hu = hgrid[(gz + 1) * n + gx];
            let nx = hl - hr, ny = 2 * step, nz = hd - hu;
            const len = Math.hypot(nx, ny, nz);
            nx /= len; ny /= len; nz /= len;
            normals[o * 3] = nx; normals[o * 3 + 1] = ny; normals[o * 3 + 2] = nz;

            // ---- What the ground is made of ----
            const slope = 1 - ny;
            let rock = smoothstep(0.28, 0.5, slope) + smoothstep(55, 90, h);
            const wet = smoothstep(WATER_LEVEL + 2.8, WATER_LEVEL + 0.6, h) + riverAmount(wx, wz) * 0.6;
            const patches = noise2(wx / 45 + 3, wz / 45 - 8) * 0.7 + noise2(wx / 9, wz / 9) * 0.3;
            let dirt = smoothstep(0.45, 0.8, patches) * 0.8;
            const q = road.query(wx, wz);
            // A narrow strip of bare soil right at the shoulder; the grass tufts grow over the rest of the verge
            // (it was 3.5 m of solid dirt, which read as a brown painted band beside the road)
            if (q) dirt = Math.max(dirt, smoothstep(ROAD_HALF_TOTAL + 1.4, ROAD_HALF_TOTAL - 0.3, q.distance) * 0.6);
            rock = Math.min(1, rock);
            const sand = Math.min(1, wet);
            dirt = Math.min(1, dirt) * (1 - rock) * (1 - sand);
            const grass = Math.max(0, 1 - rock - sand - dirt);
            const total = grass + dirt + rock + sand || 1;
            splat[o * 4] = grass / total;
            splat[o * 4 + 1] = dirt / total;
            splat[o * 4 + 2] = rock / total;
            splat[o * 4 + 3] = sand / total;

            // ---- Tint: lush valleys, dry hill tops, sun patches, snow on the peaks ----
            const region = noise2(wx / 900, wz / 900);
            const patch = noise2(wx / 120 + 50, wz / 120 - 30);
            const dry = smoothstep(0.1, 0.8, region) * 0.6 + hilliness(wx, wz) * smoothstep(8, 30, h) * 0.4;
            let r = 0.92 + dry * 0.32 + patch * 0.05;
            let g = 1.0 + dry * 0.08 + patch * 0.06;
            let b = 0.9 - dry * 0.25;
            // Woods: the ground under trees is in their shade and covered in old leaves, darker and deeper green.
            // Seen from afar it also reads as the canopy's colour between the far trees (v0.15.0), so a wooded
            // hillside looks wooded without drawing every tree on it. Not on bare rock or snow
            const wood = forestAmount(wx, wz) * (1 - rock) * 0.75;
            r *= 1 - wood * 0.42; g *= 1 - wood * 0.3; b *= 1 - wood * 0.4;
            const snow = smoothstep(85, 115, h) * smoothstep(0.55, 0.3, slope);
            r += (1.9 - r) * snow; g += (1.9 - g) * snow; b += (2.0 - b) * snow;   // bright, but texture still shows
            colors[o * 3] = r; colors[o * 3 + 1] = g; colors[o * 3 + 2] = b;
        }
    }

    return { type: 'TERRAIN_RESULT', chunkX, chunkZ, resolution: res, positions, normals, colors, splat };
}

self.onmessage = (event: MessageEvent<TerrainWorkerInput>) => {
    const input = event.data;
    try {
        const result = generate(input);
        (self as unknown as Worker).postMessage(result, [
            result.positions.buffer, result.normals.buffer, result.colors.buffer, result.splat.buffer,
        ]);
    } catch (error) {
        const err: TerrainWorkerError = {
            type: 'TERRAIN_ERROR',
            chunkX: input.chunkX,
            chunkZ: input.chunkZ,
            resolution: input.resolution,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
        self.postMessage(err);
    }
};

export { };

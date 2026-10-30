import { useRef, useState, startTransition, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { TerrainChunk } from '../terrain/TerrainChunk';
import { RoadMesh } from '../terrain/RoadMesh';
import { Scenery } from '../world/Scenery';
import { Grass } from '../world/Grass';
import { Water } from '../world/Water';
import { road, ROAD_STEP } from '../world/WorldGen';
import { CHUNK_SIZE } from '../utils/constants';
import { playerPose, useGameStore } from '../stores/gameStore';
import type { Quality } from '../stores/gameStore';

interface Chunk { key: string; x: number; z: number; res: number }

// Chunks closer than these distances (metres, to the chunk centre) get more vertices
const LOD_RINGS: [number, number][] = [[320, 97], [680, 49], [Infinity, 25]];
// Typed by Quality so a new level cannot be forgotten (Ultra had no entry in v0.7.0 and loaded no ground)
const VIEW_RADIUS: Record<Quality, number> = { low: 800, medium: 1000, high: 1200, ultra: 1200 };

function chunksAround(px: number, pz: number, radius: number): Chunk[] {
    const out: Chunk[] = [];
    const cx = Math.floor(px / CHUNK_SIZE + 0.5), cz = Math.floor(pz / CHUNK_SIZE + 0.5);
    const n = Math.ceil(radius / CHUNK_SIZE) + 1;
    for (let dx = -n; dx <= n; dx++) {
        for (let dz = -n; dz <= n; dz++) {
            const x = (cx + dx) * CHUNK_SIZE, z = (cz + dz) * CHUNK_SIZE;
            // Distance from the car to the nearest point of the chunk
            const ex = Math.max(0, Math.abs(x - px) - CHUNK_SIZE / 2);
            const ez = Math.max(0, Math.abs(z - pz) - CHUNK_SIZE / 2);
            const d = Math.hypot(ex, ez);
            if (d > radius) continue;
            const res = LOD_RINGS.find(([r]) => d < r)![1];
            out.push({ key: `${x}_${z}`, x, z, res });
        }
    }
    return out;
}

/**
 * Everything around the car that streams in and out as it drives: terrain chunks (detailed near the
 * car, coarse far away), the road, scenery and water. All of it comes from the deterministic world in
 * WorldGen, so driving away and coming back shows exactly the same place.
 */
export function DynamicWorld() {
    const quality = useGameStore((s) => s.quality);
    const [chunks, setChunks] = useState<Chunk[]>(() => chunksAround(playerPose.x, playerPose.z, VIEW_RADIUS[quality]));
    const [centerIndex, setCenterIndex] = useState(0);
    const signature = useRef('');
    const frame = useRef(0);
    const lastMapUpdate = useRef(0);

    useFrame(() => {
        if (frame.current++ % 6 !== 0) return;
        const px = playerPose.x, pz = playerPose.z;

        const list = chunksAround(px, pz, VIEW_RADIUS[quality]);
        const sig = list.map((c) => c.key + ':' + c.res).join('|');
        if (sig !== signature.current) {
            signature.current = sig;
            startTransition(() => setChunks(list));
        }

        const ci = road.nearestIndex(px, pz);
        if (Math.floor(ci / 50) !== Math.floor(centerIndex / 50)) startTransition(() => setCenterIndex(ci));

        // Road around the car for the minimap, once a second
        const now = performance.now();
        if (now - lastMapUpdate.current > 1000) {
            lastMapUpdate.current = now;
            const pts: Vector3[] = [];
            for (let i = ci - 600; i <= ci + 600; i += 5) {
                const p = road.at(i * ROAD_STEP);
                pts.push(new Vector3(p.x, p.y, p.z));
            }
            useGameStore.getState().setRoadPath(pts);
        }
    });

    return (
        <group>
            {chunks.map((c) => (
                <TerrainChunk key={c.key} x={c.x} z={c.z} resolution={c.res} />
            ))}
            <RoadMesh centerIndex={centerIndex} />
            <Water />
            <Suspense fallback={null}>
                <Scenery />
                <Grass />
            </Suspense>
        </group>
    );
}

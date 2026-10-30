import { useEffect, useMemo, useState } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import { CHUNK_SIZE } from '../utils/constants';
import { getTerrainMaterial } from './TerrainMaterial';
import type { TerrainWorkerInput, TerrainWorkerResponse } from '../workers/workerTypes';

interface TerrainChunkProps {
    x: number;           // world centre
    z: number;
    resolution: number;  // vertices per edge; lower for chunks further away
}

// A small pool of workers so a burst of chunks (startup, LOD change) builds in parallel
const WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const workers: Worker[] = [];
let nextWorker = 0;
const pending = new Map<string, (data: TerrainWorkerResponse) => void>();

function getWorker(): Worker {
    if (workers.length < WORKER_COUNT) {
        const w = new Worker(new URL('../workers/TerrainWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
            const d = event.data;
            const key = `${d.chunkX}_${d.chunkZ}_${d.resolution}`;
            pending.get(key)?.(d);
            pending.delete(key);
        };
        workers.push(w);
    }
    const w = workers[nextWorker % workers.length];
    nextWorker++;
    return w;
}

/** How many chunks are still waiting for their worker, for the loading screen. */
export function terrainChunksPending(): number {
    return pending.size;
}

// Index buffers depend only on the resolution, so share them
const indexCache = new Map<number, BufferAttribute>();
function gridIndex(n: number): BufferAttribute {
    let idx = indexCache.get(n);
    if (idx) return idx;
    const arr = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let z = 0; z < n - 1; z++) {
        for (let x = 0; x < n - 1; x++) {
            const a = z * n + x, b = a + 1, c = a + n, d = c + 1;
            arr[k++] = a; arr[k++] = c; arr[k++] = b;
            arr[k++] = b; arr[k++] = c; arr[k++] = d;
        }
    }
    idx = new BufferAttribute(arr, 1);
    indexCache.set(n, idx);
    return idx;
}

export function TerrainChunk({ x, z, resolution }: TerrainChunkProps) {
    const geometry = useMemo(() => new BufferGeometry(), []);
    const material = getTerrainMaterial();
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const key = `${x}_${z}_${resolution}`;
        pending.set(key, (res) => {
            if (res.type === 'TERRAIN_ERROR') {
                console.warn('Terrain worker error:', res.error);
                return;
            }
            geometry.setAttribute('position', new BufferAttribute(res.positions, 3));
            geometry.setAttribute('normal', new BufferAttribute(res.normals, 3));
            geometry.setAttribute('color', new BufferAttribute(res.colors, 3));
            geometry.setAttribute('splat', new BufferAttribute(res.splat, 4));
            geometry.setIndex(gridIndex(resolution + 2));
            geometry.computeBoundingSphere();
            geometry.computeBoundingBox();
            setReady(true);
        });
        const input: TerrainWorkerInput = { type: 'GENERATE_TERRAIN', chunkX: x, chunkZ: z, resolution, chunkSize: CHUNK_SIZE };
        getWorker().postMessage(input);
        return () => { pending.delete(key); };
    }, [x, z, resolution, geometry]);

    useEffect(() => () => geometry.dispose(), [geometry]);

    if (!ready) return null;
    return (
        <mesh position={[x, 0, z]} geometry={geometry} material={material} receiveShadow frustumCulled />
    );
}

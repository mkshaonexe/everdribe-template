/**
 * Worker Types - shared interfaces for Web Worker communication
 */

export interface TerrainWorkerInput {
    type: 'GENERATE_TERRAIN';
    chunkX: number;       // world centre of the chunk
    chunkZ: number;
    resolution: number;   // vertices per edge, not counting the skirt ring
    chunkSize: number;
}

export interface TerrainWorkerOutput {
    type: 'TERRAIN_RESULT';
    chunkX: number;
    chunkZ: number;
    resolution: number;
    positions: Float32Array;  // (resolution + 2)² vertices, chunk-local
    normals: Float32Array;
    colors: Float32Array;     // tint
    splat: Float32Array;      // grass, dirt, rock, riverbed weights
}

export interface TerrainWorkerError {
    type: 'TERRAIN_ERROR';
    chunkX: number;
    chunkZ: number;
    resolution: number;
    error: string;
}

export type TerrainWorkerResponse = TerrainWorkerOutput | TerrainWorkerError;

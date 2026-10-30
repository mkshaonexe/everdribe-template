import { ACESFilmicToneMapping } from 'three';
import type { ToneMapping } from 'three';
import type { Quality } from '../stores/gameStore';

/**
 * Everything a quality level changes, in one table. Components read their numbers from here instead
 * of keeping their own `quality === 'ultra' ? …` switches, so a level can be tuned in one place.
 * See docs/GRAPHICS-ARCHITECTURE.md for what each field does to the picture and what it costs.
 */
export interface GraphicsProfile {
    /**
     * Render resolution as a share of the screen's pixels (min, max). Scene.tsx starts at the screen's
     * own ratio inside this range and moves within it to hold the frame rate (adaptive resolution).
     */
    dpr: [number, number];
    /**
     * MSAA samples on the scene render target (0 = off). Smooths geometry edges such as guardrails.
     * 2, not 4, on High and Ultra (v0.11.0): on the M4, 4× on the half-float target alone took Ultra from
     * 60 to 50 FPS with every second frame late (p95 33 ms); 2× holds 60 and SMAA cleans up after it.
     */
    msaa: 0 | 2 | 4;
    /** Ground-contact shading (GTAO) under the car, trees and rails. */
    ao: boolean;
    aoSamples: number;
    /** Soft glow around the sun and bright highlights. */
    bloom: boolean;
    /**
     * Sun shadows, cascaded (graphics/SunShadows.tsx): how many maps, the size of each, and how far from
     * the camera shadows reach (m). The first cascade is small and sharp around the car.
     */
    shadows: boolean;
    shadowCascades: number;
    shadowMapSize: number;
    shadowFar: number;
    /**
     * Scenery drawn within this radius (m); full-detail models inside detailRadius. Trees use their light
     * version out to lightRadius, then their far version (a few big leaf cards) out to treeRadius
     * (the owner-selected 460 m budget). Far trees shrink into the ground over the last 60–80 m.
     */
    sceneryRadius: number;
    detailRadius: number;
    lightRadius: number;
    treeRadius: number;
    /** Grass drawn within this radius of the car (m); 0 = none. */
    grassRadius: number;
    /**
     * Grass detail (world/Grass.tsx): every blade of the sward within grassNear (m), two in five (a little
     * wider) out to grassMid, one in eight (wider still) out to grassFar, then 4 m patches of wide blades out
     * to grassRadius. Each step thins out smoothly; the last tier continues thinning towards 120 m.
     */
    grassNear: number;
    grassMid: number;
    grassFar: number;
    /** Leaves sway, and get light through them when the sun is behind. */
    foliageMotion: boolean;
    /** Texture sharpness at grazing angles (road, ground, car). */
    anisotropy: number;
    /** Noise layers in the sky's clouds: more layers, finer edges. 4 and up also light them from the sun's side. */
    cloudOctaves: number;
}

export const GRAPHICS: Record<Quality, GraphicsProfile> = {
    // Each level adds on top of the one before, so every step up looks better and costs more:
    // Fast: one shadow map near the car, grass close by · Balanced: + glow, more grass, swaying leaves, two shadow maps ·
    // Beautiful: + smooth edges (2× MSAA), contact shading (AO), sharp 3-step shadows, more trees and grass ·
    // Ultra: + finer AO, everything drawn further, sharpest textures and clouds, highest resolution ceiling.
    low: {
        dpr: [0.75, 1], msaa: 0, ao: false, aoSamples: 0, bloom: false,
        // Trees cast from their light version (Scenery), so one small map near the car costs little
        shadows: true, shadowCascades: 1, shadowMapSize: 1024, shadowFar: 45,
        sceneryRadius: 300, detailRadius: 90, lightRadius: 200, treeRadius: 460, grassRadius: 120, grassNear: 5, grassMid: 12, grassFar: 30,
        foliageMotion: false, anisotropy: 4, cloudOctaves: 3,
    },
    medium: {
        dpr: [0.85, 1.25], msaa: 0, ao: false, aoSamples: 0, bloom: true,
        shadows: true, shadowCascades: 2, shadowMapSize: 1024, shadowFar: 100,
        sceneryRadius: 380, detailRadius: 130, lightRadius: 250, treeRadius: 460, grassRadius: 120, grassNear: 7, grassMid: 18, grassFar: 40,
        foliageMotion: true, anisotropy: 8, cloudOctaves: 4,
    },
    high: {
        dpr: [0.85, 1.75], msaa: 2, ao: true, aoSamples: 12, bloom: true,
        shadows: true, shadowCascades: 3, shadowMapSize: 2048, shadowFar: 140,
        sceneryRadius: 460, detailRadius: 170, lightRadius: 300, treeRadius: 460, grassRadius: 120, grassNear: 9, grassMid: 24, grassFar: 60,
        foliageMotion: true, anisotropy: 12, cloudOctaves: 5,
    },
    ultra: {
        dpr: [0.85, 2], msaa: 2, ao: true, aoSamples: 16, bloom: true,
        shadows: true, shadowCascades: 3, shadowMapSize: 2048, shadowFar: 170,
        sceneryRadius: 520, detailRadius: 200, lightRadius: 320, treeRadius: 460, grassRadius: 120, grassNear: 11, grassMid: 30, grassFar: 60,
        foliageMotion: true, anisotropy: 16, cloudOctaves: 6,
    },
};

/**
 * Tone mapping turns the scene's real light levels into screen colours. Back-tested side by side on the
 * same frame (v0.8.0): AgX made the greens grey and the sky milky; ACES and Neutral looked alike, and
 * ACES rolls the sun and sky highlights off more gently, so ACES it is.
 */
export const TONE_MAPPING: ToneMapping = ACESFilmicToneMapping;

/** Final colour grade, applied after tone mapping (display colours). */
export const GRADE = { contrast: 1.13, saturation: 1.1, vignette: 0.18 };

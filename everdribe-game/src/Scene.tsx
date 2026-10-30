import { Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vehicle } from './vehicle/Vehicle';
import { Atmosphere } from './graphics/Atmosphere';
import { SurfaceEffects } from './graphics/SurfaceEffects';
import { DynamicWorld } from './core/DynamicWorld';
import { PostProcessing } from './graphics/PostProcessing';
import { useGameStore, renderStats } from './stores/gameStore';
import { GRAPHICS, TONE_MAPPING } from './graphics/GraphicsProfile';

/** Common screen refresh rates: a measured rate snaps to the nearest one. */
const SCREEN_RATES = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 180, 240];

/**
 * Counts the frames the scene really draws, for the HUD's FPS counter, and finds the screen's refresh
 * rate: every second it takes the shortest tenth of the frame times (frames that were not held up by
 * work, so they last one screen refresh) and snaps it to a common rate. A rate above 60 is only believed
 * after three windows in a row agree: a few quick frames once (page load, a hiccup) used to lock the
 * target at 75 or 100 Hz on a 60 Hz screen, and the resolution was then cut to chase frames that could
 * never come. The estimate never drops below 60.
 */
function FrameCounter() {
    const times = useRef<number[]>([]);
    const seen = useRef({ rate: 0, count: 0 });
    useFrame((_, delta) => {
        renderStats.frames++;
        const t = times.current;
        t.push(delta);
        if (t.length < 60) return;
        t.sort((a, b) => a - b);
        // The shortest tenth and the shortest third must agree, or the window was too uneven to tell
        const fast = 1 / t[Math.floor(t.length * 0.1)], typical = 1 / t[Math.floor(t.length * 0.33)];
        t.length = 0;
        const snap = (hz: number) => SCREEN_RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best));
        const snapped = snap(fast);
        const steady = Math.abs(snapped - fast) / snapped < 0.06 && snap(typical) === snapped;
        const s = seen.current;
        if (!steady) { s.count = 0; return; }
        s.count = snapped === s.rate ? s.count + 1 : 1;
        s.rate = snapped;
        if (s.count >= 3) renderStats.screenHz = Math.max(60, snapped);
    });
    return null;
}

/**
 * Keeps the frame rate first and spends spare GPU time on sharpness. The target is 60 FPS, whatever the
 * screen's refresh rate (frames are still drawn as fast as the screen allows). Every second it looks at the
 * average frame time: if frames are slower than the target it lowers the render resolution one step;
 * after three smooth seconds at the target it raises it one step, never outside the quality level's
 * range. After a drop it waits ten seconds before trying higher again, so it does not see-saw.
 */
const DPR_STEP = 0.125;
function AdaptiveResolution({ range }: { range: [number, number] }) {
    const setDpr = useThree((s) => s.setDpr);
    const t = useRef({ sum: 0, frames: 0, smooth: 0, holdUntil: 0, dpr: 0 });
    useEffect(() => {
        const start = Math.min(range[1], Math.max(range[0], window.devicePixelRatio || 1));
        t.current = { sum: 0, frames: 0, smooth: 0, holdUntil: 0, dpr: start };
        setDpr(start);
    }, [range, setDpr]);
    useFrame((state, delta) => {
        const s = t.current;
        s.sum += delta; s.frames++;
        if (s.sum < 1) return;
        const avgMs = (s.sum / s.frames) * 1000;
        s.sum = 0; s.frames = 0;
        // Hold 60 FPS, not the screen's full rate: on a 120 Hz screen, chasing 120 cost half the pixels
        const targetMs = 1000 / 60;
        const now = state.clock.elapsedTime;
        if (avgMs > targetMs * 1.1 && s.dpr > range[0]) {
            s.dpr = Math.max(range[0], s.dpr - DPR_STEP);
            s.smooth = 0; s.holdUntil = now + 10;
            setDpr(s.dpr);
        } else if (avgMs < targetMs * 1.03) {
            if (++s.smooth >= 3 && now > s.holdUntil && s.dpr < range[1]) {
                s.dpr = Math.min(range[1], s.dpr + DPR_STEP);
                s.smooth = 0;
                setDpr(s.dpr);
            }
        } else s.smooth = 0;
    });
    return null;
}

/**
 * Development builds only: puts the renderer, scene and camera on `window.__everdribe`, so graphics can
 * be inspected and A/B-tested from the browser console (see docs/GRAPHICS-ARCHITECTURE.md, "Back-test").
 */
function DevHandle() {
    const state = useThree();
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        (window as unknown as Record<string, unknown>).__everdribe = { gl: state.gl, scene: state.scene, camera: state.camera, store: useGameStore };
    }, [state.gl, state.scene, state.camera]);
    return null;
}

export function Scene() {
    const quality = useGameStore((s) => s.quality);
    const dpr = GRAPHICS[quality].dpr;

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <Canvas
                shadows
                dpr={dpr}
                // Always draw: one frame per screen refresh, no cap (the browser itself never goes faster)
                frameloop="always"
                camera={{ position: [0, 50, 100], fov: 52, near: 0.3, far: 4000 }}
                // Edges are smoothed in PostProcessing (MSAA + SMAA), so the canvas itself needs no antialias
                gl={{ antialias: false, powerPreference: 'high-performance', toneMapping: TONE_MAPPING }}
            >
                <FrameCounter />
                <AdaptiveResolution range={dpr} />
                <DevHandle />
                <Atmosphere />
                <PostProcessing />
                <DynamicWorld />
                <SurfaceEffects />
                <Suspense fallback={null}>
                    <Vehicle />
                </Suspense>
            </Canvas>
        </div>
    );
}

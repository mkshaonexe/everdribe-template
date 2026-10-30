import { useEffect, useRef } from 'react';
import { useGameStore, vehicleState, driftState, renderStats } from '../stores/gameStore';
import { MiniMap } from './MiniMap';
import { CameraOverlay } from './CameraOverlay';

/**
 * Driving display: speed, gear and rev bar bottom-left, distance bottom-right, drift score in the
 * middle, minimap top-left. Fast-changing numbers are written straight into the DOM every frame
 * instead of through React.
 */
export function HUD() {
    const phase = useGameStore((s) => s.phase);
    const distance = useGameStore((s) => s.distance);
    const isMuted = useGameStore((s) => s.isMuted);
    const toggleMute = useGameStore((s) => s.toggleMute);
    const togglePause = useGameStore((s) => s.togglePause);
    const showFps = useGameStore((s) => s.showFps);

    const speedRef = useRef<HTMLDivElement>(null);
    const gearRef = useRef<HTMLDivElement>(null);
    const revRef = useRef<HTMLDivElement>(null);
    const driftRef = useRef<HTMLDivElement>(null);
    const driftNumRef = useRef<HTMLDivElement>(null);
    const fpsRef = useRef<HTMLDivElement>(null);
    const flashRef = useRef<HTMLDivElement>(null);
    const speedFxRef = useRef<HTMLCanvasElement>(null);
    const vignetteRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let raf = 0;
        // FPS = frames the 3D scene drew (this HUD loop runs at the screen's rate whatever the game does)
        let frames = renderStats.frames;
        let last = performance.now();
        // Speed streaks: thin lines near the screen edges that run outwards, only at high speed or
        // under hard throttle. Each streak has its own angle, start and speed so no pattern repeats.
        const streaks = Array.from({ length: 46 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.6 + Math.random() * 0.9 }));
        let fxLevel = 0;
        let prevT = performance.now();
        const drawSpeedFx = (now: number) => {
            const cv = speedFxRef.current;
            if (!cv) return;
            const dt = Math.min(0.05, (now - prevT) / 1000);
            prevT = now;
            const kmh = vehicleState.speed * 3.6;
            const want = Math.min(1, Math.max(0, (kmh - 95) / 80)) * 0.7 + Math.min(1, Math.max(0, vehicleState.longAccel - 3) / 6) * 0.3 * Math.min(1, kmh / 60);
            fxLevel += (want - fxLevel) * (1 - Math.exp(-3 * dt));
            if (vignetteRef.current) vignetteRef.current.style.opacity = String(fxLevel * 0.55);
            const w = cv.clientWidth >> 1, h = cv.clientHeight >> 1;
            if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
            const ctx = cv.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, w, h);
            if (fxLevel < 0.02) return;
            const cx = w / 2, cy = h * 0.46, R = Math.hypot(w, h) / 2;
            ctx.lineCap = 'round';
            for (const s of streaks) {
                s.r += s.v * dt * (0.8 + fxLevel * 1.6);
                if (s.r > 1) { s.r = 0; s.a = Math.random() * Math.PI * 2; s.v = 0.6 + Math.random() * 0.9; }
                const r0 = R * (0.55 + s.r * 0.45), r1 = r0 + R * (0.06 + 0.1 * fxLevel);
                const fade = Math.sin(s.r * Math.PI);
                ctx.strokeStyle = `rgba(255,255,255,${0.16 * fxLevel * fade})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(s.a) * r0, cy + Math.sin(s.a) * r0 * 0.8);
                ctx.lineTo(cx + Math.cos(s.a) * r1, cy + Math.sin(s.a) * r1 * 0.8);
                ctx.stroke();
            }
        };
        const loop = () => {
            const now = performance.now();
            if (now - last > 1000) {
                if (fpsRef.current) fpsRef.current.textContent = `${Math.round(((renderStats.frames - frames) * 1000) / (now - last))} FPS`;
                frames = renderStats.frames;
                last = now;
            }
            if (speedRef.current) speedRef.current.textContent = String(Math.round(vehicleState.speed * 3.6));
            if (gearRef.current) gearRef.current.textContent = vehicleState.gear < 0 ? 'R' : vehicleState.speed < 0.5 && vehicleState.throttle < 0.05 ? 'N' : String(vehicleState.gear);
            if (revRef.current) {
                const r = Math.min(1, Math.max(0, (vehicleState.rpm - 800) / 6200));
                revRef.current.style.width = `${r * 100}%`;
                revRef.current.style.background = r > 0.9 ? '#ef4444' : r > 0.75 ? '#fbbf24' : '#6ee7b7';
            }
            // Drift: live combo while sliding, then the banked score for two seconds
            const banked = now - driftState.lastScoreAt < 2000;
            const live = driftState.combo > 20;
            if (driftRef.current && driftNumRef.current) {
                driftRef.current.style.opacity = live || banked ? '1' : '0';
                driftNumRef.current.textContent = live ? Math.round(driftState.combo).toLocaleString() : `+${driftState.lastScore.toLocaleString()}`;
                driftRef.current.style.transform = `translateX(-50%) scale(${live ? 1 + Math.min(0.25, driftState.combo / 8000) : 1})`;
            }
            if (flashRef.current) flashRef.current.style.opacity = String(Math.min(0.5, vehicleState.impact * 0.8));
            drawSpeedFx(now);
            raf = requestAnimationFrame(loop);
        };
        loop();
        return () => cancelAnimationFrame(raf);
    }, []);

    if (phase === 'loading') return null;
    const driving = phase === 'driving';

    return (
        <>
            <canvas ref={speedFxRef} className={`absolute inset-0 w-full h-full pointer-events-none ${driving ? '' : 'hidden'}`} />
            <div ref={vignetteRef} className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.55))] opacity-0" />
            <div ref={flashRef} className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(255,40,20,0.6))] opacity-0" />

            {driving && (
                <div className="absolute top-5 right-5 flex items-center gap-2 z-40 pointer-events-auto">
                    <button onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}
                        className="w-11 h-11 rounded-full bg-black/35 backdrop-blur-md border border-white/15 text-white/85 hover:bg-black/55 flex items-center justify-center">
                        {isMuted ? '🔇' : '🔊'}
                    </button>
                    <button onClick={togglePause} title="Pause (Esc)"
                        className="w-11 h-11 rounded-full bg-black/35 backdrop-blur-md border border-white/15 text-white/85 hover:bg-black/55 flex items-center justify-center font-bold">
                        ❚❚
                    </button>
                </div>
            )}

            {showFps && (
                <div ref={fpsRef} className="absolute top-2 left-1/2 -translate-x-1/2 text-emerald-300 font-mono font-bold text-xs z-50 pointer-events-none bg-black/50 px-2 py-0.5 rounded-full">
                    -- FPS
                </div>
            )}

            {driving && (
                <>
                    <MiniMap />
                    <CameraOverlay />

                    <div ref={driftRef} className="absolute top-[18%] left-1/2 text-center pointer-events-none transition-opacity duration-300 opacity-0" style={{ transform: 'translateX(-50%)' }}>
                        <div className="text-amber-300 text-xs font-bold tracking-[0.4em] uppercase drop-shadow">Drift</div>
                        <div ref={driftNumRef} className="text-white text-5xl font-black italic drop-shadow-[0_3px_10px_rgba(0,0,0,0.5)]">0</div>
                    </div>

                    <div className="absolute inset-x-0 bottom-0 p-7 pointer-events-none select-none flex justify-between items-end bg-gradient-to-t from-black/45 to-transparent">
                        <div className="flex items-end gap-4">
                            <div>
                                <div ref={speedRef} className="text-7xl font-black font-mono text-white tracking-tighter leading-none drop-shadow">0</div>
                                <div className="text-xs font-bold text-white/70 uppercase tracking-[0.3em] mt-1">km/h</div>
                                <div className="mt-2 w-40 h-1.5 rounded-full bg-white/15 overflow-hidden">
                                    <div ref={revRef} className="h-full rounded-full" style={{ width: '10%' }} />
                                </div>
                            </div>
                            <div className="mb-6 w-12 h-12 rounded-xl border-2 border-white/40 flex items-center justify-center bg-black/30">
                                <div ref={gearRef} className="text-2xl font-black text-white font-mono">1</div>
                            </div>
                        </div>

                        <div className="hidden md:block text-[11px] text-white/45 uppercase tracking-wider text-center mb-2">
                            W A S D drive · Space hard brake · Shift boost · H horn · C camera · R reset · Esc pause
                        </div>

                        <div className="text-right">
                            <div className="text-4xl font-black font-mono text-white tracking-tight drop-shadow">{(distance / 1000).toFixed(1)}</div>
                            <div className="text-xs font-bold text-white/70 uppercase tracking-[0.3em] mt-1">km driven</div>
                        </div>
                    </div>
                </>
            )}
        </>
    );
}

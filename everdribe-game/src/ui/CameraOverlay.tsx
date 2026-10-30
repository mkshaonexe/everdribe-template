import { useEffect, useRef } from 'react';
import { CAMERA_MODES, useGameStore, vehicleState } from '../stores/gameStore';

const COCKPIT_MODE = CAMERA_MODES.indexOf('Cockpit');

/**
 * Shows the name of the point of view for a moment after C is pressed, and draws a dashboard
 * and a steering wheel (turning with the real steering input) in the cockpit view.
 */
export function CameraOverlay() {
    const cameraMode = useGameStore((s) => s.cameraMode);
    const cameraToastAt = useGameStore((s) => s.cameraToastAt);
    const wheelRef = useRef<SVGGElement>(null);

    // Turn the wheel every frame, straight from the live steering value (no React re-render)
    useEffect(() => {
        if (cameraMode !== COCKPIT_MODE) return;
        let raf = 0;
        const loop = () => {
            wheelRef.current?.setAttribute('transform', `rotate(${(-vehicleState.steer * 110).toFixed(1)} 200 190)`);
            raf = requestAnimationFrame(loop);
        };
        loop();
        return () => cancelAnimationFrame(raf);
    }, [cameraMode]);

    return (
        <>
            {/* Re-keyed on every press, so the fade-out animation restarts each time */}
            {cameraToastAt > 0 && (
                <div key={cameraToastAt} className="absolute top-20 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none">
                    <div className="camera-toast px-5 py-2 rounded-full bg-black/55 backdrop-blur-md border border-white/20 text-white text-sm font-semibold uppercase tracking-widest shadow-lg">
                        Camera · {CAMERA_MODES[cameraMode]}
                    </div>
                </div>
            )}

            {cameraMode === COCKPIT_MODE && (
                <div className="absolute inset-x-0 bottom-0 h-[46%] pointer-events-none select-none z-0">
                    {/* Dashboard top and windscreen pillars */}
                    <div className="absolute inset-x-0 bottom-0 h-full bg-gradient-to-t from-black via-black/90 to-transparent" />
                    <div className="absolute left-0 top-[-60%] h-[160%] w-[3.5%] bg-black/90 -skew-x-6 origin-bottom" />
                    <div className="absolute right-0 top-[-60%] h-[160%] w-[3.5%] bg-black/90 skew-x-6 origin-bottom" />
                    <svg viewBox="0 0 400 260" className="absolute left-1/2 -translate-x-1/2 bottom-[-18%] w-[min(520px,70vw)] opacity-95">
                        <g ref={wheelRef} transform="rotate(0 200 190)">
                            <circle cx="200" cy="190" r="92" fill="none" stroke="#161618" strokeWidth="20" />
                            <circle cx="200" cy="190" r="92" fill="none" stroke="#3b3b40" strokeWidth="3" />
                            <rect x="108" y="184" width="184" height="12" rx="6" fill="#161618" />
                            <rect x="193" y="190" width="14" height="80" rx="7" fill="#161618" />
                            <circle cx="200" cy="190" r="16" fill="#26262a" stroke="#3b3b40" strokeWidth="2" />
                            <rect x="196" y="100" width="8" height="14" rx="3" fill="#d6402f" />
                        </g>
                    </svg>
                </div>
            )}
        </>
    );
}

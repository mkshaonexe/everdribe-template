import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useGameStore, VEHICLES, driftState, handlingFor, recommended, renderStats, TIME_PRESETS, CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_DEFAULT } from '../stores/gameStore';
import { assetCount } from '../assets/availability';
import type { Quality, TimeOfDay } from '../stores/gameStore';
import type { Handling } from '../vehicle/VehiclePhysics';
import { AudioManager } from '../audio/AudioManager';

type View = 'main' | 'garage' | 'handling' | 'settings' | 'controls';

const QUALITY_NAMES: Record<Quality, string> = { low: 'Fast', medium: 'Balanced', high: 'Beautiful', ultra: 'Ultra' };

// What each handling slider does, in the player's words
const HANDLING_ROWS: { key: keyof Handling; label: string; hint: string; min: number; max: number; step: number; show: (v: number) => string }[] = [
    { key: 'steering', label: 'Steering sensitivity', hint: 'How far and how fast the wheels turn', min: 0.5, max: 1.5, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
    { key: 'grip', label: 'Tyre grip', hint: 'How hard the car can corner before it slides', min: 0.8, max: 1.3, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
    { key: 'drift', label: 'Drift', hint: '0 = Space only brakes. Higher = Space with steering kicks the rear out', min: 0, max: 1, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
    { key: 'driftAngle', label: 'Drift angle', hint: 'Deepest slide before the car catches the tail', min: 15, max: 60, step: 1, show: (v) => `${Math.round(v)}°` },
    { key: 'brake', label: 'Brake (S)', hint: 'Normal braking strength', min: 0.6, max: 1.4, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
    { key: 'handbrake', label: 'Hard brake (Space)', hint: 'How quickly Space stops the car', min: 0.3, max: 1.5, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
    { key: 'power', label: 'Acceleration', hint: 'How quickly the car picks up speed (top speed stays)', min: 0.7, max: 1.3, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
];

const hourText = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

const click = () => AudioManager.getInstance().play('click', 0.6);

// Flat blocks with small corners and hairline borders, no glow. The primary button is solid gold;
// the others are quiet rows that pick up a gold border on hover.
function Button({ children, onClick, primary, hint }: { children: ReactNode; onClick: () => void; primary?: boolean; hint?: string }) {
    return (
        <button
            onClick={() => { click(); onClick(); }}
            className={`group w-full flex items-center justify-between gap-4 px-5 py-3.5 rounded-sm text-left border transition-[background-color,border-color,transform] duration-150 motion-safe:hover:translate-x-1
                ${primary
                    ? 'bg-sun text-night border-sun hover:bg-sun/90'
                    : 'bg-night/60 text-paper border-paper/15 hover:border-sun/70 hover:bg-night/80'}`}
        >
            <span className="font-display text-xl font-bold uppercase tracking-wide">{children}</span>
            {hint && <span className={`font-mono text-xs tracking-wider ${primary ? 'text-night/70' : 'text-paper/60'}`}>{hint}</span>}
        </button>
    );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
    return (
        <div className="grid gap-1 p-1 rounded-sm bg-night/60 border border-paper/15" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
            {options.map(([v, label]) => (
                <button
                    key={v}
                    onClick={() => { click(); onChange(v); }}
                    className={`py-3 rounded-sm text-sm font-semibold transition-colors ${value === v ? 'bg-paper text-night' : 'text-paper/70 hover:text-paper hover:bg-paper/10'}`}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

function Slider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    return (
        <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))}
            className="w-full h-11 accent-sun" />
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-xs uppercase tracking-[0.18em] text-paper/60 font-semibold">{label}</div>
            {children}
        </div>
    );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="w-14 text-paper/60">{label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-paper/10 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${value * 100}%`, background: color }} />
            </div>
        </div>
    );
}

/**
 * Title screen, pause menu, garage, settings and controls. The 3D scene keeps running behind it,
 * with the camera circling the parked car, so the menu always shows the real game.
 */
export function MenuOverlay() {
    const phase = useGameStore((s) => s.phase);
    const setPhase = useGameStore((s) => s.setPhase);
    const s = useGameStore();
    const [view, setView] = useState<View>('main');

    useEffect(() => { if (phase === 'driving') setView('main'); }, [phase]);

    // Enter starts driving from the title or pause screen
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.code === 'Enter' && (phase === 'title' || phase === 'paused') && view === 'main') {
                click();
                setPhase('driving');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [phase, view, setPhase]);

    if (phase !== 'title' && phase !== 'paused') return null;
    const paused = phase === 'paused';
    const car = VEHICLES.find((v) => v.id === s.selectedVehicle) ?? VEHICLES[0];
    const assets = assetCount();

    return (
        <div className="absolute inset-0 z-50 pointer-events-auto select-none">
            {/* Shade the left side for the panel, keep the car on the right visible */}
            <div className="absolute inset-0 bg-gradient-to-r from-night/85 via-night/50 to-transparent" />
            <div className="absolute inset-y-0 left-0 w-full max-w-[460px] overflow-y-auto">
            <div className="min-h-full flex flex-col justify-center px-8 md:px-12 py-8 gap-7">
                <div>
                    <h1 className="font-display text-7xl font-black italic leading-none tracking-tight text-paper">
                        Ever<span className="text-sun">Dribe</span>
                    </h1>
                    <p className="mt-3 text-paper/70 text-xs font-semibold tracking-[0.2em] uppercase">
                        {paused ? 'Paused' : 'Endless roads · golden hours'}
                    </p>
                </div>

                {view === 'main' && (
                    <div className="flex flex-col gap-3">
                        <Button primary hint="ENTER" onClick={() => setPhase('driving')}>{paused ? 'Resume' : 'Drive'}</Button>
                        {paused && <Button onClick={() => { s.requestRespawn(); setPhase('driving'); }} hint="R">Back to the road</Button>}
                        <Button onClick={() => setView('garage')}>Garage</Button>
                        <Button onClick={() => setView('handling')}>Handling</Button>
                        <Button onClick={() => setView('settings')}>Settings</Button>
                        <Button onClick={() => setView('controls')}>How to drive</Button>
                        {driftState.best > 0 && (
                            <div className="text-paper/70 text-sm mt-2">Best drift: <span className="text-sun font-bold tabular-nums">{driftState.best.toLocaleString()}</span></div>
                        )}
                    </div>
                )}

                {view === 'garage' && (
                    <div className="flex flex-col gap-4">
                        <div className="text-paper/60 text-xs font-semibold uppercase tracking-[0.18em]">Garage · pick your car</div>
                        {VEHICLES.map((v) => (
                            <button
                                key={v.id}
                                onClick={() => { click(); s.setSelectedVehicle(v.id); }}
                                className={`text-left p-4 rounded-sm border transition-colors ${v.id === car.id ? 'bg-paper/10 border-sun' : 'bg-night/60 border-paper/15 hover:border-paper/40'}`}
                            >
                                <div className="flex items-center gap-3">
                                    <span className="w-3 h-3 rounded-full" style={{ background: v.accent }} />
                                    <span className="font-display text-2xl font-bold uppercase text-paper">{v.name}</span>
                                    {v.id === car.id && <span className="ml-auto text-xs font-bold uppercase tracking-widest text-sun">Selected</span>}
                                </div>
                                <p className="text-paper/70 text-sm mt-1">{v.description}</p>
                                <div className="mt-3 space-y-1.5">
                                    <Stat label="Power" value={v.stats.power} color={v.accent} />
                                    <Stat label="Grip" value={v.stats.grip} color={v.accent} />
                                    <Stat label="Drift" value={v.stats.drift} color={v.accent} />
                                </div>
                            </button>
                        ))}
                        <Button onClick={() => setView('main')}>Back</Button>
                    </div>
                )}

                {view === 'handling' && (() => {
                    const h = handlingFor(car.id, s.handling);
                    return (
                        <div className="flex flex-col gap-4">
                            <div className="text-paper/60 text-xs font-semibold uppercase tracking-[0.18em]">Handling · {car.name}</div>
                            {HANDLING_ROWS.map((r) => (
                                <div key={r.key}>
                                    <div className="flex items-baseline justify-between text-sm">
                                        <span className="text-paper font-semibold">{r.label}</span>
                                        <span className="font-mono text-sun font-bold">{r.show(h[r.key])}</span>
                                    </div>
                                    <input type="range" min={r.min} max={r.max} step={r.step} value={h[r.key]} aria-label={r.label}
                                        onChange={(e) => s.setHandling(car.id, { [r.key]: Number(e.target.value) })}
                                        className="w-full h-11 accent-sun" />
                                    <div className="text-xs text-paper/65 -mt-1">{r.hint}</div>
                                </div>
                            ))}
                            <Button onClick={() => s.resetHandling(car.id)}>Reset to stock</Button>
                            <Button onClick={() => setView('main')}>Back</Button>
                        </div>
                    );
                })()}

                {view === 'settings' && (
                    <div className="flex flex-col gap-5">
                        <Row label={`Time of day · ${hourText(s.hour)}`}>
                            <input type="range" min={7} max={19.5} step={0.25} value={s.hour} aria-label="Time of day"
                                onChange={(e) => s.setHour(Number(e.target.value))} className="w-full h-11 accent-sun" />
                            <Segmented<TimeOfDay>
                                value={(Object.keys(TIME_PRESETS) as TimeOfDay[]).find((k) => TIME_PRESETS[k] === s.hour) ?? ('' as TimeOfDay)}
                                onChange={(t) => s.setHour(TIME_PRESETS[t])}
                                options={[['morning', 'Morning'], ['noon', 'Noon'], ['golden', 'Golden'], ['dusk', 'Dusk']]} />
                        </Row>
                        <Row label="Graphics">
                            <Segmented<Quality> value={s.quality} onChange={s.setQuality}
                                options={[['low', 'Fast'], ['medium', 'Balanced'], ['high', 'Beautiful'], ['ultra', 'Ultra']]} />
                            <div className="flex items-center justify-between gap-3 text-sm text-paper/70">
                                <span>Recommended for this device: <span className="text-paper font-semibold">{QUALITY_NAMES[recommended.quality]}</span></span>
                                {s.quality !== recommended.quality && (
                                    <button onClick={() => { click(); s.setQuality(recommended.quality); }}
                                        className="min-h-11 px-3 rounded-sm border border-paper/15 text-paper font-semibold hover:border-sun/70 transition-colors">Use it</button>
                                )}
                            </div>
                            <div className="text-xs text-paper/60 break-words">GPU: {recommended.gpu} ({recommended.reason})</div>
                        </Row>
                        <Row label={`Camera distance · ${s.cameraDistance.toFixed(1)} m${Math.abs(s.cameraDistance - CAMERA_DISTANCE_DEFAULT) < 0.05 ? ' (default)' : ''}`}>
                            <input type="range" min={CAMERA_DISTANCE_MIN} max={CAMERA_DISTANCE_MAX} step={0.5} value={s.cameraDistance} aria-label="Camera distance"
                                onChange={(e) => s.setCameraDistance(Number(e.target.value))} className="w-full h-11 accent-sun" />
                            <div className="flex items-center justify-between gap-3 text-xs text-paper/65">
                                <span>How far behind the car the chase camera sits. The mouse wheel also changes it while driving.</span>
                                {Math.abs(s.cameraDistance - CAMERA_DISTANCE_DEFAULT) >= 0.05 && (
                                    <button onClick={() => { click(); s.setCameraDistance(CAMERA_DISTANCE_DEFAULT); }}
                                        className="shrink-0 min-h-11 px-3 rounded-sm border border-paper/15 text-paper text-sm font-semibold hover:border-sun/70 transition-colors">Reset</button>
                                )}
                            </div>
                        </Row>
                        <Row label={`Music · ${Math.round(s.musicVolume * 100)}%`}><Slider value={s.musicVolume} onChange={s.setMusicVolume} /></Row>
                        <Row label={`Effects · ${Math.round(s.sfxVolume * 100)}%`}><Slider value={s.sfxVolume} onChange={s.setSfxVolume} /></Row>
                        <div className="flex gap-3">
                            <button onClick={() => { click(); s.toggleMute(); }} className="flex-1 py-3 rounded-sm bg-night/60 border border-paper/15 text-paper text-sm font-semibold hover:border-paper/40 transition-colors">
                                {s.isMuted ? 'Sound: off' : 'Sound: on'}
                            </button>
                            <button onClick={() => { click(); s.toggleShowFps(); }} className="flex-1 py-3 rounded-sm bg-night/60 border border-paper/15 text-paper text-sm font-semibold hover:border-paper/40 transition-colors">
                                {s.showFps ? 'FPS: shown' : 'FPS: hidden'}
                            </button>
                        </div>
                        <div className="-mt-2 text-xs text-paper/65">
                            Frame rate is unlocked: the game draws a new picture every time your screen refreshes
                            {renderStats.screenHz ? ` (${renderStats.screenHz} Hz here, so up to ${renderStats.screenHz} FPS)` : ''}.
                            Browsers never draw faster than the screen.
                        </div>
                        <Button onClick={() => setView('main')}>Back</Button>
                    </div>
                )}

                {view === 'controls' && (
                    <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-sm">
                            {[
                                ['W / ↑', 'Accelerate'],
                                ['S / ↓', 'Brake, then reverse (W while reversing brakes, then drives)'],
                                ['A D / ← →', 'Steer'],
                                ['Space', 'Hard brake. With steering and Drift turned up in Handling, it kicks the rear out'],
                                ['W + S + A / D', 'Spin on the spot (at a stop)'],
                                ['Shift', 'Boost'],
                                ['H', 'Horn (hold)'],
                                ['C', 'Change camera'],
                                ['R', 'Back to the road'],
                                ['Esc / P', 'Pause'],
                                ['Drag mouse', 'Look around · scroll to zoom'],
                            ].map(([k, d]) => (
                                <div key={k} className="contents">
                                    <span className="font-mono text-sun font-bold">{k}</span>
                                    <span className="text-paper/80">{d}</span>
                                </div>
                            ))}
                        </div>
                        <p className="text-paper/65 text-sm leading-relaxed">
                            Drift tip: the car is set up for grip, so it slides only a little. Raise Drift in Handling, then at speed steer into a bend, tap Space, hold the throttle and steer the other way to hold the slide.
                        </p>
                        <Button onClick={() => setView('main')}>Back</Button>
                    </div>
                )}
            </div>

            </div>
            <div className="hidden md:block absolute bottom-6 right-8 text-right text-paper/60 text-xs leading-relaxed">
                <div>{car.name}</div>
                <div>3D models, textures, sounds and music made with Higgsfield AI</div>
                <div>Assets: {assets.loaded}/{assets.total} loaded{assets.loaded < assets.total ? ' · built-in stand-ins for the rest (see ASSETS.md)' : ''}</div>
            </div>
        </div>
    );
}

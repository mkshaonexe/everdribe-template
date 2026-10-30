import { create } from 'zustand';
import { Vector3 } from 'three';
import { DEFAULT_HANDLING } from '../vehicle/VehiclePhysics';
import type { Handling } from '../vehicle/VehiclePhysics';
import { recommendQuality } from '../utils/deviceTier';
import { CAR } from '../assets.config';

export interface VehicleConfig {
    id: string;
    name: string;
    description: string;
    path: string;                       // GLB under public/
    length: number;                     // metres, nose to tail, the model is scaled to this
    yawOffset: number;                  // radians, turns the model so its nose points down -Z
    stats: { power: number; grip: number; drift: number }; // 0..1, for the garage screen
    accent: string;                     // UI colour
    handling: Handling;                 // stock handling; the player's changes are saved on top
}

// Live car pose, written every frame by Vehicle and read by the minimap's own draw loop.
// Kept outside the store so a 60Hz update causes no React re-render.
// yaw is the world heading of the car's nose, measured as atan2(forwardZ, forwardX).
export const playerPose = { x: 0, z: 0, yaw: Math.PI / 2 };

// Live driving state, written every frame by Vehicle and read by effects, HUD and camera.
// Also kept outside the store: nothing here should trigger a React render.
export const vehicleState = {
    speed: 0,         // m/s, forward speed
    throttle: 0,      // 0..1, smoothed pedal
    longAccel: 0,     // m/s², smoothed; + = speeding up
    lateralAccel: 0,  // m/s², smoothed; + = turning left
    surface: 1,       // 0 = grass, 1 = asphalt (smoothed)
    onGround: true,
    steer: 0,         // -1..1 smoothed steering wheel
    rpm: 900,
    gear: 1,
    skid: 0,          // 0..1 how hard the tyres slide
    driftAngle: 0,    // radians
    impact: 0,        // 0..1, decays after a hit (camera shake, HUD flash)
    vx: 0,            // world velocity, m/s
    vz: 0,
    inWater: false,
    // Contact point and surface of each wheel (FL, FR, RL, RR)
    wheels: [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0, surface: 'asphalt' as string })),
};

// Frames the 3D scene really drew, counted by the scene and read by the HUD's FPS counter.
// screenHz: the screen's refresh rate as measured from frame times (0 until known). Browsers never
// draw faster than the screen refreshes, so this is the highest frame rate the game can show.
export const renderStats = { frames: 0, screenHz: 0 };

// Running drift score, shown by the HUD
export const driftState = { combo: 0, lastScore: 0, lastScoreAt: 0, best: 0 };

// Camera points of view, cycled with the C key
export const CAMERA_DISTANCE_MIN = 4;
export const CAMERA_DISTANCE_MAX = 16;
export const CAMERA_DISTANCE_DEFAULT = 7.5;
export const CAMERA_MODES = ['Chase', 'Far Chase', 'Hood', 'Cockpit', 'Drone'] as const;
export type CameraMode = typeof CAMERA_MODES[number];

// One car. Its file, size and fit come from assets.config.ts; without the file a coupe is built in code.
export const VEHICLES: VehicleConfig[] = [
    {
        id: 'emerald',
        name: CAR.name,
        description: 'Sleek coupe. Smooth, fast and planted on long sweepers.',
        path: CAR.file,
        length: CAR.targetLength,
        yawOffset: (CAR.yawDegrees * Math.PI) / 180,
        stats: { power: 0.78, grip: 0.82, drift: 0.25 },
        accent: CAR.accent,
        handling: { ...DEFAULT_HANDLING },
    },
];

export type Phase = 'loading' | 'title' | 'driving' | 'paused';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type TimeOfDay = 'morning' | 'noon' | 'golden' | 'dusk';
/** Hour of the day each named preset stands for (the sky is blended between them). */
export const TIME_PRESETS: Record<TimeOfDay, number> = { morning: 7.5, noon: 12.5, golden: 17, dusk: 19 };

export const recommended = recommendQuality();

interface GameState {
    phase: Phase;
    isPaused: boolean; // true whenever the car is not being driven (loading, title, pause)
    loadProgress: number; // 0..1
    setPhase: (phase: Phase) => void;
    setLoadProgress: (p: number) => void;
    togglePause: () => void;
    setIsPaused: (isPaused: boolean) => void;

    speed: number;
    distance: number;
    showFps: boolean;
    position: Vector3;
    setSpeed: (speed: number) => void;
    addDistance: (delta: number) => void;
    toggleShowFps: () => void;
    setPosition: (position: Vector3) => void;

    // Free look camera
    isFreeLookActive: boolean;
    isFreeLookButtonActive: boolean;
    freeLookYaw: number;
    freeLookPitch: number;
    setFreeLookActive: (active: boolean) => void;
    toggleFreeLookButton: () => void;
    updateFreeLookAngles: (deltaYaw: number, deltaPitch: number) => void;
    resetFreeLookAngles: () => void;

    cameraDistance: number;
    updateCameraZoom: (delta: number) => void;
    setCameraDistance: (d: number) => void;
    cameraPreviewAt: number; // when the Settings slider last moved: the menu shows the chase view for a moment
    cameraMode: number;
    cameraToastAt: number;
    cycleCameraMode: () => void;

    // Road around the car, for the minimap
    roadPath: Vector3[];
    setRoadPath: (path: Vector3[]) => void;

    // Settings
    isMuted: boolean;
    toggleMute: () => void;
    setMute: (isMuted: boolean) => void;
    musicVolume: number;
    sfxVolume: number;
    setMusicVolume: (v: number) => void;
    setSfxVolume: (v: number) => void;
    quality: Quality;
    setQuality: (q: Quality) => void;
    hour: number;                       // 7..19.5
    setHour: (h: number) => void;

    // Per-car handling changes, on top of each car's stock handling
    handling: Record<string, Partial<Handling>>;
    setHandling: (carId: string, patch: Partial<Handling>) => void;
    resetHandling: (carId: string) => void;

    selectedVehicle: string;
    setSelectedVehicle: (id: string) => void;

    respawnAt: number; // bump to ask the car to go back to the road
    requestRespawn: () => void;
}

const saved = (() => {
    try { return JSON.parse(localStorage.getItem('everdribe-settings') || '{}'); } catch { return {}; }
})();

const persist = (patch: Record<string, unknown>) => {
    try {
        const current = JSON.parse(localStorage.getItem('everdribe-settings') || '{}');
        localStorage.setItem('everdribe-settings', JSON.stringify({ ...current, ...patch }));
    } catch { /* storage blocked (private window): settings just are not remembered */ }
};

export const useGameStore = create<GameState>((set) => ({
    phase: 'loading',
    isPaused: true,
    loadProgress: 0,
    setPhase: (phase) => set({ phase, isPaused: phase !== 'driving' }),
    setLoadProgress: (loadProgress) => set({ loadProgress }),
    togglePause: () => set((s) => {
        if (s.phase === 'driving') return { phase: 'paused', isPaused: true };
        if (s.phase === 'paused') return { phase: 'driving', isPaused: false };
        return {};
    }),
    setIsPaused: (isPaused) => set((s) => (s.phase === 'loading' ? {} : { isPaused, phase: isPaused ? 'paused' : 'driving' })),

    speed: 0,
    distance: 0,
    showFps: saved.showFps ?? true,
    position: new Vector3(0, 0, 0),
    setSpeed: (speed) => set({ speed }),
    addDistance: (delta) => set((state) => ({ distance: state.distance + delta })),
    toggleShowFps: () => set((s) => { persist({ showFps: !s.showFps }); return { showFps: !s.showFps }; }),
    setPosition: (position) => set({ position }),

    isFreeLookActive: false,
    isFreeLookButtonActive: false,
    freeLookYaw: 0,
    freeLookPitch: 0,
    setFreeLookActive: (active) => set({ isFreeLookActive: active }),
    toggleFreeLookButton: () => set((state) => ({
        isFreeLookButtonActive: !state.isFreeLookButtonActive,
        freeLookYaw: state.isFreeLookButtonActive ? 0 : state.freeLookYaw,
        freeLookPitch: state.isFreeLookButtonActive ? 0 : state.freeLookPitch,
    })),
    updateFreeLookAngles: (deltaYaw, deltaPitch) => set((state) => ({
        freeLookYaw: state.freeLookYaw + deltaYaw,
        freeLookPitch: Math.max(-Math.PI / 3, Math.min(Math.PI / 3, state.freeLookPitch + deltaPitch)),
    })),
    resetFreeLookAngles: () => set({ freeLookYaw: 0, freeLookPitch: 0 }),

    // Chase camera distance (m). Saved, so a refresh keeps it; set in Settings or with the wheel while driving
    cameraDistance: saved.cameraDistance ?? CAMERA_DISTANCE_DEFAULT,
    setCameraDistance: (d) => {
        const cameraDistance = Math.max(CAMERA_DISTANCE_MIN, Math.min(CAMERA_DISTANCE_MAX, d));
        persist({ cameraDistance });
        set({ cameraDistance, cameraPreviewAt: performance.now() });
    },
    cameraPreviewAt: 0,
    updateCameraZoom: (delta) => set((state) => {
        const cameraDistance = Math.max(CAMERA_DISTANCE_MIN, Math.min(CAMERA_DISTANCE_MAX, state.cameraDistance + delta));
        persist({ cameraDistance });
        return { cameraDistance };
    }),
    cameraMode: 0,
    cameraToastAt: 0,
    cycleCameraMode: () => set((state) => ({
        cameraMode: (state.cameraMode + 1) % CAMERA_MODES.length,
        cameraToastAt: performance.now(),
    })),

    roadPath: [],
    setRoadPath: (path) => set({ roadPath: path }),

    isMuted: saved.isMuted ?? false,
    toggleMute: () => set((s) => { persist({ isMuted: !s.isMuted }); return { isMuted: !s.isMuted }; }),
    setMute: (isMuted) => set({ isMuted }),
    // First visit: music quiet under the engine, effects full
    musicVolume: saved.musicVolume ?? 0.05,
    sfxVolume: saved.sfxVolume ?? 1,
    setMusicVolume: (musicVolume) => { persist({ musicVolume }); set({ musicVolume }); },
    setSfxVolume: (sfxVolume) => { persist({ sfxVolume }); set({ sfxVolume }); },
    // First visit: the quality this device can likely hold; the player can change it in Settings
    quality: saved.quality ?? recommended.quality,
    setQuality: (quality) => { persist({ quality }); set({ quality }); },
    // First visit: noon. A saved hour (or the old saved preset) still wins
    hour: saved.hour ?? (saved.timeOfDay ? TIME_PRESETS[saved.timeOfDay as TimeOfDay] : TIME_PRESETS.noon),
    setHour: (hour) => { persist({ hour }); set({ hour }); },

    // Saved under a new key: v0.7.0 changes were relative to the old stock, which moved in v0.7.1
    handling: saved.handling2 ?? {},
    setHandling: (carId, patch) => set((st) => {
        const handling = { ...st.handling, [carId]: { ...st.handling[carId], ...patch } };
        persist({ handling2: handling });
        return { handling };
    }),
    resetHandling: (carId) => set((st) => {
        const handling = { ...st.handling };
        delete handling[carId];
        persist({ handling2: handling });
        return { handling };
    }),

    // A saved choice of a car that is no longer in the garage (the old second car) falls back to the first
    selectedVehicle: VEHICLES.some((v) => v.id === saved.selectedVehicle) ? saved.selectedVehicle! : VEHICLES[0].id,
    setSelectedVehicle: (selectedVehicle) => { persist({ selectedVehicle }); set({ selectedVehicle }); },

    respawnAt: 0,
    requestRespawn: () => set({ respawnAt: performance.now() }),
}));

/** A car's handling: its stock values with the player's changes on top. */
export function handlingFor(carId: string, changes: Record<string, Partial<Handling>>): Handling {
    const car = VEHICLES.find((v) => v.id === carId) ?? VEHICLES[0];
    return { ...car.handling, ...changes[carId] };
}

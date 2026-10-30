import { useEffect, useState } from 'react';
import { useProgress } from '@react-three/drei';
import { useGameStore, renderStats } from '../stores/gameStore';
import { AudioManager } from '../audio/AudioManager';
import { terrainChunksPending } from '../terrain/TerrainChunk';

/**
 * First screen: shows progress while the 3D models, textures, sounds and the first ring of terrain
 * load, then hands over to the title menu.
 */
export function LoadingScreen() {
    const phase = useGameStore((s) => s.phase);
    const setPhase = useGameStore((s) => s.setPhase);
    const { progress: loaderProgress, active, total: loaderTotal } = useProgress();
    // With no model or texture files to load (asset-free template) the loaders never start
    const assetProgress = loaderTotal === 0 ? 100 : loaderProgress;
    const [audio, setAudio] = useState(0);
    const [terrain, setTerrain] = useState(0);
    const [fading, setFading] = useState(false);

    useEffect(() => {
        AudioManager.getInstance().loadAll((done, total) => setAudio(done / total));
    }, []);

    // Terrain: count chunks still waiting for their worker
    useEffect(() => {
        if (phase !== 'loading') return;
        let peak = 1;
        const id = setInterval(() => {
            const left = terrainChunksPending();
            peak = Math.max(peak, left);
            // Ready only once the scene has drawn: before it mounts (asset check) no chunk is pending yet
            setTerrain(left === 0 ? (renderStats.frames > 2 ? 1 : 0) : 1 - left / peak);
        }, 150);
        return () => clearInterval(id);
    }, [phase]);

    const total = (assetProgress / 100) * 0.55 + audio * 0.25 + terrain * 0.2;
    const done = !active && assetProgress >= 100 && audio >= 1 && terrain >= 1;

    useEffect(() => {
        if (phase !== 'loading' || !done) return;
        setFading(true);
        const t = setTimeout(() => setPhase('title'), 600);
        return () => clearTimeout(t);
    }, [done, phase, setPhase]);

    if (phase !== 'loading') return null;

    const step = assetProgress < 100 ? 'Loading cars and scenery' : audio < 1 ? 'Tuning the engine' : 'Laying the road';
    return (
        <div className={`absolute inset-0 z-[60] flex flex-col items-center justify-center bg-night transition-opacity duration-500 ${fading ? 'opacity-0' : 'opacity-100'}`}>
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_120%,rgba(245,185,66,0.28),transparent_60%)]" />
            <h1 className="relative font-display text-7xl md:text-8xl font-black italic leading-none tracking-tight text-paper">
                Ever<span className="text-sun">Dribe</span>
            </h1>
            <p className="relative mt-4 text-paper/70 text-xs font-semibold tracking-[0.2em] uppercase">Endless roads · golden hours</p>
            <div className="relative mt-12 w-[min(420px,80vw)]">
                {/* Flat bar with square ends, like a race timer. It turns green when the road is ready. */}
                <div className="h-1 bg-paper/15 overflow-hidden">
                    <div className={`h-full transition-[width,background-color] duration-200 ${done ? 'bg-meadow' : 'bg-sun'}`} style={{ width: `${Math.round(total * 100)}%` }} />
                </div>
                <div className="mt-3 flex justify-between text-sm text-paper/70 tabular-nums">
                    <span>{step}…</span>
                    <span className="font-semibold text-paper">{Math.round(total * 100)}%</span>
                </div>
            </div>
        </div>
    );
}

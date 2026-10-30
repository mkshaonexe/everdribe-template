import { AUDIO_DIR, assetUrl, checkAssets, hasAsset } from '../assets/availability';

/**
 * One Web Audio context for the whole game, with three buses (music, effects, master) and a cache of
 * decoded sound files. Browsers start the context suspended; the first click or key press resumes it.
 * Only the files that are there are loaded (assets/availability.ts); a missing sound simply stays silent.
 */

export const SOUND_FILES = {
    engineIdle: 'engine-idle.wav',
    engineMid: 'engine-mid.wav',
    engineHigh: 'engine-high.wav',
    skid: 'skid.wav',
    gravel: 'gravel.wav',
    wind: 'wind.wav',
    bump: 'bump.wav',
    // Hits, scrapes and the rest (Higgsfield Mirelo, cut so each hit starts at 0 ms: scripts/prepare-sfx.py)
    railHitHard: 'rail-hit-hard.wav',
    railHitSoft: 'rail-hit-soft.wav',
    railScrape: 'rail-scrape.wav',
    treeHitHard: 'tree-hit-hard.wav',
    treeHitSoft: 'tree-hit-soft.wav',
    pineHit: 'pine-hit.wav',
    birchHit: 'birch-hit.wav',
    treeScrape: 'tree-scrape.wav',
    rockHit: 'rock-hit.wav',
    crashHeavy: 'crash-heavy.wav',
    landHard: 'land-hard.wav',
    landSoft: 'land-soft.wav',
    grassRoll: 'grass-roll.wav',
    dirtRoll: 'dirt-roll.wav',
    splash: 'splash.wav',
    horn: 'horn.wav',
    click: 'click.wav',
    musicDrive: 'music-drive.m4a',
    musicMenu: 'music-menu.m4a',
} as const;
export type SoundName = keyof typeof SOUND_FILES;
/** Every sound file's path under public/, for the asset check. */
export const SOUND_PATHS = Object.values(SOUND_FILES).map((f) => AUDIO_DIR + f);

export class AudioManager {
    private static instance: AudioManager;
    public context: AudioContext;
    public masterGain: GainNode;
    public sfxGain: GainNode;
    public musicGain: GainNode;
    private buffers = new Map<SoundName, AudioBuffer>();
    private loading: Promise<void> | null = null;
    /** True once every sound that is there has been loaded (or failed). */
    public loaded = false;
    private musicSource: AudioBufferSourceNode | null = null;
    private musicTrackGain: GainNode | null = null;
    private currentTrack: SoundName | null = null;

    private constructor() {
        this.context = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        this.masterGain = this.context.createGain();
        this.masterGain.connect(this.context.destination);
        this.sfxGain = this.context.createGain();
        this.sfxGain.connect(this.masterGain);
        this.musicGain = this.context.createGain();
        this.musicGain.connect(this.masterGain);
        this.masterGain.gain.value = 0.9;
        this.sfxGain.gain.value = 0.8;
        this.musicGain.gain.value = 0.45;

        const resume = () => { this.resume(); };
        document.addEventListener('pointerdown', resume);
        document.addEventListener('keydown', resume);
    }

    public static getInstance(): AudioManager {
        if (!AudioManager.instance) AudioManager.instance = new AudioManager();
        return AudioManager.instance;
    }

    public async resume() {
        if (this.context.state === 'suspended') await this.context.resume();
    }

    public isReady(): boolean {
        return this.context.state === 'running';
    }

    /** Download and decode every sound once. Safe to call many times. */
    public loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
        if (this.loading) return this.loading;
        this.loading = checkAssets(SOUND_PATHS).then(async () => {
            const names = (Object.keys(SOUND_FILES) as SoundName[]).filter((n) => hasAsset(AUDIO_DIR + SOUND_FILES[n]));
            let done = 0;
            await Promise.all(names.map(async (name) => {
                try {
                    const res = await fetch(assetUrl(AUDIO_DIR + SOUND_FILES[name]));
                    const data = await res.arrayBuffer();
                    this.buffers.set(name, await this.context.decodeAudioData(data));
                } catch (e) {
                    console.warn('Sound failed to load:', name, e);
                }
                done++;
                onProgress?.(done, names.length);
            }));
            this.loaded = true;
            if (names.length === 0) onProgress?.(1, 1);   // nothing to load: report done
        });
        return this.loading;
    }

    public buffer(name: SoundName): AudioBuffer | undefined {
        return this.buffers.get(name);
    }

    /** A looping source into a gain node on the effects bus, started silent. */
    public loop(name: SoundName): { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null {
        const buf = this.buffers.get(name);
        if (!buf) return null;
        const source = this.context.createBufferSource();
        source.buffer = buf;
        source.loop = true;
        const filter = this.context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 20000;
        const gain = this.context.createGain();
        gain.gain.value = 0;
        source.connect(filter).connect(gain).connect(this.sfxGain);
        // Start each loop at a random point so layers do not phase together
        source.start(0, Math.random() * buf.duration);
        return { source, gain, filter };
    }

    private lastPlayed = new Map<SoundName, number>();

    /** Fire-and-forget sound effect. The same sound is not started twice within 80 ms (no flamming). */
    public play(name: SoundName, volume = 1, rate = 1) {
        const buf = this.buffers.get(name);
        if (!buf || !this.isReady()) return;
        const now = this.context.currentTime;
        if (now - (this.lastPlayed.get(name) ?? -1) < 0.08) return;
        this.lastPlayed.set(name, now);
        const source = this.context.createBufferSource();
        source.buffer = buf;
        source.playbackRate.value = rate;
        const gain = this.context.createGain();
        gain.gain.value = volume;
        source.connect(gain).connect(this.sfxGain);
        source.start();
    }

    /** Cross-fade to another music track (or silence with null). */
    public playMusic(name: SoundName | null) {
        if (name === this.currentTrack) return;
        const now = this.context.currentTime;
        if (this.musicSource && this.musicTrackGain) {
            const old = this.musicSource;
            this.musicTrackGain.gain.cancelScheduledValues(now);
            this.musicTrackGain.gain.setTargetAtTime(0, now, 0.6);
            old.stop(now + 3);
        }
        this.currentTrack = name;
        this.musicSource = null;
        if (!name) return;
        const buf = this.buffers.get(name);
        if (!buf) { this.currentTrack = null; return; }
        this.startTrack(name, buf);
    }

    /**
     * Menu music loops. Driving music is quieter, plays once, then leaves a random 40–100 s of silence
     * before it comes back, so the same guitar phrase does not repeat under the whole drive.
     */
    private startTrack(name: SoundName, buf: AudioBuffer) {
        const now = this.context.currentTime;
        const withBreaks = name === 'musicDrive';
        const source = this.context.createBufferSource();
        source.buffer = buf;
        source.loop = !withBreaks;
        const gain = this.context.createGain();
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(withBreaks ? 0.55 : 1, now, 0.8);
        source.connect(gain).connect(this.musicGain);
        source.start();
        if (withBreaks) {
            // Fade the last few seconds out instead of stopping on a hard edge
            gain.gain.setTargetAtTime(0, now + buf.duration - 6, 1.5);
            source.onended = () => {
                if (this.musicSource !== source) return;
                const wait = 40 + Math.random() * 60;
                window.setTimeout(() => {
                    if (this.musicSource === source && this.currentTrack === name) this.startTrack(name, buf);
                }, wait * 1000);
            };
        }
        this.musicSource = source;
        this.musicTrackGain = gain;
    }

    public setVolumes(master: number, music: number, sfx: number, muted: boolean) {
        const now = this.context.currentTime;
        this.masterGain.gain.setTargetAtTime(muted ? 0 : master, now, 0.05);
        this.musicGain.gain.setTargetAtTime(music * 0.6, now, 0.05);
        this.sfxGain.gain.setTargetAtTime(sfx, now, 0.05);
    }
}

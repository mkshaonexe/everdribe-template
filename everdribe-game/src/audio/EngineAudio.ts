import { AudioManager } from './AudioManager';
import { Ambience } from './Ambience';

/**
 * Car sound from recorded layers instead of one synthetic tone:
 *  - three engine loops (idle, mid, high revs) pitched to the current rpm and cross-faded,
 *    louder and brighter under throttle, softer and muffled when coasting;
 *  - tyre squeal by how much the tyres slide, wind by speed;
 *  - what the tyres roll on: gravel on the road shoulder, a grass swish in the meadow, a dirt crunch on
 *    bare soil, each louder and brighter with speed;
 *  - countryside ambience underneath (see Ambience.ts: made in code so it never loops audibly).
 */
interface Layer { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }

// The rpm each engine recording sounds like when played at normal speed (estimated by ear-free
// analysis of their main frequency; tuned so the cross-fade has no jump in pitch)
const NATIVE_RPM = { idle: 1000, mid: 3800, high: 6200 };
const CAR_AUDIO_GAIN = 1.3; // Raise engine and tyre squeal while leaving world, UI and music unchanged.

export interface EngineFrame {
    rpm: number;
    throttle: number;   // 0..1
    speed: number;      // m/s
    skid: number;       // 0..1
    shoulder: number;   // 0..1 share of wheels on the gravel shoulder
    grass: number;      // 0..1 share on meadow grass
    dirt: number;       // 0..1 share on bare soil or sand
    shifting: boolean;
    active: boolean;    // false in the menus: engine idles quietly, no wind
}

/**
 * Without the engine recordings (an asset-free template) a plain synthesized hum stands in: a sawtooth at
 * the firing frequency of a four-cylinder (rpm / 30) with a square one octave down, through a low-pass.
 */
interface Hum { oscs: OscillatorNode[]; filter: BiquadFilterNode; gain: GainNode }

export class EngineAudio {
    private am = AudioManager.getInstance();
    private layers: Record<string, Layer | null> = {};
    private started = false;
    private ambience = new Ambience();
    private hum: Hum | null = null;

    private startHum() {
        const ctx = this.am.context;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 600;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        filter.connect(gain).connect(this.am.sfxGain);
        const oscs = (['sawtooth', 'square'] as OscillatorType[]).map((type) => {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.value = 30;
            o.connect(filter);
            o.start();
            return o;
        });
        this.hum = { oscs, filter, gain };
    }

    start() {
        if (this.started) return;
        const am = this.am;
        if (!am.buffer('engineIdle')) {
            if (!am.loaded) return;   // sounds not loaded yet; try again next frame
            this.startHum();          // loaded, but there is no engine recording
        }
        this.layers = {
            idle: am.loop('engineIdle'),
            mid: am.loop('engineMid'),
            high: am.loop('engineHigh'),
            skid: am.loop('skid'),
            gravel: am.loop('gravel'),
            grass: am.loop('grassRoll'),
            dirt: am.loop('dirtRoll'),
            wind: am.loop('wind'),
        };
        this.started = true;
    }

    stop() {
        for (const l of Object.values(this.layers)) {
            try { l?.source.stop(); } catch { /* already stopped */ }
            l?.source.disconnect();
        }
        if (this.hum) {
            for (const o of this.hum.oscs) { try { o.stop(); } catch { /* already stopped */ } o.disconnect(); }
            this.hum.gain.disconnect();
            this.hum = null;
        }
        this.ambience.stop();
        this.layers = {};
        this.started = false;
    }

    update(f: EngineFrame) {
        if (!this.started) { this.start(); if (!this.started) return; }
        const ctx = this.am.context;
        const now = ctx.currentTime;
        const set = (l: Layer | null, gain: number, rate?: number, cutoff?: number, tc = 0.06) => {
            if (!l) return;
            l.gain.gain.setTargetAtTime(gain, now, tc);
            if (rate !== undefined) l.source.playbackRate.setTargetAtTime(rate, now, 0.05);
            if (cutoff !== undefined) l.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
        };

        const rpm = Math.max(700, f.rpm);
        // Equal-power cross-fade weights across idle -> mid -> high
        const t1 = Math.min(1, Math.max(0, (rpm - 1300) / (3500 - 1300)));
        const t2 = Math.min(1, Math.max(0, (rpm - 3800) / (6000 - 3800)));
        const wIdle = Math.cos(t1 * Math.PI / 2);
        const wMid = Math.sin(t1 * Math.PI / 2) * Math.cos(t2 * Math.PI / 2);
        const wHigh = Math.sin(t2 * Math.PI / 2);

        const load = f.shifting ? 0.25 : 0.35 + 0.65 * f.throttle;
        const volume = CAR_AUDIO_GAIN * (f.active ? 0.55 : 0.3) * (0.55 + 0.45 * load);
        const bright = 900 + 7000 * load + rpm * 0.4;   // throttle opens the sound up

        set(this.layers.idle, wIdle * volume, Math.min(2, rpm / NATIVE_RPM.idle), bright);
        set(this.layers.mid, wMid * volume, Math.min(2, Math.max(0.5, rpm / NATIVE_RPM.mid)), bright);
        set(this.layers.high, wHigh * volume * 0.9, Math.min(1.6, Math.max(0.6, rpm / NATIVE_RPM.high)), bright);
        if (this.hum) {
            const fire = rpm / 30;
            this.hum.oscs[0].frequency.setTargetAtTime(fire, now, 0.05);
            this.hum.oscs[1].frequency.setTargetAtTime(fire / 2, now, 0.05);
            this.hum.filter.frequency.setTargetAtTime(250 + bright * 0.12, now, 0.08);
            this.hum.gain.gain.setTargetAtTime(volume * 0.22, now, 0.06);
        }

        const speedK = Math.min(1, f.speed / 45);
        set(this.layers.skid, f.active ? CAR_AUDIO_GAIN * Math.pow(f.skid, 1.3) * 0.55 : 0, 0.9 + f.skid * 0.25, undefined, 0.04);
        // Off the asphalt: rolling sounds rise with speed (silent at a stop), a little brighter when fast
        const roll = f.active ? Math.min(1, f.speed / 14) : 0;
        const rollRate = 0.8 + speedK * 0.45;
        const rollCut = 2500 + speedK * 12000;
        set(this.layers.gravel, f.shoulder * roll * 0.6, rollRate);
        set(this.layers.grass, f.grass * roll * 0.85, rollRate, rollCut, 0.1);
        set(this.layers.dirt, f.dirt * roll * 0.85, rollRate, rollCut, 0.1);
        set(this.layers.wind, f.active ? Math.pow(speedK, 1.6) * 0.5 : 0, 0.85 + speedK * 0.35, 900 + speedK * 6000, 0.2);
        this.ambience.update(0.5 * (1 - speedK * 0.7));
    }
}

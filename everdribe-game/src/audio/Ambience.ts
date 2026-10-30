import { AudioManager } from './AudioManager';

/**
 * Countryside background that never repeats, built in code instead of looping one short recording
 * (the old 12 s `ambience.wav` loop came round so often that its swells sounded like waves on a beach):
 *  - a quiet bed of soft air: filtered noise whose loudness and tone drift slowly at random;
 *  - now and then a single bird call, each one with its own pitch, length, number of notes, side and
 *    distance, and long random gaps of silence between them.
 */
export class Ambience {
    private am = AudioManager.getInstance();
    private bedGain: GainNode | null = null;
    private bedFilter: BiquadFilterNode | null = null;
    private bedSource: AudioBufferSourceNode | null = null;
    private output: GainNode | null = null;
    private nextDrift = 0;
    private nextBird = 0;
    private level = 0;

    private start() {
        const ctx = this.am.context;
        this.output = ctx.createGain();
        this.output.gain.value = 0;
        this.output.connect(this.am.sfxGain);

        // 8 s of brown-ish noise: smooth enough to sound like air, not hiss. Loops are not heard
        // because the filter and level wander all the time.
        const len = ctx.sampleRate * 8;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) {
            last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
            d[i] = last * 3.5;
        }
        this.bedSource = ctx.createBufferSource();
        this.bedSource.buffer = buf;
        this.bedSource.loop = true;
        this.bedFilter = ctx.createBiquadFilter();
        this.bedFilter.type = 'lowpass';
        this.bedFilter.frequency.value = 700;
        this.bedGain = ctx.createGain();
        this.bedGain.gain.value = 0.25;
        this.bedSource.connect(this.bedFilter).connect(this.bedGain).connect(this.output);
        this.bedSource.start();

        this.nextDrift = ctx.currentTime;
        this.nextBird = ctx.currentTime + 6 + Math.random() * 10;
    }

    /** level: 0..1 how loud the countryside should be (quieter at speed, under the wind). */
    update(level: number) {
        if (!this.am.isReady()) return;
        if (!this.output) this.start();
        const ctx = this.am.context;
        const now = ctx.currentTime;
        this.level = level;
        this.output!.gain.setTargetAtTime(level, now, 0.8);

        // Every few seconds, let the air drift to a new loudness and tone
        if (now >= this.nextDrift) {
            const span = 4 + Math.random() * 6;
            this.bedGain!.gain.setTargetAtTime(0.12 + Math.random() * 0.2, now, span / 2);
            this.bedFilter!.frequency.setTargetAtTime(350 + Math.random() * 650, now, span / 2);
            this.nextDrift = now + span;
        }

        // A bird only when the car is slow enough to hear one, and never on a timer you can learn
        if (now >= this.nextBird) {
            if (this.level > 0.15) this.bird(now);
            this.nextBird = now + 9 + Math.random() * 26;
        }
    }

    /** One short call: 1–4 quick chirps, each a little pitch sweep, panned and far away. */
    private bird(t0: number) {
        const ctx = this.am.context;
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.random() * 1.6 - 0.8;
        const far = ctx.createBiquadFilter();
        far.type = 'lowpass';
        far.frequency.value = 3500 + Math.random() * 3500;   // further birds sound duller
        const gain = ctx.createGain();
        gain.gain.value = 0.025 + Math.random() * 0.035;
        far.connect(pan).connect(gain).connect(this.output!);

        const base = 2200 + Math.random() * 2200;
        const notes = 1 + Math.floor(Math.random() * 4);
        const noteLen = 0.05 + Math.random() * 0.09;
        const gap = 0.05 + Math.random() * 0.12;
        const sweep = (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.35);
        let t = t0 + 0.05;
        for (let i = 0; i < notes; i++) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            const f = base * (1 + (Math.random() - 0.5) * 0.12);
            osc.frequency.setValueAtTime(f, t);
            osc.frequency.exponentialRampToValueAtTime(f * (1 + sweep), t + noteLen);
            const env = ctx.createGain();
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(1, t + noteLen * 0.25);
            env.gain.exponentialRampToValueAtTime(0.001, t + noteLen);
            osc.connect(env).connect(far);
            osc.start(t);
            osc.stop(t + noteLen + 0.02);
            t += noteLen + gap;
        }
        // Let the nodes go once the call has finished
        setTimeout(() => gain.disconnect(), (t - t0 + 0.5) * 1000);
    }

    stop() {
        try { this.bedSource?.stop(); } catch { /* already stopped */ }
        this.output?.disconnect();
        this.output = null;
        this.bedSource = null;
    }
}

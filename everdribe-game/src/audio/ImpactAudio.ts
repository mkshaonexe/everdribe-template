import { AudioManager, type SoundName } from './AudioManager';
import type { ContactState, ImpactEvent } from '../vehicle/VehiclePhysics';

/**
 * Everything the car's body makes a noise against:
 *  - a hit picks its sound by what was hit (leafy tree, pine, birch, rock, building, guardrail, fence)
 *    and how hard; a knock with the side of the car is lighter than a nose-on hit;
 *  - while the body rubs along something, a scrape loop follows the sliding speed and is silent
 *    the instant the car comes free (no crash sound that keeps going after the car has moved away);
 *  - landings after a jump, a splash into the river, and the horn (H).
 */
interface Loop { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }

const jitter = () => 0.96 + Math.random() * 0.08;

export class ImpactAudio {
    private am = AudioManager.getInstance();
    private loops: { rail: Loop | null; tree: Loop | null; horn: Loop | null } = { rail: null, tree: null, horn: null };
    private started = false;
    // The body is pushed out of a rail and touches it again every two or three frames while rubbing;
    // holding the last contact for a moment keeps the scrape smooth instead of chopped
    private rub = { kind: '', slide: 0, at: -1 };

    private start() {
        if (this.started || !this.am.buffer('railScrape')) return;
        this.loops = { rail: this.am.loop('railScrape'), tree: this.am.loop('treeScrape'), horn: this.am.loop('horn') };
        this.started = true;
    }

    stop() {
        for (const l of Object.values(this.loops)) {
            try { l?.source.stop(); } catch { /* already stopped */ }
            l?.source.disconnect();
        }
        this.loops = { rail: null, tree: null, horn: null };
        this.started = false;
    }

    /** A knock against something solid, strength 0..1 (1 = 20 m/s straight into it). */
    hit(e: ImpactEvent) {
        const s = e.strength;
        if (s < 0.05) return;
        const vol = Math.min(1, (0.2 + s * 1.3) * (e.side ? 0.7 : 1));
        const hard = s > 0.3;
        const play = (name: SoundName, v = vol, rate = 1) => this.am.play(name, v, rate * jitter());

        switch (e.kind) {
            case 'guardrail':
                play(hard && !e.side ? 'railHitHard' : 'railHitSoft', vol, e.side ? 1.08 : 1);
                break;
            case 'treeGreen':
            case 'treeAutumn':
                play(hard ? 'treeHitHard' : 'treeHitSoft');
                break;
            case 'pine':
                play('pineHit', vol * (hard ? 1 : 0.7), hard ? 0.95 : 1.05);
                if (hard) play('treeHitHard', vol * 0.5, 0.9);
                break;
            case 'birch':
                play('birchHit', vol, hard ? 0.95 : 1.1);
                break;
            case 'fence':
                play('treeHitSoft', vol * 0.8, 1.3);
                break;
            case 'house':
            case 'barn':
                if (s > 0.4) play('crashHeavy');
                else play('rockHit', vol, 0.8);
                break;
            default: // rock and anything else hard
                play('rockHit');
        }
        // A really fast hit crumples the car, whatever it hit
        if (s > 0.6 && e.kind !== 'house' && e.kind !== 'barn') play('crashHeavy', Math.min(1, (s - 0.5) * 1.6));
    }

    /** Touching down after time in the air. */
    land(e: ImpactEvent) {
        const s = e.strength * (0.7 + Math.min(1, (e.air ?? 0) / 1.2) * 0.3);
        if (s > 0.35) this.am.play('landHard', Math.min(1, 0.4 + s * 0.7), jitter());
        else if (s > 0.12) this.am.play('landSoft', 0.35 + s * 1.5, jitter());
    }

    splash(speed: number) {
        this.am.play('splash', Math.min(1, 0.4 + speed / 25), jitter());
    }

    /** Every frame: scrape loops from the live contact, the horn while H is held. */
    update(contact: ContactState, horn: boolean, active: boolean) {
        if (!this.started) { this.start(); if (!this.started) return; }
        const now = this.am.context.currentTime;
        if (contact.kind) { this.rub.kind = contact.kind; this.rub.slide = contact.slide; this.rub.at = now; }
        const kind = active && now - this.rub.at < 0.12 ? this.rub.kind : '';
        const slide = kind ? this.rub.slide : 0;
        const metal = kind === 'guardrail' || kind === 'rock' || kind === 'house' || kind === 'barn';
        const rub = Math.min(1, slide / 14);
        const set = (l: Loop | null, gain: number, rate: number, cutoff: number) => {
            if (!l) return;
            // Quick attack, very quick release: the scrape ends as soon as the car is free
            l.gain.gain.setTargetAtTime(gain, now, gain > l.gain.gain.value ? 0.03 : 0.02);
            l.source.playbackRate.setTargetAtTime(rate, now, 0.05);
            l.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
        };
        const rate = 0.85 + rub * 0.35;
        const cutoff = 1500 + rub * 12000;
        set(this.loops.rail, metal && slide > 0.8 ? 0.15 + rub * 0.75 : 0, kind === 'guardrail' ? rate : rate * 0.75, cutoff);
        set(this.loops.tree, !metal && kind && slide > 0.8 ? 0.2 + rub * 0.7 : 0, rate, cutoff);
        set(this.loops.horn, active && horn ? 0.55 : 0, 1, 20000);
    }
}

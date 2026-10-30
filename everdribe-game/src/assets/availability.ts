import { CAR } from '../assets.config';

/**
 * Which asset files are really there. The game must run with `public/assets/` empty and use any file that
 * appears there later, so at start-up every expected file is probed once (all in parallel) and the scene is
 * only mounted after the answer is known (App waits on `assetsReady`, the loading screen shows meanwhile).
 *
 * A probe is a HEAD request (GET when a host refuses HEAD). A file counts as present when the answer is
 * 200 and is not HTML: Vite's dev server, and many static hosts with a single-page-app fallback, answer a
 * missing file with index.html and status 200.
 */

export const MODEL_FILES = {
    car: CAR.file,
    rock: 'assets/models/rock.glb',
    rockLod: 'assets/models/rock-lod.glb',
    house: 'assets/models/house.glb',
    barn: 'assets/models/barn.glb',
    fence: 'assets/models/fence.glb',
    guardrail: 'assets/models/guardrail.glb',
} as const;

export const TEXTURE_FILES = {
    leaves: 'assets/textures/leaves.webp',
    grass: 'assets/textures/grass.jpg',
    dirt: 'assets/textures/dirt.jpg',
    gravel: 'assets/textures/gravel.jpg',
    riverbed: 'assets/textures/riverbed.jpg',
    dust: 'assets/textures/dust.png',
} as const;

export const AUDIO_DIR = 'assets/audio/';

const BASE = import.meta.env.BASE_URL;
/** Full URL of an asset path such as 'assets/models/rock.glb'. */
export const assetUrl = (path: string) => BASE + path;

const present = new Set<string>();
let checked: string[] = [];
let ready = false;

async function probe(path: string): Promise<boolean> {
    const url = assetUrl(path);
    try {
        let res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, { cache: 'no-cache', headers: { Range: 'bytes=0-0' } });
        }
        if (!res.ok) return false;
        const type = res.headers.get('content-type') ?? '';
        if (type.includes('text/html')) return false;
        const length = res.headers.get('content-length');
        return length === null || Number(length) > 0 || res.status === 206;
    } catch {
        return false;
    }
}

let pending: Promise<void> | null = null;

/** Probe every expected file once. `audioPaths` are the sound files (AudioManager owns their names). */
export function checkAssets(audioPaths: string[]): Promise<void> {
    if (pending) return pending;
    const paths = [...new Set([...Object.values(MODEL_FILES), ...Object.values(TEXTURE_FILES), ...audioPaths])];
    pending = Promise.all(paths.map(async (p) => { if (await probe(p)) present.add(p); })).then(() => {
        checked = paths;
        ready = true;
    });
    return pending;
}

/** True when the file is there. Only meaningful after `checkAssets` has finished (the scene mounts after it). */
export function hasAsset(path: string): boolean {
    if (!ready && import.meta.env.DEV) console.warn('hasAsset() called before the asset check finished:', path);
    return present.has(path);
}

export function assetsChecked(): boolean { return ready; }

/** How many of the expected files are there, for the menu note. */
export function assetCount(): { loaded: number; total: number } {
    return { loaded: present.size, total: checked.length };
}

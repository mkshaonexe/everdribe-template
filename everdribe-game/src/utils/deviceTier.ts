import type { Quality } from '../stores/gameStore';

export interface DeviceTier { quality: Quality; gpu: string; reason: string }

/**
 * A first guess at the graphics level this device can hold at a smooth frame rate, from the GPU name
 * the browser reports, the number of CPU cores, memory and whether it is a phone or tablet. It runs
 * once, before the game loads. The player can always pick another level in Settings.
 */
export function recommendQuality(): DeviceTier {
    let gpu = 'unknown';
    try {
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        if (!gl) return { quality: 'low', gpu, reason: 'no WebGL' };
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
        return { quality: 'medium', gpu, reason: 'could not read the GPU' };
    }
    const cores = navigator.hardwareConcurrency || 4;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const touch = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const g = gpu.toLowerCase();

    if (/swiftshader|llvmpipe|software|basic render/.test(g)) return { quality: 'low', gpu, reason: 'software rendering' };
    if (touch) {
        const strong = /apple gpu|adreno \(tm\) (7|8)\d\d|mali-g7\d\d|immortalis/.test(g);
        return { quality: strong ? 'medium' : 'low', gpu, reason: 'phone or tablet' };
    }
    if (/rtx|radeon rx|radeon pro|apple m\d (pro|max|ultra)/.test(g)) {
        return { quality: cores >= 8 ? 'ultra' : 'high', gpu, reason: 'dedicated or high-end GPU' };
    }
    if (/geforce|apple m\d|apple gpu/.test(g)) return { quality: 'high', gpu, reason: 'capable GPU' };
    if (/intel|uhd|iris|mali|adreno/.test(g)) return { quality: memory >= 8 && cores >= 8 ? 'medium' : 'low', gpu, reason: 'integrated GPU' };
    return { quality: cores >= 8 && memory >= 8 ? 'high' : 'medium', gpu, reason: `${cores} cores, ${memory} GB` };
}

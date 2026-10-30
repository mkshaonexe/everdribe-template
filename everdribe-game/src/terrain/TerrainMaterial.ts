import {
    CanvasTexture, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader, LinearMipmapLinearFilter,
} from 'three';
import { assetUrl, hasAsset, TEXTURE_FILES } from '../assets/availability';

/**
 * Ground material: four tiling photos (grass, dirt, rock, riverbed) mixed per vertex by the
 * `splat` weights the terrain worker computes, then tinted by the vertex colour.
 * Each texture is sampled at two scales and blended, so the repeat is hard to spot from the road.
 * On top of that, so the ground does not read as one flat printed picture:
 * - large lusher and drier patches from world-space noise (tens of metres), which no tile repeats;
 * - relief near the camera: the photo's brightness is used as a height, so clumps and stones catch
 *   the sun and throw a little shade (faded out with distance, where it would only flicker).
 */
const loader = new TextureLoader();

/**
 * Stand-in for a missing ground photo: a seamless 256 px tile of soft speckles around the photo's average
 * colour (`rgb`, sRGB 0..255) with about its contrast, so the tint and the near-camera relief still work.
 * `streaks` adds short upright strokes (grass blades seen from above).
 */
function drawnTile(rgb: [number, number, number], contrast: number, seed: number, streaks = false): Texture {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d')!;
    let st = seed;
    const r = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
    const col = (k: number, a: number) => `rgba(${rgb.map((v) => Math.round(Math.min(255, v * k))).join(',')},${a})`;
    ctx.fillStyle = col(1, 1);
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 1400; i++) {
        const x = r() * S, y = r() * S, rad = 1.5 + r() * r() * 14;
        const k = 1 + (r() - 0.5) * contrast;
        const a = 0.25 + r() * 0.35;
        const dx = (r() - 0.5) * 6, dy = -4 - r() * 8;
        // Draw at the wrapped positions too, so the tile has no seams
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
            ctx.fillStyle = col(k, a);
            ctx.strokeStyle = col(k, a);
            if (streaks && i % 2 === 0) {
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + dx, y + oy + dy); ctx.stroke();
            } else {
                ctx.beginPath(); ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2); ctx.fill();
            }
        }
    }
    return new CanvasTexture(c);
}

function tile(path: string, fallback: () => Texture): Texture {
    const t = hasAsset(path) ? loader.load(assetUrl(path)) : fallback();
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = 8;
    return t;
}

let material: MeshStandardMaterial | null = null;

export function getTerrainMaterial(): MeshStandardMaterial {
    if (material) return material;
    // Each photo, or a drawn tile of its average colour and contrast when the file is missing
    const uniforms = {
        tGrass: { value: tile(TEXTURE_FILES.grass, () => drawnTile([70, 99, 32], 1.0, 11, true)) },
        tDirt: { value: tile(TEXTURE_FILES.dirt, () => drawnTile([127, 97, 69], 0.6, 23)) },
        tRock: { value: tile(TEXTURE_FILES.gravel, () => drawnTile([150, 130, 108], 0.7, 37)) },
        tSand: { value: tile(TEXTURE_FILES.riverbed, () => drawnTile([114, 100, 78], 0.8, 51)) },
    };

    // Ground reflects little sky: a full-strength sky map tints every shadow on the grass blue
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.35 });
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                attribute vec4 splat;
                varying vec4 vSplat;
                varying vec2 vWorldXZ;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                vSplat = splat;
                vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                uniform sampler2D tGrass;
                uniform sampler2D tDirt;
                uniform sampler2D tRock;
                uniform sampler2D tSand;
                varying vec4 vSplat;
                varying vec2 vWorldXZ;
                float gh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
                float gnoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), u.x), mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), u.x), u.y);
                }
                float groundHeight;
                // Normal from a height that is only known per pixel (three's perturbNormalArb, bump map chunk)
                vec3 groundRelief(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
                    vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
                    vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
                    vec3 vN = surf_norm;
                    vec3 R1 = cross(vSigmaY, vN);
                    vec3 R2 = cross(vN, vSigmaX);
                    float fDet = dot(vSigmaX, R1) * faceDirection;
                    vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
                    return normalize(abs(fDet) * surf_norm - vGrad);
                }
                vec3 twoScale(sampler2D t, vec2 p, float near, float far) {
                    vec3 a = texture2D(t, p / near).rgb;
                    vec3 b = texture2D(t, p / far + vec2(0.37, 0.61)).rgb;
                    return mix(a, b, 0.45);
                }`)
            .replace('#include <map_fragment>', `
                vec2 p = vWorldXZ;
                vec3 grass = twoScale(tGrass, p, 5.0, 23.0);
                // Lusher and drier patches, tens of metres across
                float macro = gnoise(p / 70.0) * 0.6 + gnoise(p / 19.0 + 7.3) * 0.4;
                grass *= mix(vec3(0.84, 0.92, 0.86), vec3(1.12, 1.06, 0.88), macro);
                // The colour of the grass blades seen from afar (v0.15.0): the photo alone was a bright lime,
                // so the sward stood out yellow-green against it where the blades end. Warmer and less green,
                // with clump-sized darker mottling (~2-4 m), so the ground past the blades reads as more meadow
                float clumps = gnoise(p / 3.1 + 1.7) * 0.6 + gnoise(p / 1.3 - 4.1) * 0.4;
                grass *= vec3(1.1, 0.95, 0.78) * mix(0.78, 1.06, clumps);
                vec3 dirt = twoScale(tDirt, p, 6.0, 27.0);
                vec3 rock = twoScale(tRock, p, 7.0, 31.0);
                float lum = dot(rock, vec3(0.3, 0.55, 0.15));
                rock = mix(rock, vec3(lum) * vec3(0.95, 0.95, 1.0), 0.7); // grey stone, not brown gravel
                vec3 sand = twoScale(tSand, p, 4.0, 19.0);
                vec4 w = vSplat / max(0.0001, dot(vSplat, vec4(1.0)));
                vec3 ground = grass * w.x + dirt * w.y + rock * w.z + sand * w.w;
                diffuseColor.rgb *= ground;
                groundHeight = dot(ground, vec3(0.3, 0.59, 0.11));
            `)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                {
                    float near = smoothstep(45.0, 6.0, length(vViewPosition));
                    vec2 dH = vec2(dFdx(groundHeight), dFdy(groundHeight)) * 2.2 * near;
                    normal = groundRelief(-vViewPosition, normal, dH, faceDirection);
                }
            `);
    };
    // Different shader from a plain MeshStandardMaterial, so it needs its own program cache key
    m.customProgramCacheKey = () => 'everdribe-terrain';
    material = m;
    return m;
}

import { DoubleSide, MeshStandardMaterial, ShaderChunk, Vector2 } from 'three';
import type { Texture } from 'three';

/**
 * Shared clock for every foliage material, advanced once per frame by Scenery.
 * `uMotion` is 0 on the Fast setting (no sway).
 */
export const foliageUniforms = {
    uTime: { value: 0 },
    uMotion: { value: 1 },
    uCentre: { value: new Vector2() },
    uTreeRadius: { value: 460 },
};

interface FoliageOptions {
    map: Texture;
    /** Height (m, in the model) where the crown starts; below it nothing sways. */
    crown: number;
    /** How far the crown sways. */
    sway: number;
    /** Leaf cards (cut-out, two-sided, light passes through) or bark/stems. */
    leaf: boolean;
    /** Feather leaf edges with MSAA (alpha to coverage) instead of a hard cut. */
    msaa: boolean;
    /** Far trees grow out of the ground gradually near the draw limit. */
    distanceFade?: boolean;
}

/**
 * Material for trees and shrubs (geometry from world/TreeFactory.ts). On top of plain PBR shading it adds:
 *
 * - its own shade and hue for each instance (from its position), so a forest is not one copy-pasted green;
 * - wind: two slow waves and a quick flutter, growing with height above the crown so trunks stay put;
 * - leaves: two-sided cards whose normals come from the crown volume (not flipped on the back face), light
 *   through the outer leaves when the sun is behind them, and alpha that is kept up in the smaller mip levels
 *   so distant crowns do not thin out to bare twigs;
 * - crown depth: the `occ` vertex attribute darkens leaves deep inside the crown (less sky, less sun).
 */
export function makeFoliage(o: FoliageOptions): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
        map: o.map,
        // Matte leaves: at 0.72 the low sun put a white sheen on every leaf card facing the camera
        roughness: o.leaf ? 0.84 : 0.92,
        metalness: 0,
        envMapIntensity: o.leaf ? 0.32 : 0.3,
        side: o.leaf ? DoubleSide : undefined,
        alphaTest: o.leaf ? 0.42 : 0,
        alphaToCoverage: o.leaf && o.msaa,
    });
    const leaf = o.leaf ? 1 : 0;
    m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = foliageUniforms.uTime;
        shader.uniforms.uMotion = foliageUniforms.uMotion;
        shader.uniforms.uCrown = { value: o.crown };
        shader.uniforms.uCentre = foliageUniforms.uCentre;
        shader.uniforms.uTreeRadius = foliageUniforms.uTreeRadius;
        shader.uniforms.uSway = { value: o.sway };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                uniform float uTime;
                uniform float uMotion;
                uniform vec2 uCentre;
                uniform float uTreeRadius;
                uniform float uCrown;
                uniform float uSway;
                attribute float occ;
                varying vec3 vTint;
                varying float vOcc;
                float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                vOcc = occ;
                vec2 root = vec2(0.0);
                #ifdef USE_INSTANCING
                    root = instanceMatrix[3].xz;
                #endif
                float h1 = fhash(root), h2 = fhash(root + 17.3);
                // Shade and hue per plant: from slightly yellow-dry to deep blue-green
                vTint = mix(vec3(1.08, 1.05, 0.84), vec3(0.8, 0.93, 0.92), h1) * (0.84 + 0.26 * h2);
                float up = max(0.0, transformed.y - uCrown);
                float t = uTime + h1 * 6.283;
                vec2 bend = vec2(sin(t * 0.9) + 0.35 * sin(t * 2.3 + 1.7), cos(t * 0.7 + 0.6) * 0.6);
                // A slow, small flutter: fast and large, it made every far leaf blink as it crossed pixels
                float flutter = ${leaf ? '1.0' : '0.0'} * sin(t * 3.2 + transformed.x * 1.7 + transformed.z * 1.3) * 0.15;
                transformed.xz += (bend + flutter) * uSway * uMotion * up * up * 0.01;
                ${o.distanceFade ? `
                // After begin_vertex: stable per-tree fade; roots stay below ground, no alpha overdraw.
                float reach = distance(root, uCentre);
                float grow = 1.0 - smoothstep(uTreeRadius - 60.0 - h1 * 20.0, uTreeRadius, reach);
                transformed.xz *= grow;
                transformed.y = min(transformed.y, 0.0) + max(transformed.y, 0.0) * grow;` : ''}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying vec3 vTint;
                varying float vOcc;`)
            .replace('#include <map_fragment>', `#include <map_fragment>
                // The leaf photo already varies leaf to leaf; the tint only sets each tree a little apart
                diffuseColor.rgb *= mix(vec3(1.0), vTint, ${leaf ? '0.6' : '0.35'});
                ${o.leaf ? `
                // Keep leaves solid in small mips: alpha averages down with distance, so scale it back up
                vec2 texel = vMapUv * vec2(2048.0);
                vec2 dx = dFdx(texel), dy = dFdy(texel);
                float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
                diffuseColor.a *= 1.0 + mip * 0.3;` : ''}`)
            // Leaf normals come from the crown volume: do not flip them on the back face
            .replace('#include <normal_fragment_begin>', o.leaf
                ? ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '')
                : '#include <normal_fragment_begin>')
            .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
                #if NUM_DIR_LIGHTS > 0 && ${leaf}
                    // Sun shining through the leaves towards the camera, and a soft wrap around the crown.
                    // Kept narrow and faint: stronger, it bleached whole backlit crowns pale yellow-white
                    vec3 toSun = directionalLights[0].direction;
                    float through = pow(saturate(dot(-geometryViewDir, toSun)), 6.0);
                    float wrap = saturate(dot(-geometryNormal, toSun) * 0.5 + 0.5);
                    // Light through a leaf is a deeper, more saturated colour than its surface (the photo leaves
                    // are lighter than the old drawn ones, and added as they are they washed backlit crowns cream).
                    // Only the outer leaves pass it on: inside the crown the sun is already blocked.
                    vec3 leafRgb = diffuseColor.rgb;
                    vec3 transmit = leafRgb * mix(vec3(1.0), leafRgb / max(max(leafRgb.r, leafRgb.g), 0.02), 0.75);
                    reflectedLight.directDiffuse += directionalLights[0].color * (transmit * through * 0.28 * vOcc + leafRgb * wrap * 0.08);
                #endif
                // Inside the crown the sky is hidden by the outer leaves: little sky light there and less sun
                // (the shadow maps are too coarse to darken a crown's inside on their own)
                reflectedLight.indirectDiffuse *= mix(0.3, 1.0, vOcc);
                reflectedLight.directDiffuse *= mix(0.55, 1.0, vOcc);
                ${o.leaf ? `
                // Leaves are matte at a distance: with normals from the crown volume, the crown's edge faces
                // sideways, and the bright evening sky reflected there turned the silhouette milky
                reflectedLight.indirectSpecular *= 0.4 * mix(0.3, 1.0, vOcc);
                reflectedLight.directSpecular *= 0.5;` : `
                reflectedLight.indirectSpecular *= mix(0.3, 1.0, vOcc);`}`);
    };
    m.customProgramCacheKey = () => `everdribe-foliage-${leaf}-${o.msaa ? 1 : 0}-${o.distanceFade ? 1 : 0}`;
    return m;
}

/** Shared by every grass patch: the car's position, the grass radius and the detail distances (m). */
export const grassUniforms = {
    uCentre: { value: new Vector2() },
    uRadius: { value: 60 },
    uNear: { value: 11 },
    uMid: { value: 28 },
    uFar: { value: 55 },
};

interface GrassOptions {
    /** Share of the near patch's blades this level has, and the share of the next level (it fades to it). */
    fraction: [number, number];
    /** Blade width at this level and at the next. */
    widen: [number, number];
    /** 0 near, 1 mid, 2 far, 3 farthest (no further level to fade to). */
    level: number;
}

/**
 * Material for the grass patches (world/Grass.tsx). Blades carry their colour per vertex, dark at the root.
 * On top of plain PBR shading, per blade and from smooth noise over the world (so cells blend into each
 * other and nothing repeats):
 *
 * - whether the blade is there: thick patches, thin patches and bare spots, and a ragged edge that keeps the
 *   grass off the gravel shoulder (from the road direction and verge distance each cell carries);
 * - its height: taller clumps a metre or two across, short mown grass along the road edge;
 * - dry straw tips in some stretches, yellow and white flowers in meadow patches, a shade of its own;
 * - level of detail: towards its outer edge each level thins its blades out to the next level's share and
 *   widens them to its width, so the switch to the next level is not seen;
 * - growth with distance: blades rise from the ground between 100 % and 72 % of the grass radius;
 * - wind as a wave that rolls across the field, tips moving most;
 * - a faint glow when the sun is behind the blades. Both faces keep the upward normal, so a blade seen
 *   from behind is not dark.
 */
export function makeGrass(o: GrassOptions): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0,
        envMapIntensity: 0.3,
        side: DoubleSide,
    });
    const fade = o.level === 0 ? 'smoothstep(uNear, uNear + 3.0, dist)' : o.level === 1 ? 'smoothstep(uMid, uMid + 4.0, dist)'
        : o.level === 2 ? 'smoothstep(uFar, uFar + 6.0, dist)' : 'smoothstep(uFar + 6.0, uRadius, dist)';
    m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = foliageUniforms.uTime;
        shader.uniforms.uMotion = foliageUniforms.uMotion;
        shader.uniforms.uCentre = grassUniforms.uCentre;
        shader.uniforms.uRadius = grassUniforms.uRadius;
        shader.uniforms.uNear = grassUniforms.uNear;
        shader.uniforms.uMid = grassUniforms.uMid;
        shader.uniforms.uFar = grassUniforms.uFar;
        shader.uniforms.uFraction = { value: new Vector2(...o.fraction) };
        shader.uniforms.uWiden = { value: new Vector2(...o.widen) };
        // After three's begin_vertex (local position, before the instance matrix)
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                uniform float uTime;
                uniform float uMotion;
                uniform vec2 uCentre;
                uniform float uRadius;
                uniform float uNear;
                uniform float uMid;
                uniform float uFar;
                uniform vec2 uFraction;
                uniform vec2 uWiden;
                attribute vec4 aBlade;   // root x, root z (in the patch), rank 0..1, height along the blade (2 = flower)
                attribute vec2 aSide;    // offset across the blade
                attribute vec4 aCell;    // per patch: direction away from the road (x, z), verge distance at its centre, thickness
                varying vec3 vTint;
                varying float vDry;
                varying float vT;
                float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                float ghash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
                float gnoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(mix(ghash(i), ghash(i + vec2(1.0, 0.0)), u.x), mix(ghash(i + vec2(0.0, 1.0)), ghash(i + vec2(1.0, 1.0)), u.x), u.y);
                }`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                vec3 rootL = vec3(aBlade.x, 0.0, aBlade.y);
                vec2 rw = (instanceMatrix * vec4(rootL, 1.0)).xz;   // grass meshes sit at the world origin
                float dist = distance(rw, uCentre);
                float lodT = ${fade};
                float rank = aBlade.z;
                float flower = step(1.5, aBlade.w);
                float t = min(aBlade.w, 1.0);
                // Fields over the world: patches of ~6 m, clumps of ~1.7 m, fine variation
                float nPatch = gnoise(rw * 0.17);
                float nClump = gnoise(rw * 0.6 + 13.1);
                float nFine = gnoise(rw * 2.3 + 7.7);
                float thick = aCell.w * mix(0.22, 1.0, smoothstep(0.18, 0.62, nPatch * 0.55 + nClump * 0.45));
                float verge = aCell.z + dot(rw - instanceMatrix[3].xz, aCell.xy);
                float keep = 1.0 - smoothstep(thick * mix(uFraction.x, uFraction.y, lodT) - 0.025,
                    thick * mix(uFraction.x, uFraction.y, lodT), rank);
                // Ragged edge along the gravel: a blade's own threshold between -0.45 and 0.35 m
                keep *= step(-0.45 + 0.8 * fract(rank * 37.13 + 0.31), verge);
                // Flowers open only in meadow patches, away from the road
                float bloom = smoothstep(0.6, 0.78, gnoise(rw * 0.08 + 3.3)) * smoothstep(1.5, 4.0, verge);
                keep *= mix(1.0, step(fract(rank * 57.3), bloom * 0.9), flower);
                // Height: taller clumps, short mown grass at the very edge of the road
                float tall = (0.55 + 0.85 * smoothstep(0.35, 0.85, nClump * 0.7 + nPatch * 0.3)) * (0.8 + 0.4 * nFine);
                tall *= mix(0.45, 1.0, smoothstep(0.0, 2.5, verge));
                float grow = 1.0 - smoothstep(uRadius * 0.72, uRadius, dist);
                vec3 rel = transformed - rootL;
                vec2 spine = rel.xz - aSide;
                rel.y *= tall;
                rel.xz = spine * tall + aSide * mix(uWiden.x, uWiden.y, lodT);
                float h1 = fhash(rw), h2 = fhash(rw + 17.3);
                float tw = uTime + dot(rw, vec2(0.08, 0.05));
                vec2 bend = vec2(sin(tw * 1.1) + 0.3 * sin(tw * 2.6 + h1 * 6.283), cos(tw * 0.9 + 0.6) * 0.5);
                // Gentle near sway; subpixel motion in the outer meadow is suppressed.
                float windLod = 1.0 - 0.8 * smoothstep(uFar, uRadius, dist);
                rel.xz += bend * uMotion * t * t * 0.06 * tall * windLod;
                transformed = rootL + rel * (keep * grow);
                vTint = mix(vec3(1.03, 1.02, 0.88), vec3(0.86, 0.98, 0.95), h1) * (0.84 + 0.28 * h2);
                float dryField = smoothstep(0.42, 0.8, gnoise(rw * 0.03 + 5.1)) * 0.75 + 0.25 * smoothstep(0.6, 0.95, nFine);
                vDry = step(fract(rank * 91.7), dryField) * (1.0 - flower);
                vT = t;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying vec3 vTint;
                varying float vDry;
                varying float vT;`)
            .replace('#include <color_fragment>', `#include <color_fragment>
                diffuseColor.rgb *= vTint;
                // Dry tips: straw, still dark at the root
                vec3 straw = vec3(0.47, 0.37, 0.15) * mix(0.4, 1.0, vT);
                diffuseColor.rgb = mix(diffuseColor.rgb, straw, vDry * smoothstep(0.15, 0.85, vT) * 0.85);`)
            .replace('#include <normal_fragment_begin>', ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''))
            .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
                #if NUM_DIR_LIGHTS > 0
                    vec3 toSun = directionalLights[0].direction;
                    float through = pow(saturate(dot(-geometryViewDir, toSun)), 6.0);
                    reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * through * 0.18;
                #endif
                // Blades are thin and matte: the up-facing normals made the whole sward mirror the low sun
                // and the white sky at grazing angles, which bleached it cream against the light
                reflectedLight.directSpecular *= 0.3;
                reflectedLight.indirectSpecular *= 0.35;`);
    };
    m.customProgramCacheKey = () => `everdribe-grass-${o.level}`;
    return m;
}

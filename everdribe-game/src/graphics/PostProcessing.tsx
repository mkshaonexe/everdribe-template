import { useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import type { Object3D } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { useGameStore } from '../stores/gameStore';
import { GRAPHICS, GRADE } from './GraphicsProfile';

/**
 * The final image, in this order (tone mapping happens exactly once, in OutputPass):
 *
 *   scene (HDR, MSAA on High/Ultra)
 *     → GTAO: contact shading where things meet (car on road, tree roots, rail posts)  [High/Ultra]
 *     → bloom: a soft glow on the sun and the brightest highlights only               [Medium+]
 *     → OutputPass: tone mapping (AgX) and conversion to screen colours
 *     → grade: a little contrast, saturation and a faint vignette
 *     → SMAA: smooths the edges MSAA misses (leaf cut-outs, thin wires, highlights)
 */
const GradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        contrast: { value: GRADE.contrast },
        saturation: { value: GRADE.saturation },
        vignette: { value: GRADE.vignette },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float contrast;
        uniform float saturation;
        uniform float vignette;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
            vec3 col = mix(vec3(l), c.rgb, saturation);
            // Contrast around mid-grey, pivoting softly so blacks and whites do not clip
            col = clamp((col - 0.5) * contrast + 0.5, 0.0, 1.0);
            vec2 d = vUv - 0.5;
            col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
            gl_FragColor = vec4(col, c.a);
        }
    `,
};

export function PostProcessing() {
    const { gl, scene, camera, size } = useThree();
    const dpr = useThree((s) => s.viewport.dpr);
    const quality = useGameStore((s) => s.quality);
    const profile = GRAPHICS[quality];

    const composer = useMemo(() => {
        const pr = gl.getPixelRatio();
        const target = new WebGLRenderTarget(size.width * pr, size.height * pr, { type: HalfFloatType, samples: profile.msaa });
        const c = new EffectComposer(gl, target);
        c.addPass(new RenderPass(scene, camera));
        if (profile.ao) {
            const ao = new GTAOPass(scene, camera, size.width, size.height);
            // Radii are in metres: about a hand-span of contact darkening, fading out by ~1.5 m
            ao.updateGtaoMaterial({ radius: 1.2, thickness: 1.5, distanceExponent: 1.4, distanceFallOff: 1, scale: 1, samples: profile.aoSamples });
            ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
            ao.blendIntensity = 0.85;
            // AO is soft by nature: half resolution looks the same and costs a quarter
            const setAoSize = ao.setSize.bind(ao);
            ao.setSize = (w: number, h: number) => setAoSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
            // Decals that sit a few cm above the ground (the car's contact shadow) must not be part of the
            // AO depth: their edges read as steps and draw a dark outline. Objects tagged userData.noAO
            // are hidden while AO renders its depth and normals, like points and lines already are.
            const aoInternals = ao as unknown as { _overrideVisibility: () => void; _visibilityCache: Object3D[] };
            const hideBase = aoInternals._overrideVisibility.bind(ao);
            aoInternals._overrideVisibility = () => {
                hideBase();
                scene.traverse((o) => {
                    if (o.userData.noAO && o.visible) { o.visible = false; aoInternals._visibilityCache.push(o); }
                });
            };
            c.addPass(ao);
        }
        if (profile.bloom) c.addPass(new UnrealBloomPass(new Vector2(size.width, size.height), 0.1, 0.4, 0.95));
        c.addPass(new OutputPass());
        c.addPass(new ShaderPass(GradeShader));
        c.addPass(new SMAAPass());
        return c;
        // size changes are handled below without rebuilding the passes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gl, scene, camera, profile]);

    useEffect(() => {
        composer.setPixelRatio(gl.getPixelRatio());
        composer.setSize(size.width, size.height);
    }, [composer, size, gl, dpr]);

    useEffect(() => () => {
        for (const p of composer.passes) (p as { dispose?: () => void }).dispose?.();
        composer.dispose();
    }, [composer]);

    // Take over drawing the frame (priority 1 stops R3F's own render)
    useFrame((_, delta) => composer.render(delta), 1);

    return null;
}

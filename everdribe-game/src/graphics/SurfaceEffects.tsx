import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, CanvasTexture, NormalBlending, ShaderMaterial, TextureLoader } from 'three';
import type { Texture } from 'three';
import { assetUrl, hasAsset, TEXTURE_FILES } from '../assets/availability';

/** The dust puff sprite, or a soft round one drawn in code when `dust.png` is missing. */
function dustSprite(): Texture {
    if (hasAsset(TEXTURE_FILES.dust)) return new TextureLoader().load(assetUrl(TEXTURE_FILES.dust));
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
    g.addColorStop(0, 'rgba(150,145,140,0.75)');
    g.addColorStop(0.5, 'rgba(140,136,130,0.35)');
    g.addColorStop(1, 'rgba(130,126,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new CanvasTexture(c);
}
import { vehicleState } from '../stores/gameStore';

const MAX_PARTICLES = 420;

/**
 * Dust, tyre smoke and spray from the wheels:
 *  - dust (brown) when a wheel is on grass, dirt or the gravel shoulder, by speed;
 *  - tyre smoke (pale grey) when the tyres slide, on any surface;
 *  - spray (white) in water.
 * Particles start at the wheel's contact patch and drift with a share of the car's real velocity, so
 * they trail behind in whichever direction the car is actually moving (forwards or in reverse).
 * They are drawn with the soft Higgsfield dust sprite, start small, and fade out near the camera.
 */
export function SurfaceEffects() {
    const viewportHeight = useThree((s) => s.size.height * s.viewport.dpr);

    const state = useMemo(() => ({
        px: new Float32Array(MAX_PARTICLES * 3),
        vel: new Float32Array(MAX_PARTICLES * 3),
        life: new Float32Array(MAX_PARTICLES),
        maxLife: new Float32Array(MAX_PARTICLES),
        size: new Float32Array(MAX_PARTICLES),
        grow: new Float32Array(MAX_PARTICLES),
        alpha: new Float32Array(MAX_PARTICLES),
        peak: new Float32Array(MAX_PARTICLES),
        color: new Float32Array(MAX_PARTICLES * 3),
        next: 0,
        debt: [0, 0, 0, 0],
    }), []);

    const geometry = useMemo(() => {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(state.px, 3));
        g.setAttribute('aSize', new BufferAttribute(state.size, 1));
        g.setAttribute('aAlpha', new BufferAttribute(state.alpha, 1));
        g.setAttribute('aColor', new BufferAttribute(state.color, 3));
        return g;
    }, [state]);

    const material = useMemo(() => new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
        uniforms: {
            uViewportHeight: { value: 800 },
            uMap: { value: dustSprite() },
        },
        vertexShader: /* glsl */ `
            attribute float aSize;
            attribute float aAlpha;
            attribute vec3 aColor;
            uniform float uViewportHeight;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vColor = aColor;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mv;
                float dist = max(0.1, -mv.z);
                gl_PointSize = min(260.0, aSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / dist);
                // Fade particles that come right up to the lens instead of filling the screen
                vAlpha = aAlpha * smoothstep(1.5, 5.0, dist);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform sampler2D uMap;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vec4 t = texture2D(uMap, gl_PointCoord);
                float a = t.a * vAlpha;
                if (a < 0.01) discard;
                gl_FragColor = vec4(vColor * mix(0.75, 1.15, t.r), a);
                #include <colorspace_fragment>
            }
        `,
    }), []);

    useFrame((_s, rawDelta) => {
        const dt = Math.min(rawDelta, 0.05);
        material.uniforms.uViewportHeight.value = viewportHeight;
        const speed = vehicleState.speed;

        // ---- Spawn per wheel ----
        for (let w = 0; w < 4; w++) {
            const wheel = vehicleState.wheels[w];
            const rear = w >= 2;
            let rate = 0, kind = 0; // 1 dust, 2 smoke, 3 spray
            if (vehicleState.inWater || wheel.surface === 'water') {
                rate = Math.min(1, speed / 6) * 40; kind = 3;
            } else if (wheel.surface !== 'asphalt' && vehicleState.onGround) {
                const loose = wheel.surface === 'grass' ? 1 : 0.55;
                rate = loose * Math.min(1, speed / 12) * (rear ? 22 : 9); kind = 1;
            }
            const smoke = vehicleState.skid * Math.min(1, speed / 8) * (rear ? 30 : 12);
            if (smoke > rate && vehicleState.onGround && wheel.surface !== 'water') { rate = smoke; kind = 2; }
            if (rate <= 0.5) { state.debt[w] = 0; continue; }
            state.debt[w] += rate * dt;
            while (state.debt[w] >= 1) {
                state.debt[w] -= 1;
                const i = state.next;
                state.next = (state.next + 1) % MAX_PARTICLES;
                state.px[i * 3] = wheel.x + (Math.random() - 0.5) * 0.5;
                state.px[i * 3 + 1] = wheel.y + 0.15 + Math.random() * 0.15;
                state.px[i * 3 + 2] = wheel.z + (Math.random() - 0.5) * 0.5;
                // Left behind by the car: a little of its velocity, plus a lift and some scatter
                const carry = kind === 3 ? 0.35 : 0.18;
                state.vel[i * 3] = vehicleState.vx * carry + (Math.random() - 0.5) * 1.6;
                state.vel[i * 3 + 1] = (kind === 3 ? 2.5 : 0.6) + Math.random() * 1.0;
                state.vel[i * 3 + 2] = vehicleState.vz * carry + (Math.random() - 0.5) * 1.6;
                const life = kind === 2 ? 1.6 + Math.random() * 1.2 : kind === 3 ? 0.7 + Math.random() * 0.4 : 1.0 + Math.random() * 0.8;
                state.life[i] = life;
                state.maxLife[i] = life;
                state.size[i] = kind === 2 ? 0.6 + Math.random() * 0.4 : 0.35 + Math.random() * 0.3;
                state.grow[i] = kind === 2 ? 1.6 : 0.9;
                state.peak[i] = kind === 2 ? 0.45 : kind === 3 ? 0.55 : 0.35;
                const c = state.color;
                if (kind === 1) {
                    const t = 0.8 + Math.random() * 0.25;
                    c[i * 3] = 0.42 * t; c[i * 3 + 1] = 0.33 * t; c[i * 3 + 2] = 0.22 * t;
                } else if (kind === 2) {
                    const t = 0.75 + Math.random() * 0.15;
                    c[i * 3] = t; c[i * 3 + 1] = t; c[i * 3 + 2] = t * 1.02;
                } else {
                    c[i * 3] = 0.85; c[i * 3 + 1] = 0.92; c[i * 3 + 2] = 0.95;
                }
            }
        }

        // ---- Update ----
        for (let i = 0; i < MAX_PARTICLES; i++) {
            if (state.life[i] <= 0) { state.alpha[i] = 0; continue; }
            state.life[i] -= dt;
            const t = 1 - state.life[i] / state.maxLife[i]; // 0 new .. 1 gone
            const drag = Math.exp(-2.2 * dt);
            state.vel[i * 3] *= drag;
            state.vel[i * 3 + 2] *= drag;
            state.vel[i * 3 + 1] = state.vel[i * 3 + 1] * drag - 1.2 * dt;
            state.px[i * 3] += state.vel[i * 3] * dt;
            state.px[i * 3 + 1] += state.vel[i * 3 + 1] * dt;
            state.px[i * 3 + 2] += state.vel[i * 3 + 2] * dt;
            state.size[i] += state.grow[i] * dt;
            // Quick fade in, long fade out
            state.alpha[i] = state.peak[i] * Math.min(1, t * 8) * Math.pow(1 - t, 1.4);
        }

        (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
        (geometry.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
    });

    return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={20} />;
}

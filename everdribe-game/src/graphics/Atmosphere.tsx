import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
    BackSide, Color, Fog, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { useGameStore, TIME_PRESETS } from '../stores/gameStore';
import type { TimeOfDay } from '../stores/gameStore';
import { GRAPHICS } from './GraphicsProfile';
import { SunShadows } from './SunShadows';

/**
 * Sun, sky, fog and reflections for each time of day. The sun's shadows are cascaded (SunShadows.tsx):
 * sharp near the camera, wider and coarser further away.
 * The sky is also rendered once into an environment map, which is what the car paint and the
 * water reflect.
 */
interface Look {
    sunDir: [number, number, number];
    sun: string; sunIntensity: number;
    sky: string; ground: string; hemi: number;
    ambient: string; ambientIntensity: number;
    zenith: string; horizon: string; fog: string;
    fogNear: number; fogFar: number;
    exposure: number;
    /** Share of the sky covered by cloud (0 clear … 1 overcast). */
    clouds: number;
}

export const LOOKS: Record<TimeOfDay, Look> = {
    // Fill light (hemisphere + ambient) is kept low against the sun so shade under trees reads as shade;
    // the sky reflection map (scene.environment) adds the rest of the soft light.
    morning: {
        sunDir: [-0.55, 0.42, 0.72], sun: '#fff0d8', sunIntensity: 3.4,
        sky: '#d4e0ea', ground: '#5d7340', hemi: 0.4, ambient: '#eef2f6', ambientIntensity: 0.08,
        zenith: '#2f6fc8', horizon: '#c9dcec', fog: '#c6d6e4', fogNear: 220, fogFar: 1700, exposure: 0.92, clouds: 0.42,
    },
    noon: {
        sunDir: [0.35, 0.86, 0.36], sun: '#fff8ec', sunIntensity: 3.8,
        sky: '#d2e0ec', ground: '#61783f', hemi: 0.42, ambient: '#f4f6f8', ambientIntensity: 0.08,
        zenith: '#2466c4', horizon: '#c4dbee', fog: '#bfd4e6', fogNear: 260, fogFar: 1900, exposure: 0.9, clouds: 0.36,
    },
    golden: {
        sunDir: [0.42, 0.22, 0.88], sun: '#ffcf96', sunIntensity: 3.6,
        sky: '#ffdcba', ground: '#5c6a34', hemi: 0.38, ambient: '#ffe8d0', ambientIntensity: 0.08,
        zenith: '#4f84cc', horizon: '#f4c9a0', fog: '#ecd2b6', fogNear: 140, fogFar: 1400, exposure: 1.05, clouds: 0.48,
    },
    dusk: {
        sunDir: [-0.38, 0.07, 0.92], sun: '#ff9a62', sunIntensity: 2.4,
        sky: '#d79aa4', ground: '#3e4a2c', hemi: 0.4, ambient: '#a7a3cf', ambientIntensity: 0.14,
        zenith: '#30477d', horizon: '#f0a37c', fog: '#c99a8e', fogNear: 100, fogFar: 1100, exposure: 1.0, clouds: 0.55,
    },
};

// The four looks are keyframes on the clock; any hour between two of them blends their colours,
// light and fog, so the player can set the time with a slider
const KEYS = (Object.keys(TIME_PRESETS) as TimeOfDay[]).sort((a, b) => TIME_PRESETS[a] - TIME_PRESETS[b]);
const ca = new Color(), cb = new Color();
function mixHex(a: string, b: string, t: number) { return '#' + ca.set(a).lerp(cb.set(b), t).getHexString(); }

export function lookAt(hour: number): Look {
    const first = KEYS[0], last = KEYS[KEYS.length - 1];
    if (hour <= TIME_PRESETS[first]) return LOOKS[first];
    if (hour >= TIME_PRESETS[last]) return LOOKS[last];
    let i = 0;
    while (TIME_PRESETS[KEYS[i + 1]] < hour) i++;
    const a = LOOKS[KEYS[i]], b = LOOKS[KEYS[i + 1]];
    const t = (hour - TIME_PRESETS[KEYS[i]]) / (TIME_PRESETS[KEYS[i + 1]] - TIME_PRESETS[KEYS[i]]);
    const n = (x: number, y: number) => x + (y - x) * t;
    return {
        sunDir: [n(a.sunDir[0], b.sunDir[0]), n(a.sunDir[1], b.sunDir[1]), n(a.sunDir[2], b.sunDir[2])],
        sun: mixHex(a.sun, b.sun, t), sunIntensity: n(a.sunIntensity, b.sunIntensity),
        sky: mixHex(a.sky, b.sky, t), ground: mixHex(a.ground, b.ground, t), hemi: n(a.hemi, b.hemi),
        ambient: mixHex(a.ambient, b.ambient, t), ambientIntensity: n(a.ambientIntensity, b.ambientIntensity),
        zenith: mixHex(a.zenith, b.zenith, t), horizon: mixHex(a.horizon, b.horizon, t), fog: mixHex(a.fog, b.fog, t),
        fogNear: n(a.fogNear, b.fogNear), fogFar: n(a.fogFar, b.fogFar), exposure: n(a.exposure, b.exposure),
        clouds: n(a.clouds, b.clouds),
    };
}

function skyMaterial(): ShaderMaterial {
    return new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
            horizon: { value: new Color() },
            zenith: { value: new Color() },
            sunColor: { value: new Color() },
            sunDir: { value: new Vector3(0, 1, 0) },
            groundColor: { value: new Color() },
            groundMix: { value: 0 },
            cloudCover: { value: 0.4 },
            uTime: { value: 0 },
        },
        // Detail of the clouds (noise layers); set per quality level from GraphicsProfile
        defines: { CLOUD_OCTAVES: 5 },
        vertexShader: /* glsl */ `
            varying vec3 vDir;
            void main() {
                vDir = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 horizon;
            uniform vec3 zenith;
            uniform vec3 sunColor;
            uniform vec3 sunDir;
            uniform vec3 groundColor;
            uniform float groundMix;
            uniform float cloudCover;
            uniform float uTime;
            varying vec3 vDir;

            float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
            float vnoise(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                           mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
            }
            // Fractal noise: each layer half as strong, twice as fine and turned, so no grid shows
            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                mat2 r = mat2(1.6, 1.2, -1.2, 1.6);
                for (int i = 0; i < CLOUD_OCTAVES; i++) { v += a * vnoise(p); p = r * p; a *= 0.5; }
                return v;
            }

            void main() {
                vec3 d = normalize(vDir);
                float h = clamp(d.y, 0.0, 1.0);
                vec3 col = mix(horizon, zenith, pow(h, 0.42));
                // Bright, slightly milky band right at the horizon, as real air looks
                col = mix(col, horizon * 1.06, exp(-h * 22.0) * 0.6);
                float s = max(dot(d, normalize(sunDir)), 0.0);
                // Warm glow around the sun, brighter towards the horizon, and the disc itself
                col += sunColor * (pow(s, 8.0) * 0.35 + pow(s, 64.0) * 0.5) * (1.0 - h * 0.5);
                col += sunColor * smoothstep(0.9993, 0.9997, s) * 3.0;
                if (d.y < 0.0) {
                    // Below the horizon: plain haze for the visible sky dome, but for the reflection
                    // map a dark band of forest just under the horizon fading into road and ground,
                    // so glossy paint reflects the world around it and not a second sky
                    float b = clamp(-d.y, 0.0, 1.0);
                    vec3 trees = groundColor * 0.55;
                    vec3 below = mix(trees, groundColor * 0.9 + vec3(0.04), smoothstep(0.05, 0.5, b));
                    col = mix(horizon, below, groundMix * smoothstep(0.0, 0.025, b));
                } else {
                    // Clouds on a flat layer high above: squeezed towards the horizon, drifting slowly.
                    // Lit from the sun's side (a second noise sample a step towards the sun says how much
                    // cloud is in the way), with a bright rim around the sun and a grey-blue underside.
                    vec2 cp = d.xz / (d.y + 0.12) * 1.5 + vec2(uTime * 0.004, uTime * 0.0015);
                    float n = fbm(cp);
                    float cover = smoothstep(0.62 - cloudCover * 0.3, 0.86 - cloudCover * 0.15, n);
                    cover *= smoothstep(0.0, 0.16, d.y);
                    #if CLOUD_OCTAVES > 3
                        vec2 toSun = normalize(sunDir.xz + vec2(1e-4));
                        float shade = clamp(0.6 + (n - fbm(cp + toSun * 0.12)) * 3.0, 0.25, 1.0);
                    #else
                        float shade = 0.75;
                    #endif
                    vec3 under = mix(horizon, zenith, 0.25) * 0.72;
                    vec3 top = sunColor * 0.95 + horizon * 0.25;
                    vec3 cloud = mix(under, top, shade) + sunColor * pow(s, 10.0) * 0.5 * (1.0 - cover * 0.5);
                    // Far clouds sink into the horizon haze
                    cloud = mix(cloud, horizon * 1.04, exp(-d.y * 9.0) * 0.7);
                    col = mix(col, cloud, cover * 0.9);
                    // A ragged tree line rising a few degrees above the horizon (reflection map only)
                    float a = atan(d.z, d.x);
                    float line = 0.035 + 0.025 * sin(a * 23.0) * sin(a * 7.0 + 1.3) + 0.012 * sin(a * 61.0);
                    col = mix(col, groundColor * 0.5, groundMix * (1.0 - smoothstep(line - 0.008, line + 0.004, d.y)));
                }
                gl_FragColor = vec4(col, 1.0);
                #include <colorspace_fragment>
            }
        `,
    });
}

export function Atmosphere() {
    // Rounded to 5 minutes: each change rebuilds the reflection map, which is not free
    const hour = Math.round(useGameStore((s) => s.hour) * 12) / 12;
    const quality = useGameStore((s) => s.quality);
    const look = useMemo(() => lookAt(hour), [hour]);
    const { scene, gl } = useThree();
    const skyRef = useRef<Mesh>(null);
    const material = useMemo(skyMaterial, []);

    // Sky colours, fog and tone mapping exposure for the chosen time of day
    useEffect(() => {
        material.uniforms.horizon.value.set(look.horizon);
        material.uniforms.zenith.value.set(look.zenith);
        material.uniforms.sunColor.value.set(look.sun);
        material.uniforms.sunDir.value.set(...look.sunDir).normalize();
        material.uniforms.groundColor.value.set(look.ground);
        material.uniforms.cloudCover.value = look.clouds;
        scene.fog = new Fog(look.fog, look.fogNear, look.fogFar);
        scene.background = new Color(look.fog);
        gl.toneMappingExposure = look.exposure;

        // Environment map from the sky alone, for reflections on paint and water
        const pmrem = new PMREMGenerator(gl);
        const envScene = new Scene();
        const dome = new Mesh(new SphereGeometry(100, 64, 32), material);
        envScene.add(dome);
        material.uniforms.groundMix.value = 1;
        const env = pmrem.fromScene(envScene, 0.02).texture;
        material.uniforms.groundMix.value = 0;
        scene.environment = env;
        dome.geometry.dispose();
        pmrem.dispose();
        return () => { env.dispose(); };
    }, [look, material, scene, gl]);

    const profile = GRAPHICS[quality];
    const sunDir = look.sunDir;

    useEffect(() => {
        material.defines.CLOUD_OCTAVES = profile.cloudOctaves;
        material.needsUpdate = true;
    }, [material, profile]);

    useFrame(({ camera }, delta) => {
        skyRef.current?.position.copy(camera.position);
        material.uniforms.uTime.value += Math.min(delta, 0.1);
    });

    return (
        <>
            <ambientLight color={look.ambient} intensity={look.ambientIntensity} />
            <hemisphereLight color={look.sky} groundColor={look.ground} intensity={look.hemi} />
            {profile.shadows
                ? <SunShadows sunDir={sunDir} color={look.sun} intensity={look.sunIntensity} profile={profile} />
                : <directionalLight color={look.sun} intensity={look.sunIntensity} position={[sunDir[0] * 200, sunDir[1] * 200, sunDir[2] * 200]} />}
            <mesh ref={skyRef} material={material} renderOrder={-10} frustumCulled={false}>
                <sphereGeometry args={[2800, 32, 16]} />
            </mesh>
        </>
    );
}

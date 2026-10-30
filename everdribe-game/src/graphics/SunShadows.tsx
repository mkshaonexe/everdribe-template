import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, PCFShadowMap, Vector3 } from 'three';
import type { Material, Mesh, PerspectiveCamera, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import type { GraphicsProfile } from './GraphicsProfile';

/**
 * The sun, with cascaded shadows (CSM).
 *
 * One shadow map around the car had to cover ~170 m, so each shadow pixel was ~4 cm; seen from the chase
 * camera a few metres away that is ~13 screen pixels, which is why the car's shadow had stair-stepped
 * edges. Cascades split the view by distance: a small, sharp map right around the camera (the car and
 * the road in front), wider and coarser maps further out (trees on the hills). Each cascade is snapped
 * to whole shadow texels, and neighbouring cascades fade into each other.
 *
 * CSM shades with its own lighting code, so every lit material must be registered with it. Materials
 * appear over time (terrain chunks, scenery, the car), so the scene is checked twice a second and new
 * ones are registered; their own onBeforeCompile (terrain splat, car paint, foliage) is kept and runs first.
 */
type Hook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

/**
 * Objects on this layer are drawn into the shadow maps only, never into the picture or the AO pass.
 * Trees cast their shadow from their light (distant) version on this layer: about a sixth of the
 * triangles of the full tree, drawn once per cascade, and the dappled shadow looks the same.
 */
export const SHADOW_ONLY_LAYER = 1;
/** Materials that use scene lights (and so must use the cascade lighting code). */
const LIT = (m: Material) => (m as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial
    || (m as { isMeshLambertMaterial?: boolean }).isMeshLambertMaterial
    || (m as { isMeshPhongMaterial?: boolean }).isMeshPhongMaterial;

export function SunShadows({ sunDir, color, intensity, profile }: {
    sunDir: [number, number, number]; color: string; intensity: number; profile: GraphicsProfile;
}) {
    const { scene, camera, gl } = useThree();
    const registered = useRef(new Map<Material, Hook>());

    // Created in an effect, not useMemo: React's development double-render would otherwise leave a
    // second, orphaned set of cascade lights in the scene (the picture turned white)
    const [csm, setCsm] = useState<CSM | null>(null);
    useEffect(() => {
        gl.shadowMap.enabled = true;
        gl.shadowMap.type = PCFShadowMap;
        const c = new CSM({
            camera: camera as PerspectiveCamera,
            parent: scene,
            cascades: profile.shadowCascades,
            maxFar: profile.shadowFar,
            // Hand-set splits (fractions of shadowFar): the first cascade ends ~12 m from the camera, so
            // the car and the road just ahead get ~1 cm shadow texels; the rest share the distance
            mode: 'custom',
            customSplitsCallback: (n: number, _near: number, far: number, breaks: number[]) => {
                const first = Math.min(0.2, 12 / far);
                for (let i = 1; i < n; i++) breaks.push(first * Math.pow(1 / first, (i - 1) / (n - 1)));
                breaks.push(1);
            },
            shadowMapSize: profile.shadowMapSize,
            lightDirection: new Vector3(0, -1, 0),
            lightIntensity: 1,
            lightNear: 1,
            lightFar: 900,
            lightMargin: 150,   // casters up to 150 m towards the sun (trees on a slope) still cast
        });
        c.fade = true;
        // Shadow maps are drawn once per frame (see useFrame below), not on every scene render: the AO
        // pass renders the scene a second time, and with automatic updates every cascade was drawn twice
        gl.shadowMap.autoUpdate = false;
        for (const l of c.lights) {
            l.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
            l.shadow.bias = -0.0002;
            l.shadow.normalBias = 0.03;
            l.shadow.radius = 2.5;
        }
        const reg = registered.current;
        setCsm(c);
        // Undo the registration when this cascade set goes away (quality change, unmount).
        // CSM.dispose() deletes every registered material's onBeforeCompile, and with it the material's own
        // hook (terrain splat, foliage, car paint). So dispose first, then put the original hooks back.
        // The other order left the ground without its textures after a quality change: its shaders then
        // read whatever texture was bound (a shadow map), and grass turned red, white or black.
        return () => {
            c.remove();
            c.dispose();
            for (const [m, prev] of reg) {
                delete m.defines?.USE_CSM; delete m.defines?.CSM_CASCADES; delete m.defines?.CSM_FADE;
                m.onBeforeCompile = prev;
                m.needsUpdate = true;
            }
            reg.clear();
            gl.shadowMap.autoUpdate = true;
            setCsm(null);
        };
    }, [scene, camera, gl, profile]);

    // Sun direction, colour and strength for the time of day
    const col = useMemo(() => new Color(), []);
    useEffect(() => {
        if (!csm) return;
        csm.lightDirection.set(-sunDir[0], -sunDir[1], -sunDir[2]).normalize();
        col.set(color);
        for (const l of csm.lights) { l.color.copy(col); l.intensity = intensity; }
    }, [csm, sunDir, color, intensity, col]);

    const lastScan = useRef(0);
    const fov = useRef({ fov: 0, aspect: 0 });
    useFrame((state) => {
        if (!csm) return;
        const cam = state.camera as PerspectiveCamera;
        if (cam.fov !== fov.current.fov || cam.aspect !== fov.current.aspect) {
            fov.current = { fov: cam.fov, aspect: cam.aspect };
            csm.updateFrustums();
        }
        if (state.clock.elapsedTime - lastScan.current > 0.5) {
            lastScan.current = state.clock.elapsedTime;
            const reg = registered.current;
            scene.traverse((o) => {
                const mesh = o as Mesh;
                if (!mesh.isMesh) return;
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const m of mats) {
                    if (!m || reg.has(m) || !LIT(m)) continue;
                    const prev = m.onBeforeCompile;
                    csm.setupMaterial(m);
                    const csmHook = m.onBeforeCompile;
                    m.onBeforeCompile = function (shader, renderer) {
                        prev.call(this, shader, renderer);
                        csmHook.call(this, shader, renderer);
                    };
                    m.needsUpdate = true;
                    reg.set(m, prev);
                }
            });
        }
        csm.update();
        // The first scene render this frame (PostProcessing's RenderPass) draws the maps and clears the flag
        gl.shadowMap.needsUpdate = true;
    });

    return null;
}

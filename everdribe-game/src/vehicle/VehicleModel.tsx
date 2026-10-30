import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { Box3, Color, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { VehicleConfig } from '../stores/gameStore';
import { assetUrl, hasAsset } from '../assets/availability';
import { CAR } from '../assets.config';
import { buildProceduralCar } from './ProceduralCar';

export interface CarModelInfo {
    object: Object3D;
    length: number;
    width: number;
    height: number;
    brakeMaterial: MeshStandardMaterial;
    tailY: number;      // height of the tail lights above the ground
}

/**
 * The car body. With its GLB present (see assets.config.ts) the model is auto-fitted; without it a coupe is
 * built in code. Whether the file is there is known before the scene mounts and does not change while the
 * page is open, so the same hook runs on every render.
 */
export function useCarModel(config: VehicleConfig): CarModelInfo {
    const useCar = hasAsset(config.path) ? useGltfCarModel : useProceduralCarModel;
    return useCar(config);
}

function useProceduralCarModel(config: VehicleConfig): CarModelInfo {
    return useMemo(() => {
        const holder = buildProceduralCar(config.length, CAR.paintColor ?? CAR.fallbackColor, CAR.yOffset);
        return finish(holder);
    }, [config]);
}

/** Box of the fitted car, and the brake light strip sized to it. */
function finish(holder: Object3D): CarModelInfo {
    holder.updateMatrixWorld(true);
    const s2 = new Box3().setFromObject(holder).getSize(new Vector3());
    const brakeMaterial = new MeshStandardMaterial({ color: '#330000', emissive: '#ff1a1a', emissiveIntensity: 0, transparent: true, opacity: 0 });
    return { object: holder, length: s2.z, width: s2.x, height: s2.y, brakeMaterial, tailY: s2.y * 0.6 };
}

/**
 * The car from a GLB, fitted whatever its source: turned by the configured yaw so the nose points down -Z
 * (the physics' forward), scaled so its longest side is the configured length, centred, and lifted so its
 * lowest point sits at CAR.yOffset (the tyres touch y = 0). A thin glowing strip across the tail lights
 * brightens when braking.
 */
function useGltfCarModel(config: VehicleConfig): CarModelInfo {
    const gltf = useGLTF(assetUrl(config.path));
    return useMemo(() => {
        const root = gltf.scene.clone(true);
        root.rotation.y = config.yawOffset;
        root.updateMatrixWorld(true);
        const box = new Box3().setFromObject(root);
        const size = box.getSize(new Vector3());
        const scale = config.length / Math.max(size.x, size.z);
        const holder = new Object3D();
        holder.add(root);
        root.scale.setScalar(scale);
        root.updateMatrixWorld(true);
        const box2 = new Box3().setFromObject(root);
        const centre = box2.getCenter(new Vector3());
        root.position.set(-centre.x, -box2.min.y + CAR.yOffset, -centre.z);
        const paintOverride = CAR.paintColor ? { value: new Color(CAR.paintColor) } : null;

        root.traverse((o) => {
            const m = o as Mesh;
            if (!m.isMesh) return;
            m.castShadow = true;
            m.receiveShadow = true;
            const mat = m.material as MeshStandardMaterial;
            if (!mat || !('envMapIntensity' in mat)) return;
            // Car paint. The generated metal/roughness map is patchy (random metal islands across the
            // body), which made the paint look wavy and blotchy. The shader below finds the painted
            // areas by their colour (paint is the only saturated colour on this car) and gives them one
            // even lacquer: smooth base, light metallic flake and a full clear coat. Glass, tyres and
            // trim keep their own roughness, lose most of the fake metal, and get only a thin coat.
            const paint = new MeshPhysicalMaterial();
            MeshStandardMaterial.prototype.copy.call(paint, mat);
            paint.defines = { STANDARD: '', PHYSICAL: '' };   // the standard copy() drops the physical shader switch
            paint.clearcoat = 1;
            paint.clearcoatRoughness = 0.06;
            paint.envMapIntensity = 1.15;
            paint.normalScale.set(0.45, 0.45);                // generated creases: keep, but softer
            paint.onBeforeCompile = (shader) => {
                if (paintOverride) {
                    shader.uniforms.uPaintColor = paintOverride;
                    shader.fragmentShader = 'uniform vec3 uPaintColor;\n' + shader.fragmentShader;
                }
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
                        vec3 bc = diffuseColor.rgb;
                        float sat = max(bc.r, max(bc.g, bc.b)) - min(bc.r, min(bc.g, bc.b));
                        float paintMask = smoothstep(0.035, 0.11, sat);
                        float lum = dot(bc, vec3(0.2126, 0.7152, 0.0722));
                        metalnessFactor = mix(metalnessFactor * smoothstep(0.25, 0.6, lum), 0.32, paintMask);
                        roughnessFactor = mix(clamp(roughnessFactor, 0.42, 0.9), 0.3, paintMask);${paintOverride ? `
                        diffuseColor.rgb = mix(diffuseColor.rgb, uPaintColor * (0.4 + 1.6 * lum), paintMask);` : ''}`)
                    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
                        material.clearcoat *= mix(0.08, 1.0, paintMask);`);
            };
            paint.customProgramCacheKey = () => (paintOverride ? 'everdribe-car-paint-recolour' : 'everdribe-car-paint');
            // Keep the textures sharp when seen at a low angle from the chase camera
            for (const t of [paint.map, paint.normalMap, paint.roughnessMap, paint.metalnessMap]) {
                if (t) { t.anisotropy = 16; t.needsUpdate = true; }
            }
            m.material = paint;
        });
        return finish(holder);
    }, [gltf, config]);
}

export function VehicleModel({ info, braking }: { info: CarModelInfo; braking?: number }) {
    const b = braking ?? 0;
    info.brakeMaterial.emissiveIntensity = b * 3;
    info.brakeMaterial.opacity = b * 0.9;
    return (
        <group>
            <primitive object={info.object} />
            {/* Brake light strip just behind the tail */}
            <mesh position={[0, info.tailY, info.length / 2 + 0.02]} material={info.brakeMaterial}>
                <planeGeometry args={[info.width * 0.78, 0.07]} />
            </mesh>
        </group>
    );
}

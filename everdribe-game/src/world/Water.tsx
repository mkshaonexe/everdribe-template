import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CanvasTexture, Color, Mesh, MeshPhysicalMaterial, RepeatWrapping, Vector2 } from 'three';
import { WATER_LEVEL } from './WorldGen';

/** A tiling normal map of soft ripples, drawn once from overlapping sine waves. */
function rippleNormals(): CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const waves = [[3, 2, 0.4], [5, -4, 0.25], [-7, 6, 0.18], [11, 9, 0.1], [-13, 4, 0.08]];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let dx = 0, dy = 0;
            for (const [kx, ky, a] of waves) {
                const ph = (2 * Math.PI * (kx * x + ky * y)) / size;
                dx += a * kx * Math.cos(ph) * 0.12;
                dy += a * ky * Math.cos(ph) * 0.12;
            }
            const i = (y * size + x) * 4;
            img.data[i] = 128 + dx * 60;
            img.data[i + 1] = 128 + dy * 60;
            img.data[i + 2] = 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(220, 220);
    return tex;
}

/**
 * One flat water sheet at the world's water level, following the camera. It only shows where the
 * land dips below that level: rivers, ponds and the gaps under bridges. The ripples drift slowly.
 */
export function Water() {
    const ref = useRef<Mesh>(null);
    const normalMap = useMemo(rippleNormals, []);
    const material = useMemo(() => new MeshPhysicalMaterial({
        color: new Color('#1d4f57'),
        roughness: 0.28,
        metalness: 0,
        transmission: 0,
        transparent: true,
        opacity: 0.9,
        normalMap,
        normalScale: new Vector2(0.45, 0.45),
        clearcoat: 0.35,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.45,
    }), [normalMap]);

    useFrame(({ camera, clock }) => {
        const m = ref.current;
        if (!m) return;
        // Snap to a 50 m grid so the ripples do not slide with the camera
        m.position.set(Math.round(camera.position.x / 50) * 50, WATER_LEVEL, Math.round(camera.position.z / 50) * 50);
        const t = clock.elapsedTime;
        normalMap.offset.set((m.position.x / 4000) * 220 + t * 0.01, (-m.position.z / 4000) * 220 + t * 0.006);
    });

    return (
        <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} material={material} renderOrder={5} receiveShadow>
            <planeGeometry args={[4000, 4000, 1, 1]} />
        </mesh>
    );
}

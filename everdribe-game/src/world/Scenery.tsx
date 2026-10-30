import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, useTexture } from '@react-three/drei';
import type { Texture } from 'three';
import { Box3, BufferGeometry, InstancedMesh, Material, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import {
    cellProps, farmProps, hasGuardrail, road, roadHeading, PROP_CELL, ROAD_HALF_TOTAL, ROAD_STEP,
} from './WorldGen';
import type { Prop, PropKind } from './WorldGen';
import { setCircleColliders } from './Colliders';
import type { CircleCollider } from './Colliders';
import { playerPose, useGameStore } from '../stores/gameStore';
import { GRAPHICS } from '../graphics/GraphicsProfile';
import { foliageUniforms, makeFoliage } from '../graphics/Foliage';
import { buildTree, getBarkAtlas, makeLeafAtlas, setupLeafAtlas, CROWN_HEIGHT } from './TreeFactory';
import { standIn } from './PropStandIns';
import { assetUrl, hasAsset, MODEL_FILES, TEXTURE_FILES } from '../assets/availability';
import { SHADOW_ONLY_LAYER } from '../graphics/SunShadows';
import { inViewCone, viewConeChanged } from '../graphics/ViewCone';
import type { ViewCone } from '../graphics/ViewCone';
import type { Species } from './TreeFactory';

/**
 * Trees and shrubs are grown in code (TreeFactory): each kind is a species with VARIANTS different
 * trees, each in a full, a light (distant) and a far version. Each tree picks its variant from its position.
 * `capacity`: full and light lists (within sceneryRadius); `far`: the far list (out to treeRadius).
 * Shrubs are not drawn past sceneryRadius: from that far they are a few pixels under the trees.
 */
const VARIANTS = 4;
const TREES: Partial<Record<PropKind, { species: Species; capacity: number; far: number; sway: number }>> = {
    treeGreen: { species: 'broadleaf', capacity: 3200, far: 9000, sway: 0.12 },
    treeAutumn: { species: 'autumn', capacity: 1800, far: 5000, sway: 0.12 },
    birch: { species: 'birch', capacity: 2000, far: 6000, sway: 0.1 },
    pine: { species: 'pine', capacity: 3200, far: 9000, sway: 0.06 },
    bush: { species: 'shrub', capacity: 2400, far: 0, sway: 0.5 },
};

/**
 * Everything else is a Higgsfield model, sized here. Tripo exports every model fitted in a unit box,
 * so each gets a real size: `height` scales by height, `length` by its longest side.
 * A missing file is replaced by a stand-in of the same size (PropStandIns); a missing LOD file by the
 * main model (or its stand-in).
 */
const MODELS: Partial<Record<PropKind, {
    file: string; lod?: string; height?: number; length?: number; capacity: number; shadow: boolean; alongRoad?: boolean;
}>> = {
    rock: { file: MODEL_FILES.rock, lod: MODEL_FILES.rockLod, height: 1.4, capacity: 500, shadow: true },
    house: { file: MODEL_FILES.house, height: 7.5, capacity: 12, shadow: true },
    barn: { file: MODEL_FILES.barn, height: 9, capacity: 12, shadow: true },
    fence: { file: MODEL_FILES.fence, length: 4.1, capacity: 400, shadow: false, alongRoad: true },
    guardrail: { file: MODEL_FILES.guardrail, length: 4.1, capacity: 1200, shadow: true, alongRoad: true },
};
const MODEL_LIST = Object.keys(MODELS) as PropKind[];
const TREE_LIST = Object.keys(TREES) as PropKind[];

/** The scenery GLB files that are there (asset check done before the scene mounts), in a fixed order. */
function presentSceneryFiles(): string[] {
    const files = MODEL_LIST.flatMap((k) => [MODELS[k]!.file, MODELS[k]!.lod]).filter((f): f is string => !!f && hasAsset(f));
    return [...new Set(files)].map(assetUrl);
}

/** The leaf atlas photo when it is there, else one drawn in code (same 2 x 2 layout). Fixed for the page's life. */
function useLeafPhoto(): Texture { return useTexture(assetUrl(TEXTURE_FILES.leaves)); }
function useDrawnLeaves(): Texture { return useMemo(() => makeLeafAtlas(), []); }

const REBUILD_DISTANCE = 30;  // rebuild the instance lists after moving this far
const COLLIDER_RADIUS = 140;

/** Pull the single mesh out of a Tripo GLB, sized and sitting on y = 0. */
function prepare(scene: Object3D, kind: PropKind): { geometry: BufferGeometry; material: Material } {
    let mesh: Mesh | null = null;
    scene.traverse((o) => { if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh; });
    if (!mesh) throw new Error('No mesh in model for ' + kind);
    const m = mesh as Mesh;
    m.updateWorldMatrix(true, false);
    const geometry = (m.geometry as BufferGeometry).clone();
    geometry.applyMatrix4(m.matrixWorld);
    const box = new Box3().setFromBufferAttribute(geometry.attributes.position as never);
    const size = box.getSize(new Vector3());
    const spec = MODELS[kind]!;
    const scale = spec.height ? spec.height / size.y : spec.length! / Math.max(size.x, size.z);
    const centre = box.getCenter(new Vector3());
    geometry.translate(-centre.x, -box.min.y, -centre.z);
    geometry.scale(scale, scale, scale);
    // Long props: make sure their long side runs along local X
    if (spec.length && size.z > size.x) geometry.rotateY(Math.PI / 2);
    geometry.computeBoundingSphere();
    // Stone, timber and galvanised steel: matte, with only a faint sky reflection
    const std = m.material as MeshStandardMaterial;
    std.envMapIntensity = kind === 'guardrail' ? 0.6 : 0.5;
    if (kind === 'guardrail') { std.metalness = 0.25; std.roughness = 0.5; }
    if (std.map) std.map.anisotropy = 8;
    return { geometry, material: std };
}

/**
 * One instanced draw list: a model or tree variant at one level of detail.
 * `shadowOnly` lists are drawn into the shadow maps only (the light tree version standing in for the
 * full one); `noAO` lists are left out of the AO pass (distant trees, where contact shading is invisible).
 */
interface Slot {
    key: string; geometry: BufferGeometry; material: Material | Material[]; capacity: number; shadow: boolean;
    shadowOnly?: boolean; noAO?: boolean; noReceive?: boolean;
}

/** Which variant a tree at (x, z) uses: stable, and spread evenly. */
const variantAt = (x: number, z: number) => {
    const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return Math.floor((h - Math.floor(h)) * VARIANTS);
};

/** A second stable random number per tree (0..1), independent of its variant. */
const thinAt = (x: number, z: number) => {
    const h = Math.sin(x * 37.719 + z * 91.137) * 24634.6345;
    return h - Math.floor(h);
};

const cellCache = new Map<number, Prop[]>();
const farmCache = new Map<number, Prop[]>();
const cellKey = (cx: number, cz: number) => cx * 100003 + cz;

export function Scenery() {
    const meshesRef = useRef(new Map<string, InstancedMesh>());
    const lastBuild = useRef<ViewCone>({ x: Infinity, z: Infinity, fx: 0, fz: 0, all: true });
    const quality = useGameStore((s) => s.quality);
    const camera = useThree((s) => s.camera);

    // Load the models that are there (Suspense shows the loading screen until they are ready)
    const files = useMemo(() => presentSceneryFiles(), []);
    const gltfs = useGLTF(files) as unknown as { scene: Object3D }[];
    const useLeaves = hasAsset(TEXTURE_FILES.leaves) ? useLeafPhoto : useDrawnLeaves;
    const leafAtlas = useLeaves();
    const slots = useMemo(() => {
        const out: Slot[] = [];
        const load = (file: string | undefined, k: PropKind) => {
            const i = file && hasAsset(file) ? files.indexOf(assetUrl(file)) : -1;
            return i >= 0 ? prepare(gltfs[i].scene, k) : null;
        };
        MODEL_LIST.forEach((k) => {
            const spec = MODELS[k]!;
            const hi = load(spec.file, k) ?? standIn(k)!;
            out.push({ key: `h:${k}`, geometry: hi.geometry, material: hi.material, capacity: spec.capacity, shadow: spec.shadow });
            if (spec.lod) {
                const lo = load(spec.lod, k) ?? hi;
                out.push({ key: `l:${k}`, geometry: lo.geometry, material: lo.material, capacity: spec.capacity, shadow: false });
            }
        });
        // Grow the trees: VARIANTS per species, full and light versions sharing bark and leaf materials
        const leaves = setupLeafAtlas(leafAtlas), bark = getBarkAtlas();
        for (const k of TREE_LIST) {
            const t = TREES[k]!;
            const crown = CROWN_HEIGHT[t.species];
            const mats = [
                makeFoliage({ map: bark, crown, sway: t.sway, leaf: false, msaa: true }),
                makeFoliage({ map: leaves, crown, sway: t.sway, leaf: true, msaa: true }),
            ];
            // Far trees stand past the reach of the sun's shadow maps and are a few dozen pixels tall: they skip
            // receiving shadows and the feathered (alpha to coverage) leaf edges. Measured on the M4 (1374 x 950):
            // the far woods' leaf cards cost ~6 FPS, their bark nothing; thinning them with distance (below) did
            // most to win it back, these cheaper materials only a little
            const farMats = [
                makeFoliage({ map: bark, crown, sway: t.sway, leaf: false, msaa: false, distanceFade: true }),
                makeFoliage({ map: leaves, crown, sway: t.sway, leaf: true, msaa: false, distanceFade: true }),
            ];
            const per = Math.ceil((t.capacity / VARIANTS) * 1.6);
            for (let v = 0; v < VARIANTS; v++) {
                const light = buildTree(t.species, v + 1, true).geometry;
                // Trees stay out of the AO pass: AO drew every near tree a second time (its normal pass cannot
                // read the leaf cut-outs, so leaves came out as dark squares anyway); the sun shadows and the
                // root flare already ground them. Measured: AO's extra pass was ~1.5 M triangles per frame.
                out.push({ key: `h:${k}:${v}`, geometry: buildTree(t.species, v + 1, false).geometry, material: mats, capacity: per, shadow: false, noAO: true });
                out.push({ key: `l:${k}:${v}`, geometry: light, material: mats, capacity: per, shadow: false, noAO: true });
                if (t.far) {
                    const far = buildTree(t.species, v + 1, true, false, true).geometry;
                    out.push({
                        key: `f:${k}:${v}`, geometry: far, material: farMats, capacity: Math.ceil((t.far / VARIANTS) * 1.6),
                        shadow: false, noAO: true, noReceive: true,
                    });
                }
                // The shadow copy has its cards pulled into the crown (TreeFactory), so the sunny side stays lit
                const caster = buildTree(t.species, v + 1, true, true).geometry;
                out.push({ key: `s:${k}:${v}`, geometry: caster, material: mats, capacity: per, shadow: true, shadowOnly: true });
            }
        }
        return out;
    }, [gltfs, files, leafAtlas]);

    useEffect(() => { lastBuild.current = { x: Infinity, z: Infinity, fx: 0, fz: 0, all: true }; }, [quality, slots]);

    const m4 = useMemo(() => new Matrix4(), []);
    const q = useMemo(() => new Quaternion(), []);
    const up = useMemo(() => new Vector3(0, 1, 0), []);
    const pos = useMemo(() => new Vector3(), []);
    const scl = useMemo(() => new Vector3(), []);

    useFrame((_, delta) => {
        foliageUniforms.uTime.value += Math.min(delta, 0.1);
        foliageUniforms.uMotion.value = GRAPHICS[quality].foliageMotion ? 1 : 0;
        const px = playerPose.x, pz = playerPose.z;
        foliageUniforms.uCentre.value.set(px, pz);
        foliageUniforms.uTreeRadius.value = GRAPHICS[quality].treeRadius;
        // Rebuild after moving 30 m, or when the camera turns: trees behind the camera are not drawn
        // (their shadow copies still are), which halves the tree triangles sent to the GPU
        if (!viewConeChanged(lastBuild.current, camera, px, pz, REBUILD_DISTANCE)) return;
        const cone = lastBuild.current;

        const radius = GRAPHICS[quality].sceneryRadius;
        const detail = GRAPHICS[quality].detailRadius;
        // Tree reach is independent of scenery (Ultra scenery extends past the tree budget).
        const treeR = GRAPHICS[quality].treeRadius;
        // Buffer the next rebuild: shader-hidden trees can enter the fade smoothly while driving.
        const treeGatherR = treeR + REBUILD_DISTANCE;
        const gatherR = Math.max(radius, treeGatherR);
        const lightR = GRAPHICS[quality].lightRadius;
        // Trees cast shadows a little past the shadow distance, so a shadow never pops in at its edge
        const shadowR = GRAPHICS[quality].shadows ? GRAPHICS[quality].shadowFar + 20 : 0;
        road.ensureZ(pz - gatherR, pz + gatherR);

        // ---- Gather scenery and a motion margin around the tree radius ----
        const props: Prop[] = [];
        const c0x = Math.floor((px - gatherR) / PROP_CELL), c1x = Math.floor((px + gatherR) / PROP_CELL);
        const c0z = Math.floor((pz - gatherR) / PROP_CELL), c1z = Math.floor((pz + gatherR) / PROP_CELL);
        const keep = new Set<number>();
        // A cell's props reach up to ~34 m from its centre: keep cells whose corner may still be in range
        const cellR = gatherR + PROP_CELL * 0.71;
        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cz = c0z; cz <= c1z; cz++) {
                const mx = (cx + 0.5) * PROP_CELL - px, mz = (cz + 0.5) * PROP_CELL - pz;
                if (mx * mx + mz * mz > cellR * cellR) continue;
                const md2 = mx * mx + mz * mz;
                const key = cellKey(cx, cz);
                keep.add(key);
                // Far cells behind the camera are not needed now (their trees would not be drawn), but stay
                // cached for when the camera turns
                if (md2 > (radius + PROP_CELL) ** 2 && !inViewCone(cone, mx, mz, md2)) continue;
                let list = cellCache.get(key);
                if (!list) { list = cellProps(cx, cz); cellCache.set(key, list); }
                for (const p of list) props.push(p);
            }
        }
        for (const key of cellCache.keys()) if (!keep.has(key)) cellCache.delete(key);

        const ci = road.nearestIndex(px, pz);
        const sCar = ci * ROAD_STEP;
        for (let b = Math.floor((sCar - 1200) / 600); b <= Math.floor((sCar + 1200) / 600); b++) {
            let list = farmCache.get(b);
            if (!list) { list = farmProps(b); farmCache.set(b, list); }
            for (const p of list) props.push(p);
        }

        // Guardrail sections every 4 m (two road samples) along the edges near the car
        const span = Math.floor(radius / ROAD_STEP);
        for (let i = (ci - span) & ~1; i < ci + span; i += 2) {
            for (const side of [-1, 1]) {
                if (!hasGuardrail(i, side)) continue;
                const s = (i + 1) * ROAD_STEP;
                const p = road.at(s);
                const off = ROAD_HALF_TOTAL - 0.2;
                props.push({
                    kind: 'guardrail', x: p.x + p.tz * side * off, y: p.y - 0.05, z: p.z - p.tx * side * off,
                    rot: roadHeading(s), scale: 1, radius: 0,
                });
            }
        }

        // ---- Fill the instance buffers ----
        const meshes = meshesRef.current;
        const counts = new Map<string, number>();
        for (const sl of slots) counts.set(sl.key, 0);
        const colliders: CircleCollider[] = [];
        for (const p of props) {
            const ddx = p.x - px, ddz = p.z - pz;
            const d2 = ddx * ddx + ddz * ddz;
            const tree = TREES[p.kind];
            if (tree?.far && d2 > treeGatherR * treeGatherR) continue;
            if (d2 > radius * radius && (!tree || !tree.far || d2 > treeGatherR * treeGatherR)) continue;
            const beyond = !!tree?.far && d2 > lightR * lightR;
            // Far woods thin out with distance, down to half the trees at the edge: each far tree's leaf cards cost
            // their pixels in full (cut-out leaves defeat the GPU's hidden-surface removal), and the darker
            // ground under woods (TerrainWorker) fills in between them. Gradual, so no line where trees vanish
            if (beyond && thinAt(p.x, p.z) < 0.5 * Math.min(1, (Math.sqrt(d2) - lightR) / (treeR - lightR))) continue;
            // Colliders do not depend on what is drawn (G10): the same trees block the car on every setting
            if (p.radius > 0 && d2 < COLLIDER_RADIUS * COLLIDER_RADIUS) {
                colliders.push({ x: p.x, z: p.z, r: p.radius, kind: p.kind });
            }
            const model = MODELS[p.kind];
            const near = d2 < detail * detail || (model && !model.lod);
            const lod = near ? 'h' : beyond ? 'f' : 'l';
            const key = tree ? `${lod}:${p.kind}:${variantAt(p.x, p.z)}` : `${lod}:${p.kind}`;
            const mesh = meshes.get(key);
            const n = counts.get(key) ?? 0;
            const visible = !tree || inViewCone(cone, ddx, ddz, d2);
            const castsShadow = tree && d2 < shadowR * shadowR;
            if (!visible && !castsShadow) continue;
            // Long props are modelled along X; turn X onto the road direction (heading h -> yaw h - π/2)
            const yaw = model?.alongRoad ? p.rot - Math.PI / 2 : p.rot;
            q.setFromAxisAngle(up, yaw);
            // Trees grow from 0.6 m under the ground already; models sit on it
            pos.set(p.x, p.y - (p.kind === 'rock' ? 0.25 * p.scale : tree ? 0 : 0.05), p.z);
            scl.setScalar(p.scale);
            m4.compose(pos, q, scl);
            if (visible && mesh && n < mesh.instanceMatrix.count) {
                mesh.setMatrixAt(n, m4);
                counts.set(key, n + 1);
            }
            if (castsShadow) {
                const sKey = `s:${p.kind}:${variantAt(p.x, p.z)}`;
                const sMesh = meshes.get(sKey), sn = counts.get(sKey) ?? 0;
                if (sMesh && sn < sMesh.instanceMatrix.count) { sMesh.setMatrixAt(sn, m4); counts.set(sKey, sn + 1); }
            }
        }
        for (const [key, mesh] of meshes) {
            const n = counts.get(key) ?? 0;
            const changed = n > 0 || mesh.count > 0;
            mesh.count = n;
            if (!changed) continue;
            // Upload only the matrices in use, not the whole buffer (all lists together hold ~2.5 MB)
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
            mesh.instanceMatrix.needsUpdate = true;
        }
        setCircleColliders(colliders);
    });

    return (
        <group>
            {slots.map((sl) => (
                <instancedMesh
                    key={sl.key}
                    ref={(m) => {
                        if (m) {
                            meshesRef.current.set(sl.key, m);
                            if (!m.userData.ready) { m.count = 0; m.userData.ready = true; }
                            if (sl.shadowOnly) m.layers.set(SHADOW_ONLY_LAYER);
                            if (sl.noAO) m.userData.noAO = true;
                        } else meshesRef.current.delete(sl.key);
                    }}
                    args={[sl.geometry, sl.material, sl.capacity]}
                    castShadow={sl.shadow && GRAPHICS[quality].shadows}
                    receiveShadow={!sl.noReceive}
                    frustumCulled={false}
                />
            ))}
        </group>
    );
}

import {
    BoxGeometry, BufferAttribute, Color, CylinderGeometry, ExtrudeGeometry, IcosahedronGeometry, MeshStandardMaterial, Shape,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropKind } from './WorldGen';

/**
 * Stand-ins from simple shapes for scenery models that are missing from `public/assets/models/`. Each has
 * the size the real model gets in Scenery (same frame: sitting on y = 0, centred, long props along X), so
 * placement and colliders (which come from WorldGen, not the model) are unchanged.
 * Parts carry their colour as a vertex colour, so each prop is still one geometry and one material.
 */

type Part = { g: BufferGeometry; color: string };

function merge(parts: Part[]): BufferGeometry {
    const geos = parts.map(({ g, color }) => {
        const n = g.index ? g.toNonIndexed() : g;
        n.deleteAttribute('uv');
        const c = new Color(color);
        const count = n.attributes.position.count;
        const arr = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
        n.setAttribute('color', new BufferAttribute(arr, 3));
        return n;
    });
    const out = mergeGeometries(geos)!;
    out.computeBoundingSphere();
    return out;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new BoxGeometry(w, h, d).translate(x, y, z);

/** A gable roof: triangle (span across X, `rise` up) extruded `len` along Z, eaves at y = 0. */
function gable(span: number, rise: number, len: number): BufferGeometry {
    const s = new Shape();
    s.moveTo(-span / 2, 0); s.lineTo(span / 2, 0); s.lineTo(0, rise); s.closePath();
    const g = new ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
    g.translate(0, 0, -len / 2);
    return g;
}

function rock(): BufferGeometry {
    // Low-poly boulder: a jittered icosahedron, flattened, 1.93 x 1.4 x 1.91 m
    const g = new IcosahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = 0.85 + 0.3 * Math.abs(Math.sin(x * 12.9 + y * 78.2 + z * 37.7) * 43758.5 % 1);
        p.setXYZ(i, x * n, y * n, z * n);
    }
    g.computeBoundingBox();
    const b = g.boundingBox!;
    g.translate(0, -b.min.y, 0);
    g.scale(1.93 / (b.max.x - b.min.x), 1.4 / (b.max.y - b.min.y), 1.91 / (b.max.z - b.min.z));
    return merge([{ g, color: '#8d8a84' }]);
}

function house(): BufferGeometry {
    // 7.7 x 7.5 x 9.1 m: pale walls, dark gable roof with eaves, chimney, door and windows
    const roof = gable(7.67, 2.9, 9.07).translate(0, 4.6, 0);
    return merge([
        { g: box(7.0, 4.6, 8.4, 0, 2.3, 0), color: '#d9cdb4' },
        { g: roof, color: '#5b3a2e' },
        { g: box(0.7, 1.8, 0.7, 1.6, 6.4, -2.2), color: '#7a6a5e' },
        { g: box(0.06, 2.1, 1.1, 3.51, 1.05, 0), color: '#4a3326' },
        { g: box(0.06, 1.1, 1.2, 3.51, 2.6, -2.6), color: '#2c3a46' },
        { g: box(0.06, 1.1, 1.2, 3.51, 2.6, 2.6), color: '#2c3a46' },
        { g: box(0.06, 1.1, 1.2, -3.51, 2.6, -2.6), color: '#2c3a46' },
        { g: box(0.06, 1.1, 1.2, -3.51, 2.6, 2.6), color: '#2c3a46' },
    ]);
}

function barn(): BufferGeometry {
    // 14.3 x 9 x 9.9 m red barn, ridge along X, white trim and big doors on the long sides
    const roof = gable(9.9, 3.8, 14.26).rotateY(Math.PI / 2).translate(0, 5.2, 0);
    return merge([
        { g: box(13.6, 5.2, 9.3, 0, 2.6, 0), color: '#9b2f25' },
        { g: roof, color: '#4a4a4c' },
        { g: box(3.6, 3.8, 0.08, 0, 1.9, 4.66), color: '#7a2219' },
        { g: box(3.6, 3.8, 0.08, 0, 1.9, -4.66), color: '#7a2219' },
        { g: box(3.8, 0.18, 0.1, 0, 3.85, 4.67), color: '#e8e2d6' },
        { g: box(3.8, 0.18, 0.1, 0, 3.85, -4.67), color: '#e8e2d6' },
        { g: box(13.7, 0.18, 9.4, 0, 5.15, 0), color: '#e8e2d6' },
    ]);
}

function fence(): BufferGeometry {
    // One 4.1 m section: a post at each end, three rails, 1.34 m tall
    const wood = '#7b5a3c', rail = '#8c6a48';
    return merge([
        { g: box(0.14, 1.34, 0.14, -1.98, 0.67, 0), color: wood },
        { g: box(0.14, 1.34, 0.14, 1.98, 0.67, 0), color: wood },
        { g: box(4.1, 0.11, 0.05, 0, 0.42, 0.1), color: rail },
        { g: box(4.1, 0.11, 0.05, 0, 0.8, 0.1), color: rail },
        { g: box(4.1, 0.11, 0.05, 0, 1.18, 0.1), color: rail },
    ]);
}

function guardrail(): BufferGeometry {
    // One 4.1 m section: steel post and a W-beam (two ribs), top at ~1.1 m
    const steel = '#a7abae';
    return merge([
        { g: new CylinderGeometry(0.07, 0.07, 1.0, 8).translate(0, 0.5, -0.06), color: '#8f9396' },
        { g: box(4.1, 0.15, 0.06, 0, 0.98, 0.1), color: steel },
        { g: box(4.1, 0.15, 0.06, 0, 0.8, 0.1), color: steel },
        { g: box(4.1, 0.06, 0.1, 0, 0.89, 0.08), color: '#8f9396' },
    ]);
}

const BUILDERS: Partial<Record<PropKind, () => BufferGeometry>> = { rock, house, barn, fence, guardrail };

/** A stand-in for one scenery kind, or null if the kind has none. */
export function standIn(kind: PropKind): { geometry: BufferGeometry; material: Material } | null {
    const build = BUILDERS[kind];
    if (!build) return null;
    const metal = kind === 'guardrail';
    const material = new MeshStandardMaterial({
        vertexColors: true,
        roughness: metal ? 0.5 : 0.9,
        metalness: metal ? 0.25 : 0,
        envMapIntensity: metal ? 0.6 : 0.5,
        flatShading: kind === 'rock',
    });
    return { geometry: build(), material };
}

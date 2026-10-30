import {
    BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Shape,
} from 'three';
import type { BufferGeometry, Material } from 'three';

/**
 * The stand-in car when `car-a.glb` (see assets.config.ts) is missing: a low blue coupe from simple shapes,
 * on the same footprint as the original car (4.75 m long, ~2.1 m wide over the wheels), nose down -Z,
 * tyres touching y = `ground`. Physics and camera do not read the model, so they are unchanged.
 *
 * Body and cabin are side profiles extruded across the car with a rounded bevel; four wheels with tyres
 * and rims; glowing headlights and tail lights.
 */
export function buildProceduralCar(length: number, paint: string, ground: number): Group {
    const k = length / 4.75;                 // everything below is drawn for a 4.75 m car
    const car = new Group();
    const mesh = (g: BufferGeometry, m: Material, x = 0, y = 0, z = 0) => {
        const o = new Mesh(g, m);
        o.position.set(x, y, z);
        o.castShadow = true;
        o.receiveShadow = true;
        car.add(o);
        return o;
    };

    const body = new MeshPhysicalMaterial({
        color: paint, metalness: 0.35, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.15,
    });
    const glass = new MeshPhysicalMaterial({ color: '#0b1016', metalness: 0.1, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.2 });
    const trim = new MeshStandardMaterial({ color: '#16181b', roughness: 0.6, metalness: 0.2 });
    const tyre = new MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 });
    const rim = new MeshStandardMaterial({ color: '#b9bec4', roughness: 0.28, metalness: 0.9, envMapIntensity: 1.1 });
    const head = new MeshStandardMaterial({ color: '#f4f6ff', emissive: '#fff4dc', emissiveIntensity: 1.6, roughness: 0.2 });
    const tail = new MeshStandardMaterial({ color: '#5a0000', emissive: '#ff1a1a', emissiveIntensity: 0.9, roughness: 0.3 });

    // Side profile in (x = along the car, nose at +x; y = up), extruded across the car (local z)
    // `taper`: how much narrower the top is than the bottom (0.2 = 20 %), for rounded, inward-leaning sides
    const extrude = (pts: [number, number][], width: number, bevel: number, taper = 0) => {
        const s = new Shape();
        s.moveTo(pts[0][0] * k, pts[0][1] * k);
        for (const [x, y] of pts.slice(1)) s.lineTo(x * k, y * k);
        s.closePath();
        const g = new ExtrudeGeometry(s, {
            depth: width * k - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 4,
        });
        g.translate(0, 0, -(width * k - bevel * 2) / 2);
        g.rotateY(Math.PI / 2);              // +x (nose) -> -z
        if (taper) {
            g.computeBoundingBox();
            const { min, max } = g.boundingBox!;
            const p = g.attributes.position;
            for (let i = 0; i < p.count; i++) {
                const t = (p.getY(i) - min.y) / (max.y - min.y);
                p.setX(i, p.getX(i) * (1 - taper * t * t));
            }
        }
        g.computeVertexNormals();
        return g;
    };

    // Lower body: long bonnet, short tail deck, up to the waistline
    mesh(extrude([
        [-2.28, 0.32], [2.26, 0.32], [2.33, 0.5], [2.27, 0.7], [1.9, 0.78], [0.95, 0.92],
        [-1.75, 0.98], [-2.26, 0.92], [-2.32, 0.6],
    ], 1.86, 0.09, 0.1), body, 0, ground, 0);
    // Cabin: dark glass greenhouse with a fastback, a little narrower than the body
    mesh(extrude([
        [0.98, 0.9], [0.18, 1.32], [-0.62, 1.34], [-1.85, 0.98],
    ], 1.6, 0.07, 0.3), glass, 0, ground, 0);
    // Body-coloured roof panel on the glass
    mesh(extrude([
        [0.12, 1.33], [-0.6, 1.35], [-0.95, 1.3], [-0.95, 1.27], [0.12, 1.29],
    ], 1.16, 0.04), body, 0, ground, 0);
    // Dark sills and bumpers
    mesh(new BoxGeometry(1.9 * k, 0.12 * k, 2.4 * k), trim, 0, ground + 0.3 * k, 0);
    mesh(new BoxGeometry(1.76 * k, 0.14 * k, 0.12 * k), trim, 0, ground + 0.38 * k, -2.4 * k);
    mesh(new BoxGeometry(1.76 * k, 0.16 * k, 0.12 * k), trim, 0, ground + 0.4 * k, 2.42 * k);

    // Lights: two slim headlights at the nose, a full-width tail light bar at the back
    for (const side of [-1, 1]) mesh(new BoxGeometry(0.46 * k, 0.08 * k, 0.12 * k), head, side * 0.58 * k, ground + 0.64 * k, -2.36 * k);
    mesh(new BoxGeometry(1.5 * k, 0.07 * k, 0.1 * k), tail, 0, ground + 0.84 * k, 2.37 * k);
    for (const side of [-1, 1]) mesh(new BoxGeometry(0.3 * k, 0.12 * k, 0.1 * k), tail, side * 0.66 * k, ground + 0.84 * k, 2.37 * k);

    // Wheels: tyre with a rim on the outside face, sitting on the ground
    const r = 0.37 * k, w = 0.27 * k;
    const tyreGeo = new CylinderGeometry(r, r, w, 28);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new CylinderGeometry(r * 0.66, r * 0.66, w * 0.25, 20);
    rimGeo.rotateZ(Math.PI / 2);
    const hubGeo = new BoxGeometry(w * 0.3, r * 1.1, r * 0.14);
    for (const z of [-1.47 * k, 1.42 * k]) {
        for (const side of [-1, 1]) {
            const x = side * 0.92 * k;
            mesh(tyreGeo, tyre, x, ground + r, z);
            mesh(rimGeo, rim, x + side * w * 0.4, ground + r, z);
            // Two crossed spokes, so the wheel reads as a wheel
            for (const a of [0, Math.PI / 2]) mesh(hubGeo, rim, x + side * w * 0.45, ground + r, z).rotation.x = a + Math.PI / 4;
        }
    }
    return car;
}

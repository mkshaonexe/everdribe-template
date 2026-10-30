import {
    BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Float32BufferAttribute, RepeatWrapping, SRGBColorSpace, Vector3,
} from 'three';
import type { Texture } from 'three';

/**
 * Procedural trees and shrubs: real branch geometry and crowns of leaf cards, grown from a seed.
 *
 * Why not models: the generated tree models were single solid meshes (leaf "plates" instead of leaves,
 * roots modelled above the ground) and every tree of a kind was an identical copy. Here each species is a
 * set of growth rules; each seed grows a different tree from them (trunk lean, branch count and angles,
 * crown shape), so a forest has several distinct trees per species, which the scenery then scales, turns
 * and tints per instance.
 *
 * Growth (after the skill's "growth hierarchy plus rendering adaptations"):
 * - a trunk that starts 0.6 m below the ground with a flared foot, so it grows out of the soil;
 * - branches that leave their parent at a set angle, spiral around it (golden angle), bend towards the
 *   light or droop under gravity, and taper;
 * - leaves as textured cards clustered on the outer twigs; their normals point out of the crown volume, so
 *   the crown is lit as a rounded mass with a sunny side and a shaded side instead of a pile of flat cards;
 * - each leaf vertex carries `occ`, how far out in the crown it sits (0 deep inside and low, 1 on the
 *   outer shell): the shader darkens the inside, the way real crowns are dark between the outer leaves;
 * - a light version (fewer, larger cards; no fine twigs) for distance, and a shadow version of it with
 *   the cards pulled in towards the crown centre, so the outer leaves on the sunny side are not speckled
 *   by the shadow of cards that stick out past them.
 *
 * Leaves come from a photo atlas made with Higgsfield (`assets/textures/leaves.webp`, built by
 * `scripts/make-leaf-atlas.py`); bark is drawn on a canvas at start-up.
 */

export type Species = 'broadleaf' | 'birch' | 'autumn' | 'pine' | 'shrub';

interface Spec {
    height: number;          // metres, at instance scale 1
    trunkRadius: number;     // at the foot
    crownStart: number;      // share of the height where branches begin
    levels: number;          // branch levels below the trunk
    children: [number, number]; // branches off the trunk (min, max); deeper levels get fewer
    angle: number;           // branch angle from its parent (radians)
    lengthRatio: number;     // child length / parent length
    droop: number;           // how much branches bend down along their length
    rise: number;            // how much they turn up towards the light
    leafSize: number;        // card size (m)
    leafDensity: number;     // cards per metre of outer twig
    leafTile: number;        // leaf atlas tile 0..3
    barkTile: number;        // bark atlas tile 0..1
    lean: number;            // random trunk lean
    conifer?: boolean;
    stems?: number;          // shrubs: stems from the ground instead of one trunk
}

// Leaf cards hold a whole photographed cluster of leaves (about 10 cm leaves on a 1.3 m card), so the
// crowns look full with about the same card area as the old drawn sprays. More area cost frame rate:
// the photo clusters are mostly solid, so nearly every pixel of a card is lit and shaded
const SPECS: Record<Species, Spec> = {
    broadleaf: {
        height: 12, trunkRadius: 0.32, crownStart: 0.3, levels: 3, children: [6, 9], angle: 0.75, lengthRatio: 0.62,
        droop: 0.18, rise: 0.35, leafSize: 1.3, leafDensity: 3.6, leafTile: 0, barkTile: 0, lean: 0.08,
    },
    autumn: {
        height: 10.5, trunkRadius: 0.3, crownStart: 0.32, levels: 3, children: [6, 8], angle: 0.8, lengthRatio: 0.6,
        droop: 0.2, rise: 0.3, leafSize: 1.25, leafDensity: 3.5, leafTile: 2, barkTile: 0, lean: 0.1,
    },
    birch: {
        height: 15, trunkRadius: 0.2, crownStart: 0.42, levels: 3, children: [7, 10], angle: 0.6, lengthRatio: 0.55,
        droop: 0.45, rise: 0.15, leafSize: 1.1, leafDensity: 3.0, leafTile: 1, barkTile: 1, lean: 0.06,
    },
    // Spruce: dense whorls of drooping limbs; cards tilt outwards so the cone is solid from the side
    pine: {
        height: 16, trunkRadius: 0.3, crownStart: 0.18, levels: 2, children: [28, 34], angle: 1.75, lengthRatio: 0.4,
        droop: 0.25, rise: 0.0, leafSize: 1.35, leafDensity: 3.8, leafTile: 3, barkTile: 0, lean: 0.02, conifer: true,
    },
    shrub: {
        height: 1.8, trunkRadius: 0.035, crownStart: 0.15, levels: 2, children: [3, 5], angle: 0.7, lengthRatio: 0.6,
        droop: 0.1, rise: 0.3, leafSize: 0.6, leafDensity: 9, leafTile: 0, barkTile: 0, lean: 0.4, stems: 7,
    },
};

/** Crown start height (m) per species, for the wind shader: below it the trunk stays still. */
export const CROWN_HEIGHT: Record<Species, number> = {
    broadleaf: 2.5, autumn: 2.5, birch: 4, pine: 2, shrub: 0,
};

// ---- seeded random ----
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Buffers { pos: number[]; nrm: number[]; uv: number[]; occ: number[]; idx: number[] }
const buf = (): Buffers => ({ pos: [], nrm: [], uv: [], occ: [], idx: [] });

const UP = new Vector3(0, 1, 0);
const tmpA = new Vector3(), tmpB = new Vector3(), tmpC = new Vector3();

/** A direction turned `angle` away from `dir`, around it by `spin`. */
function deviate(dir: Vector3, angle: number, spin: number, out: Vector3) {
    const side = Math.abs(dir.y) < 0.95 ? tmpA.crossVectors(dir, UP).normalize() : tmpA.set(1, 0, 0);
    const side2 = tmpB.crossVectors(dir, side).normalize();
    const s = Math.sin(angle);
    out.copy(dir).multiplyScalar(Math.cos(angle))
        .addScaledVector(side, s * Math.cos(spin))
        .addScaledVector(side2, s * Math.sin(spin))
        .normalize();
    return out;
}

interface Branch { pts: Vector3[]; rad: number[]; level: number; length: number }

/** Tapered tube along a polyline, with bark UVs from one atlas tile. */
function tube(b: Buffers, pts: Vector3[], rad: number[], sides: number, barkTile: number) {
    const base = b.pos.length / 3;
    const u0 = barkTile * 0.5 + 0.004, u1 = barkTile * 0.5 + 0.496;
    let n0 = new Vector3(), along = 0;
    for (let i = 0; i < pts.length; i++) {
        const t = tmpC.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
        if (i === 0) n0 = (Math.abs(t.y) < 0.95 ? new Vector3().crossVectors(t, UP) : new Vector3(1, 0, 0)).normalize();
        else n0.sub(tmpA.copy(t).multiplyScalar(n0.dot(t))).normalize();   // parallel transport
        const n1 = new Vector3().crossVectors(t, n0).normalize();
        if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
        const r = rad[i];
        for (let j = 0; j <= sides; j++) {
            const a = (j / sides) * Math.PI * 2;
            const nx = n0.x * Math.cos(a) + n1.x * Math.sin(a);
            const ny = n0.y * Math.cos(a) + n1.y * Math.sin(a);
            const nz = n0.z * Math.cos(a) + n1.z * Math.sin(a);
            b.pos.push(pts[i].x + nx * r, pts[i].y + ny * r, pts[i].z + nz * r);
            b.nrm.push(nx, ny, nz);
            b.occ.push(1);
            // One bark tile around, repeating every ~1.6 m up the trunk (thinner limbs repeat sooner)
            b.uv.push(u0 + (u1 - u0) * (j / sides), along / Math.max(0.4, Math.min(1.6, r * 9)));
        }
    }
    const ring = sides + 1;
    for (let i = 0; i < pts.length - 1; i++) {
        for (let j = 0; j < sides; j++) {
            const a = base + i * ring + j, c = a + ring;
            b.idx.push(a, c, a + 1, a + 1, c, c + 1);
        }
    }
}

/**
 * One leaf card: a square in a random plane, normal taken from the crown volume.
 * `occ`: how far out in the crown the card sits (0 inside, 1 on the outer shell), for the shader.
 */
function leafCard(b: Buffers, at: Vector3, size: number, crownCentre: Vector3, tile: number, r: () => number, conifer: boolean, occ: number) {
    const base = b.pos.length / 3;
    const out = tmpA.subVectors(at, crownCentre);
    out.y = conifer ? out.y * 0.3 : out.y;   // a spruce's limbs point out sideways, not up the cone
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    out.normalize();
    // Card faces roughly outwards (more random deep inside). Spruce sprays tilt up and out at ~45°: lying
    // flat, they were edge-on from the road and the crown turned into a see-through flicker of slivers
    const face = conifer
        ? new Vector3(out.x + (r() - 0.5) * 0.5, 0.9 + r() * 0.4, out.z + (r() - 0.5) * 0.5).normalize()
        : new Vector3(r() - 0.5, r() - 0.3, r() - 0.5).normalize().lerp(out, 0.45).normalize();
    const u = (Math.abs(face.y) < 0.95 ? new Vector3().crossVectors(face, UP) : new Vector3(1, 0, 0)).normalize();
    const v = new Vector3().crossVectors(face, u).normalize();
    const spin = r() * Math.PI * 2;
    const cu = u.clone().multiplyScalar(Math.cos(spin)).addScaledVector(v, Math.sin(spin));
    const cv = new Vector3().crossVectors(face, cu);
    const h = size / 2;
    // Normal: the crown direction with a little of the card's own facing, so the crown shades smoothly from
    // its sunny side to its shaded side (more of the card's facing made the light speckle card by card)
    const nrm = new Vector3().copy(out).multiplyScalar(0.9).addScaledVector(face, 0.2).normalize();
    const tx = (tile % 2) * 0.5, ty = Math.floor(tile / 2) * 0.5;
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const flip = r() < 0.5;
    for (const [a, c] of corners) {
        b.pos.push(at.x + (cu.x * a + cv.x * c) * h, at.y + (cu.y * a + cv.y * c) * h, at.z + (cu.z * a + cv.z * c) * h);
        b.nrm.push(nrm.x, nrm.y, nrm.z);
        b.occ.push(occ);
        const uu = (flip ? -a : a) * 0.5 + 0.5, vv = c * 0.5 + 0.5;
        b.uv.push(tx + 0.01 + uu * 0.48, ty + 0.01 + vv * 0.48);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Grow the branch skeleton of one tree. */
function grow(spec: Spec, r: () => number): Branch[] {
    const out: Branch[] = [];
    const H = spec.height * (0.9 + r() * 0.2);

    const limb = (start: Vector3, dir: Vector3, length: number, radius: number, level: number, segs: number, lean: number) => {
        const pts = [start.clone()], rad = [radius];
        const d = dir.clone();
        const step = length / segs;
        for (let i = 1; i <= segs; i++) {
            const t = i / segs;
            // Wander a little, turn up towards the light, droop under weight further out
            d.x += (r() - 0.5) * lean; d.z += (r() - 0.5) * lean;
            d.y += spec.rise * step / length * (1 - t) - spec.droop * step / length * t * (level + 1) * 0.6;
            d.normalize();
            pts.push(pts[i - 1].clone().addScaledVector(d, step));
            rad.push(radius * (1 - t * 0.82));
        }
        const b = { pts, rad, level, length };
        out.push(b);
        return b;
    };

    const branchOff = (parent: Branch) => {
        if (parent.level >= spec.levels) return;
        const lvl = parent.level + 1;
        const [lo, hi] = spec.children;
        const count = Math.max(2, Math.round((lo + r() * (hi - lo)) * Math.pow(0.55, lvl - 1)));
        const from = lvl === 1 ? spec.crownStart * (spec.conifer ? 1 : 1.1) : 0.25;
        let spin = r() * Math.PI * 2;
        for (let k = 0; k < count; k++) {
            spin += 2.39996 + (r() - 0.5) * 0.4;   // golden angle around the parent
            const t = from + (1 - from) * (spec.conifer && lvl === 1 ? k / count : r() * 0.92 + 0.04);
            const i = Math.min(parent.pts.length - 2, Math.floor(t * (parent.pts.length - 1)));
            const f = t * (parent.pts.length - 1) - i;
            const at = parent.pts[i].clone().lerp(parent.pts[i + 1], f);
            const pdir = tmpC.subVectors(parent.pts[i + 1], parent.pts[i]).normalize().clone();
            const dir = deviate(pdir, spec.angle * (0.8 + r() * 0.4), spin, new Vector3());
            let len = parent.length * spec.lengthRatio * (0.75 + r() * 0.5);
            if (spec.conifer && lvl === 1) {
                // Cone: long branches low, short near the top
                len = H * 0.36 * Math.pow(1 - t, 0.9) * (0.8 + r() * 0.4) + 0.4;
                dir.y = Math.min(dir.y, -0.05 - r() * 0.25);
                dir.normalize();
            } else if (lvl === 1) len *= 1 - t * 0.45;
            const radius = parent.rad[i] * (spec.conifer && lvl === 1 ? 0.28 : 0.62) * (0.8 + r() * 0.3);
            const segs = lvl === 1 ? 5 : 3;
            const b = limb(at, dir, len, radius, lvl, segs, 0.25);
            branchOff(b);
        }
    };

    const stems = spec.stems ?? 1;
    for (let s = 0; s < stems; s++) {
        const a = r() * Math.PI * 2;
        const lean = spec.lean * (stems > 1 ? 1 : r());
        const dir = new Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize();
        const start = new Vector3(stems > 1 ? Math.cos(a) * 0.08 : 0, -0.6, stems > 1 ? Math.sin(a) * 0.08 : 0);
        const len = (stems > 1 ? H * (0.6 + r() * 0.4) : H) + 0.6;
        const trunk = limb(start, dir, len, spec.trunkRadius * (stems > 1 ? 1 : 0.9 + r() * 0.2), 0, stems > 1 ? 4 : 9, 0.05);
        // Flared foot: wider where it meets the ground (y between -0.6 and ~0.4)
        if (stems === 1) for (let i = 0; i < 3; i++) trunk.rad[i] *= 1 + 0.55 * (1 - i / 3);
        branchOff(trunk);
    }
    return out;
}

export interface TreeGeometry { geometry: BufferGeometry; height: number }

/**
 * One grown tree as a single geometry with two groups: 0 = bark, 1 = leaves.
 * `lod`: the light version (no fine twigs, fewer and larger leaf cards, fewer sides).
 * `shadow`: the light version with its leaf cards pulled 18 % in towards the crown centre and a little
 * smaller, for casting the tree's shadow (it then shades the inside of the crown, not its sunny shell).
 * `far`: the farthest version (v0.15.0), for trees hundreds of metres away on hills and in far woods: the
 * trunk only, and about a third of the light version's cards (a fifth for conifers), larger, so the crown
 * keeps its size and outline. A few hundred triangles per tree, so whole hillsides of trees cost little.
 */
export function buildTree(species: Species, seed: number, lod: boolean, shadow = false, far = false): TreeGeometry {
    const spec = SPECS[species];
    const r = rng(seed * 7919 + (species.length * 104729));
    const branches = grow(spec, r);
    lod = lod || shadow || far;

    // Crown centre: average of the outer branch tips; crown size: how far the tips reach from it
    const centre = new Vector3();
    let tips = 0, top = 0;
    for (const b of branches) {
        const end = b.pts[b.pts.length - 1];
        top = Math.max(top, end.y);
        if (b.level >= 1) { centre.add(end); tips++; }
    }
    if (tips) centre.divideScalar(tips); else centre.set(0, spec.height * 0.6, 0);
    let reach = 0.5, side = 0.5;
    for (const b of branches) {
        if (b.level < 1) continue;
        const end = b.pts[b.pts.length - 1];
        reach = Math.max(reach, end.distanceTo(centre));
        side = Math.max(side, Math.hypot(end.x, end.z));
    }
    const coneBase = spec.crownStart * spec.height;
    /** 0 deep inside / low in the crown, 1 on its outer shell. */
    const occlusion = (at: Vector3) => {
        if (spec.conifer) {
            // Cone: compare the distance from the trunk with the cone's radius at this height
            const radius = side * Math.min(1, Math.max(0.12, (top - at.y) / Math.max(1, top - coneBase)));
            return Math.min(1, Math.max(0, Math.hypot(at.x, at.z) / radius * 1.1 - 0.15));
        }
        const d = at.distanceTo(centre) / reach;
        const t = Math.min(1, Math.max(0, (d - 0.2) / 0.75));
        return Math.min(1, Math.max(0, t * t * (3 - 2 * t) + 0.3 * (at.y - centre.y) / reach));
    };

    const bark = buf(), leaves = buf();
    const leafR = rng(seed * 31 + 17);
    for (const b of branches) {
        // The far version keeps the trunk only: from hundreds of metres the limbs are inside the crown
        const thin = far ? b.level > 0 : b.rad[0] < (lod ? 0.06 : 0.012);
        if (!thin && !shadow) {
            const sides = far ? 3 : b.level === 0 ? (lod ? 5 : 8) : b.level === 1 ? (lod ? 3 : 5) : 3;
            tube(bark, b.pts, b.rad, sides, spec.barkTile);
        } else if (!thin && b.level === 0) {
            tube(bark, b.pts, b.rad, 5, spec.barkTile);   // the shadow version keeps only the trunk
        }
        // Leaves on the outer branches (deepest level, and the tips of the level above)
        const outer = b.level === spec.levels || (b.level === spec.levels - 1 && !spec.conifer);
        if (!outer && !(spec.conifer && b.level >= 1)) continue;
        // Conifers have many more limbs, each carrying cards: keep fewer of theirs
        const keep = far ? (spec.conifer ? 0.09 : 0.11) : lod ? 0.3 : 1;
        const want = b.length * spec.leafDensity * keep * (b.level === spec.levels ? 1 : 0.4);
        // Far away a short twig may carry no card: one per twig was most of a far spruce's cards
        const count = far ? Math.round(want + leafR() - 0.5) : Math.max(1, Math.round(want));
        const size = spec.leafSize * (far ? 2.4 : lod ? 1.75 : 1);
        for (let k = 0; k < count; k++) {
            const t = 0.3 + 0.7 * ((k + leafR()) / count);
            const i = Math.min(b.pts.length - 2, Math.floor(t * (b.pts.length - 1)));
            const at = b.pts[i].clone().lerp(b.pts[i + 1], t * (b.pts.length - 1) - i);
            at.x += (leafR() - 0.5) * size * 0.6; at.y += (leafR() - 0.5) * size * 0.5; at.z += (leafR() - 0.5) * size * 0.6;
            const s = size * (0.75 + leafR() * 0.5);
            // Each card turns by its own random numbers, so a skipped card does not shift the cards after it
            // (the shadow version keeps every card and must still match the light version card for card)
            const turn = rng(Math.floor(leafR() * 4294967296));
            const occ = occlusion(at);
            // Most cards deep inside the crown are hidden behind the outer ones and dark anyway, but each
            // still costs its pixels: keep one in three of them
            if (leafR() > 0.33 && occ < 0.3 && !shadow) continue;
            if (shadow) at.lerp(spec.conifer ? new Vector3(0, at.y, 0) : centre, 0.18);
            leafCard(leaves, at, shadow ? s * 0.85 : s, centre, spec.leafTile, turn, !!spec.conifer, occ);
        }
    }

    // Merge: bark first (group 0), then leaves (group 1)
    const g = new BufferGeometry();
    const nb = bark.pos.length / 3;
    g.setAttribute('position', new Float32BufferAttribute([...bark.pos, ...leaves.pos], 3));
    g.setAttribute('normal', new Float32BufferAttribute([...bark.nrm, ...leaves.nrm], 3));
    g.setAttribute('uv', new Float32BufferAttribute([...bark.uv, ...leaves.uv], 2));
    g.setAttribute('occ', new Float32BufferAttribute([...bark.occ, ...leaves.occ], 1));
    g.setIndex([...bark.idx, ...leaves.idx.map((i) => i + nb)]);
    g.addGroup(0, bark.idx.length, 0);
    g.addGroup(bark.idx.length, leaves.idx.length, 1);
    g.computeBoundingSphere();
    return { geometry: g, height: top };
}

// ---------------------------------------------------------------------------------------------
// Leaves: photo atlas · bark: canvas texture (2 tiles side by side)
// ---------------------------------------------------------------------------------------------

/**
 * 2 x 2 leaf atlas (2048 px): 0 broadleaf, 1 birch, 2 autumn, 3 spruce, each a photographed cluster of
 * leaves on a transparent background (Higgsfield, GPT Image 2.5; `scripts/make-leaf-atlas.py`).
 * The file is `assets/textures/leaves.webp` (assets/availability.ts); without it `makeLeafAtlas` draws one.
 * Tile t covers u = (t % 2) / 2 and v = floor(t / 2) / 2 (v up: tiles 0 and 1 are the bottom row).
 */
let drawnLeaves: CanvasTexture | null = null;
/** A leaf atlas drawn in code, same layout as the photo: clusters of leaves (needles for the spruce). */
export function makeLeafAtlas(): CanvasTexture {
    if (drawnLeaves) return drawnLeaves;
    const S = 512;
    const c = document.createElement('canvas');
    c.width = S * 2; c.height = S * 2;
    const ctx = c.getContext('2d')!;
    const r = rng(4242);
    // [hue, saturation, lightness] ranges per tile: broadleaf, birch, autumn, spruce
    const palettes: [number, number, number, number][][] = [
        [[100, 55, 22, 8], [92, 50, 32, 8], [80, 55, 42, 6]],
        [[78, 55, 38, 8], [70, 60, 48, 6], [95, 45, 30, 6]],
        [[28, 80, 45, 8], [16, 75, 40, 8], [42, 80, 50, 8], [90, 35, 30, 5]],
        [[150, 30, 18, 5], [140, 28, 24, 5]],
    ];
    for (let t = 0; t < 4; t++) {
        const ox = (t % 2) * S, oy = (1 - Math.floor(t / 2)) * S;   // canvas y runs down, v runs up
        const cx = ox + S / 2, cy = oy + S / 2, R = S * 0.42;
        const pal = palettes[t]!;
        const pick = () => { const [h, s2, l, j] = pal[Math.floor(r() * pal.length)]!; return hsl(h + (r() - 0.5) * j, s2, l + (r() - 0.5) * j); };
        ctx.save();
        ctx.beginPath(); ctx.rect(ox + 4, oy + 4, S - 8, S - 8); ctx.clip();
        if (t === 3) {
            // Spruce: branches from the centre, each with short needles on both sides
            for (let b = 0; b < 26; b++) {
                const ang = r() * Math.PI * 2, len = R * (0.55 + r() * 0.45);
                const dx = Math.cos(ang), dy = Math.sin(ang);
                ctx.lineCap = 'round';
                for (let i = 0; i < 60; i++) {
                    const f = i / 60, px = cx + dx * len * f, py = cy + dy * len * f;
                    for (const side of [-1, 1]) {
                        const na = ang + side * (0.9 + r() * 0.3), nl = 10 + r() * 10 * (1 - f * 0.5);
                        ctx.strokeStyle = pick(); ctx.lineWidth = 2.2;
                        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); ctx.stroke();
                    }
                }
            }
        } else {
            // Leaves: pointed ovals with a midrib, many overlapping inside the cluster's circle
            const n = t === 1 ? 260 : 170, size = t === 1 ? 20 : 30;
            for (let i = 0; i < n; i++) {
                const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R;
                const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
                const l = size * (0.7 + r() * 0.6), w = l * (t === 1 ? 0.6 : 0.5);
                ctx.save();
                ctx.translate(x, y); ctx.rotate(a + (r() - 0.5) * 1.2);
                ctx.fillStyle = pick();
                ctx.beginPath();
                ctx.moveTo(-l, 0);
                ctx.quadraticCurveTo(0, -w * 1.3, l, 0);
                ctx.quadraticCurveTo(0, w * 1.3, -l, 0);
                ctx.fill();
                ctx.strokeStyle = 'rgba(30,40,10,0.35)'; ctx.lineWidth = 1.2;
                ctx.beginPath(); ctx.moveTo(-l * 0.9, 0); ctx.lineTo(l * 0.9, 0); ctx.stroke();
                ctx.restore();
            }
        }
        ctx.restore();
    }
    drawnLeaves = new CanvasTexture(c);
    return drawnLeaves;
}

/** Settings for the loaded leaf atlas. */
export function setupLeafAtlas(t: Texture): Texture {
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.anisotropy = 8;
    return t;
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

let barkAtlas: CanvasTexture | null = null;
/** Two bark tiles side by side: 0 brown furrowed bark, 1 white birch with dark marks. */
export function getBarkAtlas(): CanvasTexture {
    if (barkAtlas) return barkAtlas;
    const W = 256, H = 512;
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H;
    const ctx = c.getContext('2d')!;
    const r = rng(777);
    // Brown bark: vertical ridges and furrows
    ctx.fillStyle = hsl(26, 18, 26);
    ctx.fillRect(0, 0, W, H);
    for (let k = 0; k < 140; k++) {
        const x = r() * W, w = 2 + r() * 7;
        ctx.strokeStyle = r() < 0.5 ? hsl(25, 14, 14 + r() * 6, 0.8) : hsl(28, 16, 34 + r() * 10, 0.6);
        ctx.lineWidth = w;
        ctx.beginPath();
        let px = x;
        ctx.moveTo(px, 0);
        for (let yy = 0; yy <= H; yy += 32) { px += (r() - 0.5) * 8; ctx.lineTo(px, yy); }
        ctx.stroke();
    }
    // Birch: chalky white with dark horizontal lenticels and black patches
    ctx.fillStyle = hsl(40, 12, 86);
    ctx.fillRect(W, 0, W, H);
    for (let k = 0; k < 220; k++) {
        ctx.fillStyle = hsl(30, 10, 12 + r() * 20, 0.5 + r() * 0.5);
        const w = 6 + r() * 30, h = 1.5 + r() * 3;
        ctx.fillRect(W + r() * (W - w), r() * H, w, h);
    }
    for (let k = 0; k < 10; k++) {
        ctx.fillStyle = hsl(20, 10, 10, 0.85);
        ctx.beginPath();
        ctx.ellipse(W + r() * W, r() * H, 8 + r() * 20, 5 + r() * 12, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
    barkAtlas = t;
    return t;
}

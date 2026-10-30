import type { Camera } from 'three';
import { Vector3 } from 'three';

/**
 * Which way the camera looked when an instance list (trees, grass) was last rebuilt. Lists are rebuilt
 * only every few metres, so they keep what lies inside a wide cone around the view direction (plus a
 * ring around the car for shadows and the mirror-like car paint) and skip what is behind the camera.
 * Turning the camera more than CONE_TURN rebuilds the list, so nothing is missing at the screen edge.
 *
 * Measured in the Codex audit (v0.10.0): drawing only what is in view cut the triangles submitted per
 * frame from 6.4 M to 2.7 M on Ultra.
 */
export interface ViewCone {
    x: number; z: number;   // car position at the last rebuild
    fx: number; fz: number; // view direction on the ground (unit)
    all: boolean;           // keep everything (camera looking down)
    cos?: number;           // cosine of the cone's half-angle
}

/** Rebuild when the view turns more than this (radians). */
const CONE_TURN = 0.3;
/** Everything within this distance of the car is kept, whatever the view (m). */
const KEEP_NEAR = 18;
const dir = new Vector3();

/** Half-angle of the cone kept for a camera: half the horizontal field of view, plus the turn allowance. */
function halfAngle(camera: Camera): number {
    const c = camera as { fov?: number; aspect?: number };
    const vfov = ((c.fov ?? 60) * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (c.aspect ?? 1.6));
    // The wider lens at speed adds up to ~10° of field of view, and the list lags the turn: add both
    return Math.min(Math.PI, hfov / 2 + CONE_TURN + 0.25);
}

/**
 * True (and `cone` updated to the new view) when the list should be rebuilt: the car moved `moved`
 * metres, or the camera turned past the allowance.
 */
export function viewConeChanged(cone: ViewCone, camera: Camera, px: number, pz: number, moved: number): boolean {
    camera.getWorldDirection(dir);
    const flat = Math.hypot(dir.x, dir.z);
    // Looking almost straight down (drone camera): keep everything around the car
    const all = flat < 0.35;
    const fx = all ? 0 : dir.x / flat, fz = all ? 0 : dir.z / flat;
    const dx = px - cone.x, dz = pz - cone.z;
    const turned = all !== cone.all || (!all && fx * cone.fx + fz * cone.fz < Math.cos(CONE_TURN));
    if (dx * dx + dz * dz < moved * moved && !turned) return false;
    cone.x = px; cone.z = pz; cone.fx = fx; cone.fz = fz; cone.all = all;
    cone.cos = Math.cos(halfAngle(camera));
    return true;
}

/**
 * Is an offset (ox, oz) from the rebuild point, at squared distance d2, worth drawing?
 * `keepNear`: everything closer than this is kept whatever the view (grass passes a small ring: it casts
 * no shadow and is not in the car's reflections, so grass behind the camera is never seen).
 */
export function inViewCone(cone: ViewCone, ox: number, oz: number, d2: number, keepNear = KEEP_NEAR): boolean {
    if (cone.all || d2 < keepNear * keepNear) return true;
    // The camera sits a few metres behind the car: measure the angle from a point behind it
    const bx = ox + cone.fx * 8, bz = oz + cone.fz * 8;
    const d = Math.hypot(bx, bz);
    return (bx * cone.fx + bz * cone.fz) >= d * (cone.cos ?? -1);
}

/**
 * Solid things near the car, for collisions: trees, rocks and buildings as circles,
 * guardrails and fences as line segments. Filled in by the scenery system; read by the physics.
 */
import { road, hasGuardrail, ROAD_HALF_TOTAL, ROAD_STEP } from './WorldGen';

export interface CircleCollider { x: number; z: number; r: number; kind: string }
export interface SegmentCollider { ax: number; az: number; bx: number; bz: number; kind: string }

const CELL = 32;
const circles = new Map<number, CircleCollider[]>();
const key = (cx: number, cz: number) => cx * 92837111 + cz * 689287499;

/** Replace every circle collider (called when the scenery around the car is rebuilt). */
export function setCircleColliders(list: CircleCollider[]) {
    circles.clear();
    for (const c of list) {
        const k = key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
        let cell = circles.get(k);
        if (!cell) circles.set(k, (cell = []));
        cell.push(c);
    }
}

export function circlesNear(x: number, z: number, out: CircleCollider[]): CircleCollider[] {
    out.length = 0;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const cell = circles.get(key(cx + dx, cz + dz));
            if (cell) for (const c of cell) out.push(c);
        }
    }
    return out;
}

/** Guardrail pieces along the road near a road sample index. */
export function guardrailsNear(i: number, out: SegmentCollider[]): SegmentCollider[] {
    out.length = 0;
    const offset = ROAD_HALF_TOTAL - 0.2;
    for (let j = i - 6; j < i + 6; j++) {
        for (const side of [-1, 1]) {
            if (!hasGuardrail(j, side)) continue;
            const a = road.at(j * ROAD_STEP), b = road.at((j + 1) * ROAD_STEP);
            out.push({
                ax: a.x + a.tz * side * offset, az: a.z - a.tx * side * offset,
                bx: b.x + b.tz * side * offset, bz: b.z - b.tx * side * offset,
                kind: 'guardrail',
            });
        }
    }
    return out;
}

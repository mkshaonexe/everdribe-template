import { PerspectiveCamera, Vector3, Quaternion } from 'three';
import { road, terrainHeight } from '../world/WorldGen';

export interface CameraFrame {
    position: Vector3;      // car position
    rotation: Quaternion;   // car rotation (yaw only)
    delta: number;
    mode: number;           // index into CAMERA_MODES
    distance: number;       // chase zoom from the scroll wheel
    speed: number;          // m/s
    longAccel: number;      // m/s², + = speeding up
    surface: number;        // 0 grass .. 1 asphalt
    impact?: number;        // 0..1 recent collision, shakes the view
}

// Per point of view: where the camera sits, how it follows, and how wide the lens is.
interface ModeSetup {
    follow: 'chase' | 'rigid';
    height: number;         // chase: metres above the car
    distanceScale: number;  // chase: multiplies the zoom distance
    yawRate: number;        // chase: how fast the camera swings round behind the car (1/s)
    local?: [number, number, number]; // rigid: seat position in car space
    pitch: number;          // radians, positive looks up
    lookAhead: number;      // metres ahead of the car to aim at
    fov: number;            // lens at standstill
    fovGain: number;        // extra degrees at full speed
    showModel: boolean;
}

const MODES: Record<number, ModeSetup> = {
    0: { follow: 'chase', height: 3.4, distanceScale: 1, yawRate: 4, pitch: 0, lookAhead: 6, fov: 52, fovGain: 12, showModel: true },
    1: { follow: 'chase', height: 6.5, distanceScale: 1.9, yawRate: 2.6, pitch: 0, lookAhead: 18, fov: 48, fovGain: 9, showModel: true },
    2: { follow: 'rigid', height: 0, distanceScale: 1, yawRate: 14, local: [0, 1.35, -0.6], pitch: -0.03, lookAhead: 0, fov: 66, fovGain: 22, showModel: true },
    3: { follow: 'rigid', height: 0, distanceScale: 1, yawRate: 14, local: [-0.32, 1.22, 0.15], pitch: -0.02, lookAhead: 0, fov: 74, fovGain: 14, showModel: false },
    4: { follow: 'chase', height: 42, distanceScale: 1, yawRate: 2.5, pitch: 0, lookAhead: 0, fov: 55, fovGain: 0, showModel: true },
};

const TRANSITION_SECONDS = 0.45;
const UP = new Vector3(0, 1, 0);

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Shortest signed angle from a to b. */
const angleDiff = (a: number, b: number) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
};

export class CameraController {
    private camera: PerspectiveCamera;

    // Free look state
    private freeLookYaw: number = 0;
    private freeLookPitch: number = 0;

    // Smoothed state
    private followYaw: number = 0;
    private carY: number = 0;
    private seeded: boolean = false;
    private orbiting: boolean = false;
    private time: number = 0;
    private accelShift: number = 0;   // smoothed pull-back from acceleration (m)

    // Mode switching: blend from the old view to the new one, measured relative to the car
    private lastMode: number = 0;
    private transition: number = 1;
    private fromPos = new Vector3();
    private fromLook = new Vector3();
    private lastPos = new Vector3();
    private lastLook = new Vector3();

    // Scratch vectors
    private carForward = new Vector3();
    private wantPos = new Vector3();
    private wantLook = new Vector3();
    private tmp = new Vector3();
    private tmpQuat = new Quaternion();

    constructor(camera: PerspectiveCamera) {
        this.camera = camera;
        // Cockpit views need a close near plane; the long far plane lets the road run to the haze
        camera.near = 0.3;
        camera.far = 3000;
        camera.updateProjectionMatrix();
    }

    /** Whether the car body should be drawn from the current point of view. */
    get showModel(): boolean {
        return MODES[this.lastMode]?.showModel ?? true;
    }

    /** Menu view: circle the parked car slowly, low and wide, like a showroom shot. */
    orbit(position: Vector3, carYaw: number, delta: number) {
        this.time += delta;
        const a = carYaw + Math.PI * 0.8 + this.time * 0.12;
        const r = 9.5;
        this.wantPos.set(position.x + Math.sin(a) * r, position.y + 2.2, position.z + Math.cos(a) * r);
        this.wantLook.set(position.x, position.y + 0.9, position.z);
        this.camera.position.lerp(this.wantPos, this.orbiting ? 1 - Math.exp(-3 * delta) : 1);
        this.orbiting = true;
        this.camera.lookAt(this.wantLook);
        this.camera.fov += (45 - this.camera.fov) * Math.min(2 * delta, 1);
        this.camera.updateProjectionMatrix();
        // When driving starts, blend from this view into the chase view
        this.seeded = false;
        this.lastMode = -1;
        this.lastPos.copy(this.camera.position).sub(position);
        this.lastLook.copy(this.wantLook).sub(position);
    }

    setFreeLook(_active: boolean, yaw: number, pitch: number) {
        // The store is the source of truth; yaw/pitch persist until it resets them
        this.freeLookYaw = yaw;
        this.freeLookPitch = pitch;
    }

    update(frame: CameraFrame) {
        const { position, rotation, delta, mode, distance, speed, longAccel, surface } = frame;
        const impact = frame.impact ?? 0;
        const setup = MODES[mode] ?? MODES[0];
        this.time += delta;

        // Heading of the car (angle about Y; forward = (-sin, 0, -cos))
        this.carForward.set(0, 0, -1).applyQuaternion(rotation);
        const carYaw = Math.atan2(-this.carForward.x, -this.carForward.z);

        this.orbiting = false;
        if (!this.seeded) {
            this.followYaw = carYaw;
            this.carY = position.y;
            this.seeded = true;
        }

        // Start a blend when the point of view changes
        if (mode !== this.lastMode) {
            this.fromPos.copy(this.lastPos);
            this.fromLook.copy(this.lastLook);
            this.transition = 0;
            this.lastMode = mode;
        }

        // The camera swings round behind the car a little late, which sells the turn
        const yawBlend = 1 - Math.exp(-setup.yawRate * delta);
        this.followYaw += angleDiff(this.followYaw, carYaw) * yawBlend;
        this.carY += (position.y - this.carY) * (1 - Math.exp(-10 * delta));

        if (setup.follow === 'chase') {
            // Accelerating eases the camera back a little, braking eases it in; speed adds a touch more.
            // Kept small and slow (it used to swing up to ~4 m back) so the car stays framed as at rest.
            const wantShift = Math.max(-0.35, Math.min(0.55, longAccel * 0.06));
            this.accelShift += (wantShift - this.accelShift) * (1 - Math.exp(-2.2 * delta));
            const speedPull = Math.min(speed / 50, 1.2) * 0.8;
            const back = distance * setup.distanceScale + this.accelShift + speedPull;
            const height = setup.height + Math.min(speed / 50, 1) * 0.4;

            // Offset behind the car along the smoothed heading, then rotated by free look
            this.tmp.set(0, height, back);
            this.tmpQuat.setFromAxisAngle(UP, this.freeLookYaw);
            this.tmp.applyQuaternion(this.tmpQuat);
            this.tmpQuat.setFromAxisAngle(UP, this.followYaw);
            this.tmp.applyQuaternion(this.tmpQuat);

            // Free look pitch tilts the camera up/down around the car
            this.tmp.y += this.freeLookPitch * back;

            this.wantPos.set(position.x + this.tmp.x, this.carY + this.tmp.y, position.z + this.tmp.z);

            // Aim along the camera boom, so a rapid turn cannot move the target behind the camera.
            // The car heading may be far ahead of the smoothed boom during a donut or reversal.
            const viewYaw = this.followYaw + this.freeLookYaw;
            this.wantLook.set(
                position.x - Math.sin(viewYaw) * setup.lookAhead,
                this.carY + 1.2,
                position.z - Math.cos(viewYaw) * setup.lookAhead,
            );
            if (mode === 4) {
                // Drone: straight down at the car, with only a touch of heading lead
                this.wantPos.set(
                    position.x + Math.sin(this.followYaw) * 14,
                    this.carY + setup.height,
                    position.z + Math.cos(this.followYaw) * 14,
                );
                this.wantLook.set(position.x, this.carY, position.z);
            }
        } else {
            // Seat: fixed in car space, turning with the car (a touch of smoothing only)
            const [lx, ly, lz] = setup.local!;
            this.tmp.set(lx, ly, lz);
            this.tmpQuat.setFromAxisAngle(UP, this.followYaw);
            this.tmp.applyQuaternion(this.tmpQuat);
            this.wantPos.set(position.x + this.tmp.x, this.carY + this.tmp.y, position.z + this.tmp.z);

            // Look straight down the road; free look turns the driver's head
            const lookYaw = this.followYaw + this.freeLookYaw;
            const lookPitch = setup.pitch + this.freeLookPitch;
            this.tmp.set(
                -Math.sin(lookYaw) * Math.cos(lookPitch),
                Math.sin(lookPitch),
                -Math.cos(lookYaw) * Math.cos(lookPitch),
            ).multiplyScalar(20);
            this.wantLook.copy(this.wantPos).add(this.tmp);
        }

        // Make the blend relative to the car so a fast car does not drag the old view behind
        if (this.transition < 1) {
            this.transition = Math.min(1, this.transition + delta / TRANSITION_SECONDS);
            const s = smoothstep(this.transition);
            this.wantPos.lerpVectors(this.fromPos.clone().add(position), this.wantPos, s);
            this.wantLook.lerpVectors(this.fromLook.clone().add(position), this.wantLook, s);
        }

        // Remember this view relative to the car, for the next switch
        this.lastPos.copy(this.wantPos).sub(position);
        this.lastLook.copy(this.wantLook).sub(position);

        // Rumble: off the asphalt the camera shakes, harder with speed
        const grass = 1 - surface;
        // A faint road buzz that grows past ~100 km/h tells the eye the car is fast without moving the frame
        const fast = Math.max(0, Math.min(1, (speed - 28) / 25));
        // No shake at all when parked: a constant 2 mm buzz made every small leaf flicker on and off
        const rumble = grass * Math.min(speed / 35, 1) * 0.035 + fast * 0.006 + impact * 0.35;
        if (rumble > 0.0005) {
            const t = this.time;
            this.wantPos.x += (Math.sin(t * 47) + Math.sin(t * 31.7)) * 0.5 * rumble;
            this.wantPos.y += (Math.sin(t * 53.3) + Math.sin(t * 37.1)) * 0.5 * rumble;
            this.wantLook.y += Math.sin(t * 41.9) * rumble;
        }

        // Never below the ground (or the road deck): free look tilted down used to sink the chase camera
        // up to ~5 m under the terrain. Seat views are inside the car and need no clamp.
        if (setup.follow === 'chase') {
            let floor = terrainHeight(this.wantPos.x, this.wantPos.z);
            const q = road.query(this.wantPos.x, this.wantPos.z);
            if (q && q.distance < 6) floor = Math.max(floor, this.carY - 0.6);
            this.wantPos.y = Math.max(this.wantPos.y, floor + 0.7);
        }

        this.camera.position.copy(this.wantPos);
        this.camera.lookAt(this.wantLook);

        // Wider lens as speed rises, so the road rushes past faster
        const targetFov = setup.fov + setup.fovGain * Math.min(speed / 50, 1);
        this.camera.fov += (targetFov - this.camera.fov) * Math.min(3 * delta, 1);
        this.camera.updateProjectionMatrix();
    }
}

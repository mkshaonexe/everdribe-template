import { Euler, Quaternion, Vector3 } from 'three';
import type { InputState } from './VehicleController';
import { groundAt, road, roadHeading, ROAD_STEP, WATER_LEVEL } from '../world/WorldGen';
import type { GroundSample } from '../world/WorldGen';
import { circlesNear, guardrailsNear } from '../world/Colliders';
import type { CircleCollider, SegmentCollider } from '../world/Colliders';

/**
 * Arcade-realistic car on a "bicycle" tyre model.
 *
 * The car keeps a heading (yaw) and a velocity that are free to differ: tyres push sideways in
 * proportion to how far each axle is slipping, up to the grip of the surface under it. Under normal
 * driving the tyres stay in their grip and the car follows the steering; the handbrake (Space) or too
 * much speed lets the rear step out, and the car slides until the driver counter-steers or lifts.
 *
 * All forces are per unit mass (m/s²). The heading convention matches three.js: the model's nose is -Z,
 * yaw rotates about +Y, positive yaw turns left.
 */

/**
 * A knock worth a sound: the start of a contact, a clearly harder knock during one, or a landing.
 * side: the obstacle is beside the car rather than in front or behind; air: seconds in the air before a landing.
 */
export interface ImpactEvent { strength: number; kind: string; side?: boolean; air?: number }

/** What the body is rubbing against this frame (kind '' = nothing) and how fast it slides along it, m/s. */
export interface ContactState { kind: string; slide: number }

/**
 * Handling the player can tune per car (menu → Handling). 1 (or the listed default) is the stock car.
 * Both cars are SUVs, so the stock drift is small: Space is mainly a hard brake.
 */
export interface Handling {
    steering: number;      // 0.5..1.5  steering angle and how fast the wheel turns
    grip: number;          // 0.8..1.3  cornering grip of all tyres
    drift: number;         // 0..1      how much the rear lets go when Space is used while steering
    driftAngle: number;    // 15..60    degrees: deepest slide before the tail is caught
    brake: number;         // 0.6..1.4  S (normal brake) strength
    handbrake: number;     // 0.5..1.5  Space (hard brake) strength
    power: number;         // 0.7..1.3  acceleration (top speed unchanged)
}

export const DEFAULT_HANDLING: Handling = {
    steering: 1, grip: 1, drift: 0.1, driftAngle: 15, brake: 1, handbrake: 1, power: 1,
};

// Geometry
const FRONT = 1.38;          // centre of mass to front axle (m)
const REAR = 1.38;           // to rear axle
const TRACK_HALF = 0.82;     // centre to wheel, sideways
const YAW_INERTIA = 1.55;    // k² in I = m k²
const COG_TRANSFER = 0.12;   // share of acceleration moved between axles (h / L); was 0.16, a tall SUV
                             // still leans forward under braking but no longer loses the rear from it

// Engine and resistance (m/s and m/s²): acceleration fades as speed nears the top speed
const TOP_SPEED = 53;        // ~190 km/h
const LAUNCH = 8.3;          // was 9.2; the owner's tuning (30 Oct) set acceleration to 90%
const BOOST_TOP = 66;        // ~238 km/h with Shift
const BOOST_LAUNCH = 12.6;   // was 14 (same 90%)
const POWER_CURVE = 2.2;
const REVERSE_TOP = 14;
const REVERSE_ACCEL = 5;
const AIR_DRAG = 0.00055;
const ENGINE_BRAKING = 1.4;
const BRAKE = 11;            // S while rolling forward
const REVERSE_BRAKE = 7;     // W while rolling backwards: slows to a stop, then drives forward
const HARD_BRAKE = 21;       // Space: all four wheels, well above S. Owner's tuning: 175% of the first 12

// Tyres
const GRAVITY = 14;          // a little heavier than real, for a planted feel
const GRIP_GAIN = 1.05;      // all tyres; owner's tuning (30 Oct), the Grip setting multiplies this
const STEER_GAIN = 1.05;     // steering angle and wheel speed; owner's tuning, the Steering setting multiplies this
const STIFF_FRONT = 7.5;     // how quickly lateral force builds with slip angle
const STIFF_REAR = 8.5;
const HARD_BRAKE_REAR_LOSS = 0.6; // rear grip lost under Space at full lock with drift = 1 (none when straight)
const DRIFT_HOLD_LOSS = 0.3;     // rear grip lost while a drift is held on the throttle, at drift = 1
const DRIFT_SPEED_KEEP = 0.65; // share of the speed a held drift would scrub that it keeps instead
const SPIN_ASSIST = 7;         // straightens the car once a slide passes ~30 degrees

// Stability control (on unless the driver asked for a slide with the handbrake). It lets the car turn as
// fast as the steering and the grip allow, and no faster, so a hard turn, a lift or a brake at speed
// makes the car run wide or slide a little instead of spinning.
const ESC_GRIP_USE = 0.9;      // share of the tyres' grip the car may use for turning (yaw ≤ that × g / v)
const ESC_RATE = 7;            // how fast extra yaw is taken away (1/s)
const SLIP_MAX = 0.16;         // ~9 degrees of body slip allowed outside a drift
const SLIP_RATE = 5;           // how fast a larger slip is pulled back (1/s)
const IMPACT_SPIN_MAX = 1.1;   // rad/s: the most a single knock may spin the car (it is a heavy SUV)

// W + S together: front brakes hold, the rear wheels spin, and with A or D the car turns on the spot,
// pivoting around its front wheels with the tail swinging out (a "donut")
const PIVOT_SPEED = 3;         // m/s: above this, W + S is a hard brake first
const PIVOT_RATE = 2.3;        // rad/s at full lock (~2.7 s per circle)

// Gearbox (for sound and the HUD; the drive curve above is what moves the car)
const GEAR_TOP = [0, 13, 23, 33, 43, 54, 68]; // m/s at the rev limit per gear
const IDLE_RPM = 900;
const REDLINE = 6900;

const tmpE = new Euler(0, 0, 0, 'YXZ');

export class VehiclePhysics {
    public position = new Vector3(0, 0, 0);
    public rotation = new Quaternion();
    public velocity = new Vector3();          // world, m/s (kept for camera and effects)
    public handling: Handling = { ...DEFAULT_HANDLING };

    // ---- State ----
    private yaw = 0;
    private yawRate = 0;
    private vLong = 0;       // along the nose
    private vLat = 0;        // to the right
    private vy = 0;
    private pitch = 0;
    private roll = 0;
    private lastGround = 0;
    private groundX = 0;
    private groundZ = 0;
    private safeX = 0;      // last good position, used to recover if the numbers ever break
    private safeZ = 60;
    private throttle = 0;
    private brakePedal = 0;
    private steer = 0;
    private onGround = true;
    private airTime = 0;
    private surface = 1;
    private grassFactor = 0;
    private longAccel = 0;
    private latAccel = 0;
    private rearSlip = 0;
    private frontSlip = 0;
    private driftHeld = 0;
    private inWater = 0;
    private burnout = 0;     // 0..1 while W + S are held at a stop (rear wheels spinning)

    // Gearbox
    private gearIndex = 1;
    private shiftTimer = 0;
    private rpmValue = IDLE_RPM;

    // Wheels (FL, FR, RL, RR): ground under each, for visuals and dust
    public wheelGround: GroundSample[] = [];
    public wheelWorld: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];

    public impacts: ImpactEvent[] = [];
    public contact: ContactState = { kind: '', slide: 0 };
    // A car pressed against a rail is pushed out every frame; these keep that from counting as a new hit
    private sinceTouch = 1;     // seconds since the body last touched anything
    private touchKind = '';
    private recentKnock = 0;    // m/s, the hardest knock of this contact, fading
    private circleBuf: CircleCollider[] = [];
    private segBuf: SegmentCollider[] = [];

    // ---- Read-outs ----
    get forwardSpeed() { return Math.abs(this.vLong); }
    /** Speed over the ground, including sideways sliding. */
    get groundSpeed() { return Math.hypot(this.vLong, this.vLat); }
    get signedSpeed() { return this.vLong; }
    get throttleAmount() { return this.throttle; }
    get longitudinalAccel() { return this.longAccel; }
    get lateralAcceleration() { return this.latAccel; }
    get surfaceGrip() { return this.surface; }
    get steerAmount() { return this.steer; }
    get grounded() { return this.onGround; }
    get rpm() { return this.rpmValue; }
    get gear() { return this.vLong < -0.5 && this.burnout === 0 ? -1 : this.gearIndex; }
    get shifting() { return this.shiftTimer > 0; }
    /** 0..1 how hard the tyres are sliding (for skid sound and smoke). */
    get skid() { return Math.min(1, Math.max(Math.max(this.rearSlip * 3.2, this.frontSlip * 2.2) * Math.min(1, Math.abs(this.vLong) / 6), this.burnout * 0.8)); }
    /** Angle between where the car points and where it goes, radians, + = sliding to the right. */
    get driftAngle() { return Math.abs(this.vLong) > 4 ? Math.atan2(this.vLat, Math.abs(this.vLong)) : 0; }
    get underwater() { return this.inWater > 0.4; }
    get headingYaw() { return this.yaw; }
    get airborneSeconds() { return this.airTime; }

    /** Put the car on the road nearest to a point, facing along it. */
    placeOnRoad(x: number, z: number, faceForward = true) {
        const i = road.nearestIndex(x, z);
        const s = i * ROAD_STEP;
        const p = road.at(s);
        // Road heading 0 = +Z; our yaw has the nose on -Z, so facing +Z is yaw = π
        const h = roadHeading(s);
        this.yaw = (faceForward ? Math.PI : 0) + h;
        this.position.set(p.x, p.y + 0.6, p.z);
        this.resetMotion();
        this.wheelPositions();
        this.lastGround = this.wheelWorld.reduce((sum, wheel) => sum + groundAt(wheel.x, wheel.z).height, 0) / 4;
        this.groundX = p.x; this.groundZ = p.z;
        this.onGround = true; this.airTime = 0;
        this.inWater = 0;
        this.updateRotation();
    }

    resetMotion() {
        this.vLong = 0; this.vLat = 0; this.vy = 0; this.yawRate = 0;
        this.throttle = 0; this.brakePedal = 0; this.steer = 0;
        this.longAccel = 0; this.latAccel = 0; this.driftHeld = 0; this.burnout = 0;
        this.gearIndex = 1; this.rpmValue = IDLE_RPM;
        this.velocity.set(0, 0, 0);
    }

    private updateRotation() {
        tmpE.set(this.pitch, this.yaw, this.roll, 'YXZ');
        this.rotation.setFromEuler(tmpE);
    }

    private wheelPositions() {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        // forward f = (-s, 0, -c), right r = (c, 0, -s)
        const local: [number, number][] = [[-TRACK_HALF, FRONT], [TRACK_HALF, FRONT], [-TRACK_HALF, -REAR], [TRACK_HALF, -REAR]];
        for (let i = 0; i < 4; i++) {
            const [lx, lf] = local[i];
            this.wheelWorld[i].set(
                this.position.x + lx * c - lf * s,
                0,
                this.position.z - lx * s - lf * c,
            );
        }
    }

    update(delta: number, input: InputState) {
        // Some browsers (Brave with Shields on) coarsen or repeat frame timestamps, so a frame can report
        // delta = 0. We divide by dt below, so keep it strictly positive and finite.
        const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 1 / 1000), 0.05) : 1 / 60;
        this.impacts.length = 0;

        // --- Ground under each wheel (once per frame) ---
        this.wheelPositions();
        for (let i = 0; i < 4; i++) {
            const g = groundAt(this.wheelWorld[i].x, this.wheelWorld[i].z);
            this.wheelGround[i] = g;
            this.wheelWorld[i].y = g.height;
        }
        const [fl, fr, rl, rr] = this.wheelGround;
        const gripFront = (fl.grip + fr.grip) / 2;
        const gripRear = (rl.grip + rr.grip) / 2;
        const rollRes = (fl.roll + fr.roll + rl.roll + rr.roll) / 4;
        const surfaceTarget = [fl, fr, rl, rr].reduce((a, g) => a + (g.surface === 'asphalt' ? 1 : g.surface === 'shoulder' ? 0.55 : 0), 0) / 4;
        this.surface += (surfaceTarget - this.surface) * (1 - Math.exp(-6 * dt));
        this.grassFactor = 1 - this.surface;
        const waterWheels = this.wheelGround.filter((g) => g.surface === 'water').length;

        // --- Pedals and wheel, smoothed ---
        const approach = (cur: number, target: number, rise: number, fall: number) =>
            cur + (target - cur) * (1 - Math.exp(-(Math.abs(target) > Math.abs(cur) ? rise : fall) * dt));
        this.throttle = approach(this.throttle, input.forward ? 1 : 0, 5, 8);
        // The pedal that points against the way the car is rolling is a brake: S going forward, W going
        // backwards, and both together at speed. Once the car is nearly stopped the same key drives it.
        const both = input.forward && input.backward;
        const wantBrake = (input.backward && this.vLong > 0.5) || (input.forward && this.vLong < -0.5)
            || (both && Math.abs(this.vLong) > PIVOT_SPEED);
        this.brakePedal = approach(this.brakePedal, wantBrake ? 1 : 0, 10, 14);
        const steerTarget = (input.left ? 1 : 0) - (input.right ? 1 : 0);
        // Wheel turns in a little slower than it used to (6.5/s), which reads as a heavier car
        const hs = STEER_GAIN * this.handling.steering;
        this.steer = approach(this.steer, steerTarget, 5 * hs, 8);

        // Steering angle shrinks with speed so the front tyres sit near their best slip angle,
        // and opens up again when the driver counter-steers a slide
        const v = Math.abs(this.vLong);
        const assistMax = Math.min(0.55, (1.25 * GRAVITY * 0.5 * (FRONT + REAR)) / Math.max(1, v * v) + 0.03);
        const slide = this.driftAngle;
        // Sliding right (slide > 0) means the nose points left of the path: steering right is counter-steer
        // (only for a real slide: a few degrees of normal cornering slip used to add half a radian of lock)
        const counter = Math.sign(this.steer) === -Math.sign(slide) ? Math.min(0.4, Math.max(0, Math.abs(slide) - 0.12)) : 0;
        const delta_ = this.steer * Math.min(0.55, (assistMax + counter) * hs);

        // --- Gearbox ---
        if (this.shiftTimer > 0) this.shiftTimer -= dt;
        // Engine speed follows road speed in the current gear; in first gear the clutch slips at low speed
        let rpmTarget = IDLE_RPM + (REDLINE - IDLE_RPM) * (v / GEAR_TOP[this.gearIndex]);
        if (this.gearIndex === 1) rpmTarget = Math.max(rpmTarget, IDLE_RPM + this.throttle * 2200);
        if (this.vLong < -0.5) rpmTarget = IDLE_RPM + (v / REVERSE_TOP) * 3500;
        if (this.burnout > 0) rpmTarget = Math.max(rpmTarget, IDLE_RPM + 4300 * this.burnout);
        const wheelspin = this.throttle * this.grassFactor * Math.max(0, 1 - v / 25) * 1400;
        this.rpmValue += (rpmTarget + wheelspin - this.rpmValue) * (1 - Math.exp(-12 * dt));
        if (this.shiftTimer <= 0 && this.vLong > 0) {
            const upAt = this.throttle > 0.6 ? 6400 : 4000;
            if (this.rpmValue > upAt && this.gearIndex < 6 && v > GEAR_TOP[this.gearIndex] * 0.5) {
                this.gearIndex++; this.shiftTimer = 0.18;
            } else if (this.gearIndex > 1 && v < GEAR_TOP[this.gearIndex - 1] * 0.62) {
                this.gearIndex--; this.shiftTimer = 0.12;
            }
        }
        if (v < 0.5) this.gearIndex = 1;

        const sampleX = this.position.x, sampleZ = this.position.z;

        // --- Physics, in small steps ---
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / steps;
        const prevLong = this.vLong;
        for (let n = 0; n < steps; n++) this.step(h, input, delta_, gripFront, gripRear, rollRes);

        // Smoothed accelerations as the driver feels them (tilt, camera)
        const blend = 1 - Math.exp(-8 * dt);
        this.longAccel += ((this.vLong - prevLong) / dt - this.longAccel) * blend;
        this.latAccel += (this.yawRate * this.vLong - this.latAccel) * blend;

        // --- Vertical: follow the ground, leave it over crests, land with a bump ---
        const groundY = (fl.height + fr.height + rl.height + rr.height) / 4;
        // Samples describe the position before this frame’s movement. Use distance and speed
        // for the slope rate, so a repeated or coarsened frame timestamp cannot cause a jump.
        const travelled = Math.hypot(sampleX - this.groundX, sampleZ - this.groundZ);
        const groundRate = travelled > 0.001 ? (groundY - this.lastGround) / travelled * this.groundSpeed : 0;
        this.lastGround = groundY;
        this.groundX = sampleX; this.groundZ = sampleZ;
        this.vy -= GRAVITY * dt;
        this.position.y += this.vy * dt;
        if (this.position.y <= groundY) {
            if (!this.onGround && this.vy < -2.5) this.impacts.push({ strength: Math.min(1, -this.vy / 14), kind: 'land', air: this.airTime });
            this.position.y = groundY;
            this.vy = Math.max(this.vy, Math.min(groundRate, 12));
            this.onGround = true;
            this.airTime = 0;
        } else if (this.position.y > groundY + 0.15) {
            this.onGround = false;
            this.airTime += dt;
        }

        // Body follows the ground's slope under the wheels; level out slowly in the air
        const targetPitch = Math.atan2((fl.height + fr.height) / 2 - (rl.height + rr.height) / 2, FRONT + REAR);
        const targetRoll = Math.atan2((fr.height + rr.height) / 2 - (fl.height + rl.height) / 2, TRACK_HALF * 2);
        const tilt = this.onGround ? 1 - Math.exp(-14 * dt) : 1 - Math.exp(-1.2 * dt);
        this.pitch += ((this.onGround ? targetPitch : this.pitch * 0.7) - this.pitch) * tilt;
        this.roll += ((this.onGround ? targetRoll : 0) - this.roll) * tilt;

        // --- Water ---
        if (waterWheels >= 2 && this.position.y < WATER_LEVEL + 0.5) {
            this.inWater += dt;
            this.vLong *= Math.exp(-2.5 * dt);
            this.vLat *= Math.exp(-2.5 * dt);
            if (this.position.y < WATER_LEVEL - 0.6) { this.position.y = WATER_LEVEL - 0.6; this.vy = Math.max(0, this.vy); }
        } else {
            this.inWater = 0;
        }

        // --- Collisions with scenery and guardrails ---
        this.collide(dt);

        // World velocity for the camera and effects
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        this.velocity.set(-s * this.vLong + c * this.vLat, this.vy, -c * this.vLong - s * this.vLat);

        // Safety: fell out of the world, or the numbers broke (NaN would hide the car and blank the screen)
        const broken = !Number.isFinite(this.position.x + this.position.y + this.position.z + this.vLong + this.vLat + this.vy + this.yaw);
        if (broken || this.position.y < -150) {
            this.placeOnRoad(broken ? this.safeX : this.position.x, broken ? this.safeZ : this.position.z);
        } else {
            this.safeX = this.position.x;
            this.safeZ = this.position.z;
        }

        this.updateRotation();
    }

    private step(h: number, input: InputState, delta: number, gripF: number, gripR: number, rollRes: number) {
        const v = Math.abs(this.vLong);
        const grounded = this.onGround;
        const speedBefore = Math.hypot(this.vLong, this.vLat);

        // --- Longitudinal ---
        const boost = input.boost && input.forward;
        const top = boost ? BOOST_TOP : TOP_SPEED;
        let launch = (boost ? BOOST_LAUNCH : LAUNCH) * (1 - 0.3 * this.grassFactor) * this.handling.power;
        if (this.shiftTimer > 0) launch *= 0.35;
        const both = input.forward && input.backward;
        const pivot = both && grounded && v < PIVOT_SPEED;
        let drive = 0;
        if (both) {
            drive = 0;
        } else if (input.forward && this.vLong > -0.5) {
            drive = launch * this.throttle * Math.max(0, 1 - Math.pow(Math.max(0, this.vLong) / top, POWER_CURVE));
        } else if (input.backward && this.vLong <= 0.5) {
            drive = -REVERSE_ACCEL * Math.max(0, 1 - v / REVERSE_TOP);
        }
        if (!grounded) drive = 0;

        let resist = AIR_DRAG * v * v;
        if (grounded) {
            resist += rollRes * (0.3 + 0.7 * Math.min(1, v / 8));
            resist += this.grassFactor * 0.07 * v;
            if (!input.forward && !input.backward) resist += ENGINE_BRAKING;
            if (this.vLong > top) resist += (this.vLong - top) * 0.8;
            resist += (this.vLong < 0 ? REVERSE_BRAKE : BRAKE * this.handling.brake) * this.brakePedal * (0.6 + 0.4 * Math.min(gripF, 1));
            // Space is the hard brake: all four wheels, limited by the grip under them
            if (input.brake) resist += HARD_BRAKE * this.handling.handbrake * Math.min(1, (gripF + gripR) / 2 + 0.2);
        }

        this.burnout = pivot ? Math.min(1, this.burnout + h * 3) : Math.max(0, this.burnout - h * 4);
        if (pivot) {
            this.pivotStep(h);
            return;
        }

        // --- Tyre grip, with weight shifting to the front under braking ---
        const ax = this.longAccel;
        const loadF = Math.max(0.2, 0.5 - COG_TRANSFER * ax / GRAVITY);
        const loadR = Math.max(0.2, 0.5 + COG_TRANSFER * ax / GRAVITY);
        const speedGrip = (1 + Math.min(v, 60) / 150) * GRIP_GAIN * this.handling.grip; // a touch of aero grip at speed
        let muR = gripR * speedGrip;
        // The rear lets go under Space only when the driver also steers, and only as much as the drift
        // setting allows. Braking in a straight line stays straight.
        const kick = input.brake && v > 3 ? this.handling.drift * Math.min(1, Math.abs(this.steer) * 1.5) : 0;
        if (kick > 0.05) {
            muR *= 1 - HARD_BRAKE_REAR_LOSS * kick;
            this.driftHeld = 1;
        } else if (this.driftHeld > 0) {
            // A started drift stays loose while the driver keeps the throttle in and the car sideways
            if (input.forward && Math.abs(this.driftAngle) > 0.12) muR *= 1 - DRIFT_HOLD_LOSS * this.handling.drift;
            else this.driftHeld = Math.max(0, this.driftHeld - h * 2.5);
        }
        const muF = gripF * speedGrip;
        const maxF = muF * GRAVITY * loadF * 2;
        let maxR = muR * GRAVITY * loadR * 2;
        // Driving force uses some of the rear tyres' grip (friction circle)
        const rearDrive = Math.min(Math.abs(drive) * 0.55, maxR * 0.95);
        maxR = Math.sqrt(Math.max(0.05, maxR * maxR - rearDrive * rearDrive));

        let fyF = 0, fyR = 0;
        if (grounded && v > 0.3) {
            const denom = Math.max(v, 2.5);
            const cd = Math.cos(delta), sd = Math.sin(delta);
            const latF = this.vLat - FRONT * this.yawRate;
            const latR = this.vLat + REAR * this.yawRate;
            const slipF = Math.atan2(latF * cd + this.vLong * sd, Math.max(Math.abs(this.vLong * cd - latF * sd), 2.5));
            const slipR = Math.atan2(latR, denom);
            fyF = -maxF * Math.tanh(STIFF_FRONT * slipF);
            fyR = -maxR * Math.tanh(STIFF_REAR * slipR);
            this.frontSlip = Math.max(0, Math.abs(slipF) - 0.12);
            // Hard braking leaves some tyre smoke and noise even when the car stays straight
            this.rearSlip = Math.max(0, Math.abs(slipR) - 0.1) + (input.brake && v > 3 ? 0.12 + 0.13 * kick : 0);
        } else {
            this.frontSlip = 0;
            this.rearSlip = 0;
        }

        // --- Integrate (car frame; see the derivation in the class comment) ---
        const cd = Math.cos(delta), sd = Math.sin(delta);
        const aLong = drive + fyF * sd;
        const aLat = fyF * cd + fyR;
        const torque = -FRONT * fyF * cd + REAR * fyR;

        // Resistance opposes the direction of travel and never reverses it
        const dir = Math.sign(this.vLong);
        if (dir !== 0) {
            const next = this.vLong + (aLong - dir * resist) * h;
            if (Math.sign(next) !== dir && !(drive !== 0 && Math.sign(drive) !== dir)) {
                this.vLong = 0;
            } else {
                this.vLong = next;
            }
        } else {
            this.vLong += aLong * h;
        }
        // In the turning car frame (f' = -ω r, r' = ω f): vLong' = a - ω vLat, vLat' = a + ω vLong
        const vLatBefore = this.vLat;
        this.vLat += (aLat + this.yawRate * this.vLong) * h;
        this.vLong -= this.yawRate * vLatBefore * h;
        this.yawRate += (torque / YAW_INERTIA) * h;

        if (grounded) {
            // Slow down sideways sliding a little extra on loose ground (the tyres dig in)
            this.vLat *= Math.exp(-this.grassFactor * 0.6 * h);
            // At walking pace, tyres simply roll where they point
            if (v < 1.5) {
                const kin = (this.vLong * Math.tan(delta)) / (FRONT + REAR);
                const t = 1 - Math.exp(-12 * h);
                this.yawRate += (kin - this.yawRate) * t;
                this.vLat *= 1 - t;
            }
        } else {
            this.yawRate *= Math.exp(-0.8 * h);
        }

        // Drift assist (arcade): a slide held on the throttle keeps most of its speed, and the car
        // turns itself back towards its path once the slide gets deep, so it rarely spins out
        if (grounded && this.vLong > 4) {
            const beta = Math.atan2(this.vLat, this.vLong);
            const deep = Math.abs(beta) - 0.5;
            if (deep > 0) this.yawRate -= Math.sign(beta) * deep * SPIN_ASSIST * h * (1 + deep * 4);
            const speedAfter = Math.hypot(this.vLong, this.vLat);
            if (this.driftHeld > 0 && input.forward && speedAfter < speedBefore && speedAfter > 1) {
                const k = (speedAfter + (speedBefore - speedAfter) * DRIFT_SPEED_KEEP * this.handling.drift) / speedAfter;
                this.vLong *= k;
                this.vLat *= k;
            }
        }

        if (grounded && this.driftHeld <= 0) this.stabilise(h, delta, gripF, gripR);
        // A drift may go as deep as the driftAngle setting, but not round: past it the tail is caught firmly
        if (grounded && this.driftHeld > 0 && v > 2) {
            const beta = Math.atan2(this.vLat, Math.abs(this.vLong));
            const over = Math.abs(beta) - (this.handling.driftAngle * Math.PI) / 180;
            // (the nose turning further into the slide has the same sign as the slip angle)
            if (over > 0 && Math.sign(this.yawRate) === Math.sign(beta)) {
                this.yawRate *= Math.exp(-(10 + over * 40) * h);
            }
            if (over > 0) this.rotateVelocityTowardsNose(over * (1 - Math.exp(-4 * h)));
        }

        this.yaw += this.yawRate * h;

        // Move in the world
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        this.position.x += (-s * this.vLong + c * this.vLat) * h;
        this.position.z += (-c * this.vLong - s * this.vLat) * h;
    }

    /**
     * Stability control. The fastest the car can turn on its grip is μ·g / v; the steering asks for
     * v·tan(δ) / L. Yaw beyond the smaller of the two (or against the steering) is taken away, and body
     * slip beyond SLIP_MAX is pulled back towards the nose, scrubbing a little speed as tyres would.
     */
    private stabilise(h: number, delta: number, gripF: number, gripR: number) {
        const v = Math.abs(this.vLong);
        if (v < 3) return;
        const mu = Math.min(gripF, gripR) * GRIP_GAIN * this.handling.grip;
        const limit = (ESC_GRIP_USE * mu * GRAVITY) / v;
        const asked = (this.vLong * Math.tan(delta)) / (FRONT + REAR);
        const ref = Math.max(-limit, Math.min(limit, asked));
        const over = Math.sign(this.yawRate) !== Math.sign(ref) || Math.abs(this.yawRate) > Math.abs(ref);
        if (over) this.yawRate += (ref - this.yawRate) * (1 - Math.exp(-ESC_RATE * h));
        if (this.vLong > 0) {
            const beta = Math.atan2(this.vLat, this.vLong);
            const extra = Math.abs(beta) - SLIP_MAX;
            if (extra > 0) this.rotateVelocityTowardsNose(extra * (1 - Math.exp(-SLIP_RATE * h)));
        }
    }

    /** Turn the velocity towards the nose by up to `angle` radians; speed is kept apart from a small scrub. */
    private rotateVelocityTowardsNose(angle: number) {
        const speed = Math.hypot(this.vLong, this.vLat);
        if (speed < 0.5) return;
        const fwd = this.vLong >= 0 ? 1 : -1;
        const beta = Math.atan2(this.vLat, fwd * this.vLong);
        const b = beta - Math.sign(beta) * Math.min(Math.abs(beta), angle);
        const kept = speed * (1 - 0.35 * Math.min(Math.abs(beta), angle));
        this.vLong = fwd * kept * Math.cos(b);
        this.vLat = kept * Math.sin(b);
    }

    /** W + S at a stop: brakes hold the front, the spinning rear swings the car round its front wheels. */
    private pivotStep(h: number) {
        this.vLong *= Math.exp(-6 * h);
        const target = this.steer * PIVOT_RATE;
        this.yawRate += (target - this.yawRate) * (1 - Math.exp(-4 * h));
        // Front axle stays put sideways: lateral speed there is vLat - FRONT·ω = 0
        this.vLat = FRONT * this.yawRate;
        this.frontSlip = 0;
        this.rearSlip = Math.abs(this.yawRate) * REAR * 0.3;
        this.driftHeld = 0;
        this.yaw += this.yawRate * h;
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        this.position.x += (-s * this.vLong + c * this.vLat) * h;
        this.position.z += (-c * this.vLong - s * this.vLat) * h;
    }

    private collide(dt: number) {
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        let touchKind = '', knock = 0, slide = 0, side = false;
        const circles = circlesNear(this.position.x, this.position.z, this.circleBuf);
        const segs = guardrailsNear(road.nearestIndex(this.position.x, this.position.z), this.segBuf);
        // The car as three circles along its length
        for (const along of [1.45, 0, -1.45]) {
            const px = this.position.x - s * along, pz = this.position.z - c * along;
            const pr = 1.0;
            let nx = 0, nz = 0, depth = 0, kind = '';
            for (const o of circles) {
                const dx = px - o.x, dz = pz - o.z;
                const d = Math.hypot(dx, dz);
                const pen = pr + o.r - d;
                if (pen > depth && d > 1e-4) { depth = pen; nx = dx / d; nz = dz / d; kind = o.kind; }
            }
            for (const g of segs) {
                const ex = g.bx - g.ax, ez = g.bz - g.az;
                let t = ((px - g.ax) * ex + (pz - g.az) * ez) / (ex * ex + ez * ez);
                t = Math.max(0, Math.min(1, t));
                const dx = px - (g.ax + ex * t), dz = pz - (g.az + ez * t);
                const d = Math.hypot(dx, dz);
                const pen = pr + 0.15 - d;
                if (pen > depth && d > 1e-4) { depth = pen; nx = dx / d; nz = dz / d; kind = g.kind; }
            }
            if (depth <= 0) continue;
            if (!touchKind) touchKind = kind;
            // Push out, then bounce the part of the velocity going into the obstacle
            this.position.x += nx * depth;
            this.position.z += nz * depth;
            const vx = -s * this.vLong + c * this.vLat;
            const vz = -c * this.vLong - s * this.vLat;
            const vn = vx * nx + vz * nz;
            slide = Math.max(slide, Math.hypot(vx - vn * nx, vz - vn * nz));
            if (-vn > knock) {
                knock = -vn; touchKind = kind;
                // The car's right is (cos yaw, -sin yaw): a normal along it means the obstacle is at the side
                side = along === 0 || Math.abs(nx * c - nz * s) > 0.7;
            }
            if (vn < 0) {
                const restitution = kind === 'guardrail' ? 0.15 : 0.3;
                const friction = kind === 'guardrail' ? 0.97 : 0.75;
                let nvx = vx - (1 + restitution) * vn * nx;
                let nvz = vz - (1 + restitution) * vn * nz;
                nvx = nvx * friction; nvz = nvz * friction;
                this.vLong = -s * nvx - c * nvz;
                this.vLat = c * nvx - s * nvz;
                // A hit off-centre spins the car: Δω = (r × J)_y / I, r = along * forward
                const jn = -(1 + restitution) * vn;
                // (a heavy SUV: a knock turns it a little, it does not spin it round)
                const spin = (along * (-c * nx + s * nz) * jn * 0.15) / YAW_INERTIA;
                this.yawRate += Math.max(-IMPACT_SPIN_MAX, Math.min(IMPACT_SPIN_MAX, spin));
            }
        }

        // One sound per contact: when it starts, or when a knock is clearly harder than the last one.
        // While the car only rubs along, the scrape loop (contact.slide) carries the sound, and it stops
        // the moment the car comes free.
        if (touchKind) {
            const fresh = this.sinceTouch > 0.25 || touchKind !== this.touchKind;
            if (knock > 1 && (fresh || knock > this.recentKnock + 3)) {
                this.impacts.push({ strength: Math.min(1, knock / 20), kind: touchKind, side });
            }
            this.recentKnock = Math.max(knock, this.recentKnock * Math.exp(-3 * dt));
            this.sinceTouch = 0;
            this.touchKind = touchKind;
        } else {
            this.sinceTouch += dt;
            this.recentKnock = 0;
        }
        this.contact.kind = touchKind;
        this.contact.slide = touchKind ? slide : 0;
    }
}

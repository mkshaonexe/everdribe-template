import { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CanvasTexture, Group, PerspectiveCamera } from 'three';
import { useCarModel, VehicleModel } from './VehicleModel';
import { VehiclePhysics } from './VehiclePhysics';
import { VehicleController } from './VehicleController';
import { CameraController } from './CameraController';
import { EngineAudio } from '../audio/EngineAudio';
import { ImpactAudio } from '../audio/ImpactAudio';
import { groundBareness, road } from '../world/WorldGen';
import { useGameStore, playerPose, vehicleState, driftState, VEHICLES, handlingFor } from '../stores/gameStore';

/**
 * The player's car: physics, input, camera, sound and the body on screen.
 * While the menus are open the car stays parked and the camera circles it slowly.
 */
export function Vehicle() {
    const groupRef = useRef<Group>(null);
    const bodyRef = useRef<Group>(null);
    const { camera } = useThree();
    const selected = useGameStore((s) => s.selectedVehicle);
    const config = VEHICLES.find((v) => v.id === selected) ?? VEHICLES[0];
    const model = useCarModel(config);
    const [braking, setBraking] = useState(0);

    const physics = useMemo(() => {
        const p = new VehiclePhysics();
        // Choose a different section of the same endless road for each fresh game load.
        const start = road.at((Math.random() * 2 - 1) * 3000);
        p.placeOnRoad(start.x, start.z);
        playerPose.x = p.position.x; playerPose.z = p.position.z;
        return p;
    }, []);
    const controller = useMemo(() => new VehicleController(), []);
    const cameraController = useMemo(() => new CameraController(camera as PerspectiveCamera), [camera]);
    const engineAudio = useMemo(() => new EngineAudio(), []);
    const impactAudio = useMemo(() => new ImpactAudio(), []);

    useEffect(() => {
        controller.attach();
        return () => controller.dispose();
    }, [controller]);
    useEffect(() => () => { engineAudio.stop(); impactAudio.stop(); }, [engineAudio, impactAudio]);

    // The selected car's handling, with the player's changes from the Handling menu
    const handlingChanges = useGameStore((s) => s.handling);
    useEffect(() => {
        physics.handling = handlingFor(config.id, handlingChanges);
    }, [physics, config.id, handlingChanges]);

    // Respawn when the pause menu asks for it
    const respawnAt = useGameStore((s) => s.respawnAt);
    useEffect(() => {
        if (respawnAt) physics.placeOnRoad(physics.position.x, physics.position.z);
    }, [respawnAt, physics]);

    // Body motion on top of the physics: pitch under acceleration, roll in corners, bounce on landing
    const body = useRef({ pitch: 0, roll: 0, pitchV: 0, rollV: 0, bounce: 0, bounceV: 0 });
    const lastStore = useRef(0);
    const waterTime = useRef(0);
    const calm = useRef(0);
    const brakeShown = useRef(0);

    useFrame((_state, delta) => {
        if (!groupRef.current) return;
        const dt = Math.min(delta, 0.05);
        const store = useGameStore.getState();
        const driving = store.phase === 'driving';

        // Input only counts while driving
        const input = driving ? controller.input : { forward: false, backward: false, left: false, right: false, brake: !driving, reset: false, boost: false, horn: false };
        if (driving && controller.input.reset) {
            physics.placeOnRoad(physics.position.x, physics.position.z);
            controller.input.reset = false;
        }
        physics.update(dt, input);

        // Fell into a river: back to the road after a moment
        if (physics.underwater && waterTime.current === 0 && driving) impactAudio.splash(physics.groundSpeed);
        waterTime.current = physics.underwater ? waterTime.current + dt : 0;
        if (waterTime.current > 1.8) {
            physics.placeOnRoad(physics.position.x, physics.position.z);
            waterTime.current = 0;
        }

        // ---- Collisions and landings: sound, shake, lose the drift combo ----
        for (const hit of physics.impacts) {
            if (hit.kind === 'land') {
                if (driving) impactAudio.land(hit);
                body.current.bounceV -= hit.strength * 2.2;
            } else if (hit.strength > 0.05) {
                if (driving) impactAudio.hit(hit);
                vehicleState.impact = Math.max(vehicleState.impact, hit.strength);
                driftState.combo = 0;
            }
        }
        vehicleState.impact *= Math.exp(-4 * dt);

        // ---- Share live state ----
        const speed = physics.groundSpeed;
        vehicleState.speed = speed;
        vehicleState.throttle = physics.throttleAmount;
        vehicleState.longAccel = physics.longitudinalAccel;
        vehicleState.lateralAccel = physics.lateralAcceleration;
        vehicleState.surface = physics.surfaceGrip;
        vehicleState.onGround = physics.grounded;
        vehicleState.steer = physics.steerAmount;
        vehicleState.rpm = physics.rpm;
        vehicleState.gear = physics.gear;
        vehicleState.skid = physics.skid;
        vehicleState.driftAngle = physics.driftAngle;
        vehicleState.vx = physics.velocity.x;
        vehicleState.vz = physics.velocity.z;
        vehicleState.inWater = physics.underwater;
        for (let i = 0; i < 4; i++) {
            const w = vehicleState.wheels[i];
            w.x = physics.wheelWorld[i].x; w.y = physics.wheelWorld[i].y; w.z = physics.wheelWorld[i].z;
            w.surface = physics.wheelGround[i]?.surface ?? 'asphalt';
        }
        playerPose.x = physics.position.x;
        playerPose.z = physics.position.z;
        // Nose direction is (-sin yaw, -cos yaw); the minimap wants atan2(forwardZ, forwardX)
        playerPose.yaw = Math.atan2(-Math.cos(physics.headingYaw), -Math.sin(physics.headingYaw));

        // ---- Drift score: points for speed x angle while sliding on the road ----
        const angle = Math.abs(physics.driftAngle);
        if (driving && angle > 0.22 && speed > 9 && physics.grounded && physics.surfaceGrip > 0.5) {
            driftState.combo += dt * speed * angle * 12;
            calm.current = 0;
        } else if (driftState.combo > 0) {
            calm.current += dt;
            if (calm.current > 0.7) {
                const score = Math.round(driftState.combo);
                if (score > 50) {
                    driftState.lastScore = score;
                    driftState.lastScoreAt = performance.now();
                    driftState.best = Math.max(driftState.best, score);
                }
                driftState.combo = 0;
            }
        }

        // ---- Sound ----
        if (store.phase !== 'loading') {
            // Share of wheels on each surface; the land under the car is split into grass and bare soil
            let shoulder = 0, land = 0;
            for (const g of physics.wheelGround) {
                if (g.surface === 'shoulder') shoulder += 0.25;
                else if (g.surface === 'grass') land += 0.25;
            }
            const bare = land > 0 ? groundBareness(physics.position.x, physics.position.z) : 0;
            engineAudio.update({
                rpm: physics.rpm,
                throttle: physics.throttleAmount,
                speed,
                skid: physics.skid,
                shoulder,
                grass: physics.grounded ? land * (1 - bare) : 0,
                dirt: physics.grounded ? land * bare : 0,
                shifting: physics.shifting,
                active: driving,
            });
            impactAudio.update(physics.contact, input.horn, driving);
        }

        if (driving && performance.now() - lastStore.current > 60) {
            store.setSpeed(speed);
            store.addDistance(speed * (performance.now() - lastStore.current) / 1000);
            lastStore.current = performance.now();
        } else if (!driving) {
            lastStore.current = performance.now();
        }

        // ---- Place the car and animate the body ----
        groupRef.current.position.copy(physics.position);
        groupRef.current.quaternion.copy(physics.rotation);
        const b = body.current;
        // A heavy body on soft springs: it leans into the load slowly, slightly overshoots and settles
        // (about 1.4 Hz, a little under critical damping), instead of snapping to the target angle
        const pitchTarget = Math.max(-0.06, Math.min(0.045, physics.longitudinalAccel * 0.0055));
        const rollTarget = Math.max(-0.075, Math.min(0.075, -physics.lateralAcceleration * 0.006));
        const K = 78, C = 12.5;
        b.pitchV += ((pitchTarget - b.pitch) * K - b.pitchV * C) * dt;
        b.pitch += b.pitchV * dt;
        b.rollV += ((rollTarget - b.roll) * K - b.rollV * C) * dt;
        b.roll += b.rollV * dt;
        // Spring for the landing bounce (softer, so the weight shows when the car lands)
        b.bounceV += (-b.bounce * 85 - b.bounceV * 9) * dt;
        b.bounce += b.bounceV * dt;
        if (bodyRef.current) {
            bodyRef.current.rotation.x = b.pitch;
            bodyRef.current.rotation.z = b.roll;
            bodyRef.current.position.y = Math.max(-0.12, b.bounce * 0.08);
            bodyRef.current.visible = cameraController.showModel || !driving;
        }
        const brakeTarget = driving && (controller.input.backward && physics.signedSpeed > 0.5 || controller.input.brake) ? 1 : 0;
        brakeShown.current += (brakeTarget - brakeShown.current) * (1 - Math.exp(-20 * dt));
        if (Math.abs(brakeShown.current - braking) > 0.05) setBraking(Math.round(brakeShown.current * 10) / 10);

        // ---- Camera ----
        // While the camera distance slider moves in Settings, show the real chase view behind the menu
        const previewCamera = performance.now() - store.cameraPreviewAt < 2500;
        if (driving || previewCamera) {
            cameraController.setFreeLook(store.isFreeLookActive, store.freeLookYaw, store.freeLookPitch);
            cameraController.update({
                position: physics.position,
                rotation: physics.rotation,
                delta: dt,
                mode: store.cameraMode,
                distance: store.cameraDistance,
                speed,
                longAccel: physics.longitudinalAccel,
                surface: physics.surfaceGrip,
                impact: vehicleState.impact,
            });
        } else {
            cameraController.orbit(physics.position, physics.headingYaw, dt);
        }
    });

    // Soft dark patch under the car: grounds it even where the sun's shadow falls elsewhere.
    // A centred ellipse that reaches zero well inside the square, so the plane's edges never show.
    // (It used to be drawn off-centre and never faded out, which showed as a rectangle under the car.)
    const contactShadow = useMemo(() => {
        const c = document.createElement('canvas');
        c.width = 128; c.height = 128;
        const ctx = c.getContext('2d')!;
        const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
        g.addColorStop(0, 'rgba(0,0,0,0.6)');
        g.addColorStop(0.45, 'rgba(0,0,0,0.42)');
        g.addColorStop(0.8, 'rgba(0,0,0,0.1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 128, 128);
        return new CanvasTexture(c);
    }, []);

    return (
        <group ref={groupRef}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={11} userData={{ noAO: true }}>
                <planeGeometry args={[model.width * 1.3, model.length * 1.18]} />
                <meshBasicMaterial map={contactShadow} transparent depthWrite={false} opacity={0.7} fog={false} toneMapped={false} polygonOffset polygonOffsetFactor={-4} />
            </mesh>
            <group ref={bodyRef}>
                <VehicleModel info={model} braking={braking} />
            </group>
        </group>
    );
}

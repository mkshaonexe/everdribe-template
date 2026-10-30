# Driving physics (EverDribe, v0.7.0)


One file: `everdribe-game/src/vehicle/VehiclePhysics.ts`. All tuning numbers are constants at its top.
Units: metres, seconds; forces are per unit mass (m/s²). Runs in steps of at most 1/240 s.

## Ground
No ray casts. Each wheel asks `groundAt(x, z)` in `world/WorldGen.ts`, which knows the road and the land
as functions: within 5 m of the road centre it is asphalt (grip 1.0), then 2.5 m of gravel shoulder
(0.82 → 0.70), then grass (0.68), and water below the river level. The car rests on the average height
of its four wheels and takes their slope as pitch and roll. Climbing gives it upward speed, so it can
leave the ground over a crest and lands with a bump (sound, body bounce).

## Grip and sliding ("bicycle" model)
The car has a heading and a velocity that may differ. Each axle's slip angle is how far its wheels move
sideways compared with where they point. Side force = grip × load × tanh(stiffness × slip), so it grows
with slip and then saturates. Braking moves load to the front axle (more front grip, a looser rear).
Engine force uses part of the rear grip (friction circle), so throttle in a bend can push the rear out.

- **Steering** shrinks with speed so the front tyres stay near their best slip angle, and opens up
  again when the driver counter-steers a slide.
- **Hard brake (Space):** all four wheels at 21 m/s² × the Hard brake setting (100→0 in 1.2 s, 17 m;
  S takes 2.5 s). Straight braking stays straight. Only with steering does the rear lose grip, by up to
  60% × the Drift setting (stock 10%, so the SUV barely slides).
- **Stock values (v0.7.1, the owner's tuning):** steering and grip × 1.05 (`STEER_GAIN`, `GRIP_GAIN`),
  launch 8.3 / boost 12.6 (90% of 9.2 / 14), hard brake 21 (175% of 12), drift 10%, drift angle 15°.
- **Holding a drift:** after a kick, rear grip loses 30% × Drift while the throttle is held and the car is
  sideways.
- **Handling settings** (`Handling` in `VehiclePhysics.ts`, menu → Handling, saved per car): steering,
  grip, drift, drift angle, brake, hard brake, acceleration.
- **Drift assist (arcade):** a held drift keeps 65% of the speed it would scrub, and past ~30° the car is
  turned back towards its path. Past the Drift angle setting (stock 15°) the tail is caught firmly, so a
  drift does not spin round.

## Stability control (v0.6.0)
Without it, a hard turn at 150 km/h with the throttle released spun the car 232° (measured in a headless
test). Now, unless a drift is held, every step:
- the car may turn no faster than `0.9 × grip × g / v` (what the tyres can hold) and no faster than the
  steering asks (`v × tan(δ) / L`); extra yaw is removed at 7/s;
- body slip beyond ~9° (`SLIP_MAX`) is turned back towards the nose at 5/s, scrubbing a little speed.
Weight transfer under braking is 0.12 (was 0.16). The counter-steer bonus now starts only past ~7° of slide.

## Pedals both ways
The pedal against the direction of travel is a brake: S going forward (11 m/s²), W going backwards
(7 m/s²). When the car is nearly stopped, the same key drives it the other way, without lifting.

## W + S (+ A/D): spin on the spot
Both pedals at a stop (below 3 m/s; above that they brake hard first): the car holds still, the rear
wheels spin (smoke, 5,200 rpm) and with A or D it turns round its front wheels at up to 2.3 rad/s
(~2.7 s per circle).

## Speed
```
drive      = launch × throttle × (1 − (speed / top)^2.2)      launch 8.3, top 53 m/s (Shift: 12.6, 66)
resistance = 0.00055·v² + surface rolling + 0.07·v on grass + 1.4 when coasting + brakes
```
Flat-road test, v0.7.1: 0–100 km/h 4.4 s (Shift 3.0 s), top 175 km/h (Shift 218). Older figure, launch 9.2,
measured on the hilly road with an autopilot (28 Oct 2026): 0–100 km/h 4.0 s, 0–160 km/h 8.9 s,
top about 174 km/h without boost, 121→0 km/h in 3.0 s, all six gears used (6th reached at about 145 km/h).

## Gearbox (sound and HUD)
Six gears, top speeds 13/23/33/43/54/68 m/s. rpm = 900 + 6000 × speed / gear top. Up at 6,400 rpm
(4,000 when cruising), down when the speed falls below 62% of the lower gear's top. Shifts cut power for
0.18 s. The engine sound follows this rpm.

## Collisions
Trees, rocks and buildings near the car are circles, guardrails are line segments (`world/Colliders.ts`).
The car is three circles along its length. A hit pushes the car out, bounces the velocity (restitution
0.15–0.3), turns the car a little if off-centre (at most 1.1 rad/s per knock; it used to be unlimited, so a
clip at speed spun the car), and reports an impact (crash or bump sound, camera shake, red
screen edge, drift combo lost).

## Water and resets
In water the car slows hard; after 1.8 s it is put back on the road. R does the same at any time.

# Vehicle module: interface and behaviour specification

This is the full outside contract of `js/vehicle.js`: what the game and the other
modules call, read and write, and how the car and the bus must behave. A replacement
module that meets this document and passes the bench works as a drop-in.

- **Bench:** `node tools/vehicle_bench.mjs --model js/vehicle.js --compare tools/vehicle_ref.json`
  drives the module through the same calls as `index.html` on a flat, empty Box2D world
  and prints old vs new with a per-value tolerance (exit 1 on any miss). The reference
  numbers are in `tools/vehicle_ref.json`. Run it with `--only car` for a quick check,
  or with `--json out.json` to save all numbers. It takes about 6 s.
- **Line numbers** below are from 2026-11-21. `index.html` is being edited, so search for
  the named function when a number no longer fits.
- **Units:** Box2D metres, seconds and radians. Speeds in this document are in km/h,
  yaw rates in deg/s and angles in degrees, unless the text says otherwise.

---

## 1. Frame and conventions

| Item | Convention |
|---|---|
| World axes | Box2D `x` = east, Box2D `y` = **south** (three.js X and Z). `getPosition()` returns `{x, y}` and the game reads `.y` as its `z`. |
| Heading | A **bearing** in radians. 0 = north (−y), and it grows **clockwise**: +π/2 = east. The forward unit vector is `(sin h, −cos h)` and the right unit vector is `(cos h, sin h)`. |
| Heading vs body angle | `getHeading()` must equal `vehicle.body.GetAngle()`. Other code combines the body's local frame with the heading (fixture overlap tests, cable test, wheel positions for dust). |
| Body-local frame | Forward is local **−y**, right is local **+x**. The collision outline and the wheels are laid out in this frame. |
| Position | `getPosition()` is the body's world centre. The centre of mass sits at the body origin (offset 0), so the origin, the world centre and `getPosition()` are the same point. |
| Steering sign | Lever **+1 = right** (ArrowRight). Right steering makes the heading **grow** (positive yaw rate). The drawn front-wheel angles are positive for a right turn. |
| Yaw rate | `body.GetAngularVelocity()` is in rad/s. Positive means clockwise, which is a right turn. |
| Gravity | The world has zero gravity (top-down). Slopes reach the vehicle only through `setAttitude`. |
| Step | Fixed at 1/60 s. `world.Step(1/60, 8, 3)` is followed by `world.ClearForces()`. The world is created with sleeping allowed (`new b2World(0-gravity, true)`). |

---

## 2. Module exports (all of them are imported, so a missing one breaks module loading)

| Export | Imported at | Type | Expected behaviour |
|---|---|---|---|
| `Vehicle` | index.html:93 | class | See §3. |
| `mapClamped(v, a0, a1, b0, b1)` | index.html:93. Used at 595, 599, 600 (camera zoom and look-ahead from `speedKmh`) | function | Maps `v` linearly from the range [a0, a1] to [b0, b1] and clamps the result to the output range. The output range may run downwards (b0 > b1). |
| `wrapAngle(a)` | index.html:93. Used at 716, 1008, 1012 | function | Wraps an angle in radians to (−π, π]. |
| `SOLID` | index.html:93 (addWall, about line 343), js/walls.js:21/152, js/bridges.js:21/101, js/clutter.js:13/142/154 | `{ friction: 0.35, restitution: 0 }` | The material of every static collider: building walls, level border, tree trunks, street obstacles and bridge rails. js/tunnels.js:136 and js/roofs.js:122 hard-code the same 0.35 / 0. Hitting a wall is a dull stop with no bounce (see §6.8). |
| `IMPACT` | js/dust.js:44, read at 287–289 | object, needs `dipPerMs` and `dipMax` | Describes the vehicle's own wall-hit nose-dip. `dipPerMs` is the dip amplitude in rad per m/s of impact speed (current value 0.0035). `dipMax` is the largest amplitude in rad (current value 0.045). Dust fires a "wall" puff when `|impactA| ≥ dipPerMs × 2 m/s` and scales it by `|impactA| / dipMax`, so these numbers must match the `impactA` that the vehicle produces. |
| `TRUNK` | js/clutter.js:13/143 | marker object, compared by identity | Fixture `userData` that clutter.js puts on round tree-trunk fixtures. The flag `TRUNK_SOLID` in clutter.js is currently off, so no fixture carries it today. If a fixture does carry it, a hit with the front or rear of the vehicle centred on that trunk must stop the vehicle dead. It must not glance off and slide round the trunk. A side graze still counts as an ordinary wall. |

---

## 3. The `Vehicle` object

### 3.1 Construction and lifetime

| Call | Where | Meaning |
|---|---|---|
| `new Vehicle(world, kind, x, y, heading, power, handling)` | index.html:539 `spawn()` | `world` is the b2World. `kind` is `'car'` or `'bus'`. `x, y` is the Box2D position of the body origin. `heading` is a bearing in rad. `power` is the engine multiplier from `?power=` (default 1). `handling` is the string from `?handling=` (default `'arcade'`). An unknown handling string must behave exactly like the default (bench: `opt.unknown_handling_is_default`). The vehicle creates its own bodies, fixtures and joints in `world`. |
| `destroy()` | index.html:538 | Removes every body and joint the vehicle created. The world body count after the next `spawn()` is the same as before (bench: `sp.swap.body_count_kept`). |

Right after construction, `spawn()` writes `maxSpeed` and then `speedLimit` / `reverseLimit` (§3.3). It calls `setAirborne(true)` when the swap happens in mid-air (index.html:542). After that it reads `vehicle.spec` (shadow, contact shadow, camera).

### 3.2 Per-step calls (index.html `stepOnce()`, lines 1300–1352), in this order

1. `setSteeringLever(l)` (1303). `l` is −1, 0 or +1: ArrowRight − ArrowLeft. Both keys held gives 0. During a rescue or scripted sequence (`sinking`) the game sends 0.
2. `setThrottle(t)` (1304). `t` is 0 or 1 (ArrowUp, or `?autodrive=` seconds at start). The vehicle clamps it to 0..1.
3. `setBrake(b)` (1305). `b` is 0 or 1 (ArrowDown). Clamped to 0..1. Touch pads send the same key events (js/touch.js), so input is always digital and both pedals can be held together.
4. The game logic may now change the bodies directly: the jump (`jumpStep`), the water/pit/no-drive/S-Bahn/roof triggers, and per-wheel grip on ice (§3.4).
5. `vehicle.noHold = !!sinking || edge.turning` (1326).
6. **`update(1/60)`** (1327). Applies the inputs. Must not call `world.Step`.
7. Static fixtures near the car are created or destroyed: walls.js, bridges.js, clutter.js.
8. `world.Step(1/60, 8, 3); world.ClearForces();` (1331–1332).
9. Post-step corrections by other modules, which may change velocities and positions of all vehicle bodies:
   - `edge.step` cushions at the level border and runs the turn-around.
   - `sbahn.step` and `tunnels.step` clamp the vehicle into a corridor with `SetPosition` and cut the inward velocity.
   - `roofs.step` sets collision masks.
10. **`lateUpdate(1/60)`** (1337). Wall-contact handling, impact read-outs, anything that must run after the step.
11. `setAttitude(pitch, roll)` (1347), from the road surface under the car. It is skipped while `held` is true and the surface has not changed (within 0.1 m and 2°).

The browser runs as many of these steps per frame as real time needs (at most 0.1 s of catch-up). The test hooks `berlinDrive.simulate` and `berlinDrive.steps` run them back to back.

### 3.3 Properties the game WRITES

| Member | Written at | Type / units | Meaning the vehicle must honour |
|---|---|---|---|
| `maxSpeed` | index.html:540 | m/s (160/3.6) | Absolute top speed in either direction. Measured free top speed is 160.2 km/h for both car and bus. |
| `speedLimit` | index.html:381 `applySpeedLimit()`, also from the Speed menu, `?maxspeed=` and `berlinDrive.speedLimit` | m/s, 0 = free | Forward speed limit. Full throttle holds it with no overshoot. When the limit drops below the current speed, the vehicle slows softly to the new limit (see §6.11). The limit can change at any time. |
| `reverseLimit` | index.html:382 | m/s, 0 = free | The same for reversing. The game always sets it equal to `speedLimit`. |
| `noHold` | index.html:1326 | bool | During rescues and turn-arounds: **no parking hold and no coast braking** (§6.10). |
| `brakeLock` | js/edge.js:192, js/sbahn.js:258 and 559 | bool, set to `false` | Written right after `reset()` plus velocities set on all bodies ("roll on"). Meaning: do not hold the vehicle braked. It must keep rolling with the velocity it was given and then coast normally (§6.10). A model without such a latch may treat it as a no-op, as long as the roll-on numbers still match. |
| `prevVel` | js/edge.js:192, js/sbahn.js:258 | `{x, y}` m/s | Written together with `brakeLock`: "this is the velocity of the previous step". It keeps the model from seeing a huge fake acceleration after a teleport with velocity. A model may ignore it, but it must then show no artefact (spin, jolt, dust burst) after a roll-on. |
| `wheels[i].grip` | index.html:1325 (only on frozen-water levels) | multiplier, default **1** | Surface grip per wheel: 1 = road, 0.25 = ice (rear wheels 0.7 × that). It scales engine, brakes and cornering of that wheel. It is never written on normal levels, so it must default to 1. |

### 3.4 Methods the game CALLS

| Method | Called at | Contract |
|---|---|---|
| `setSteeringLever(l)` | index.html:1303 | See §3.2. |
| `setThrottle(t)` / `setBrake(b)` | index.html:1304–1305 | See §3.2. |
| `update(dt)` | index.html:1327 | See §3.2. Also refreshes `speedKmh`. |
| `lateUpdate(dt)` | index.html:1337 | See §3.2. Sets `wallContact`, `impactPitch`, `impactA`, `impactT`. |
| `setAttitude(pitch, roll)` | index.html:1347 | Radians. Pitch is nose-up positive, roll is right-side-up positive. Echoed in `tilt` / `roll` (bench: `vis.attitude_echo`). With a pedal held, the slope pulls the vehicle along it. With no pedal, a parked vehicle stays put on any slope (bench: `stand.downhill5_drift` = 0). Fast changes from one step to the next (a rough road) add some resistance (§6.11). |
| `setAirborne(on)` | index.html:542, 1153, 1158, 1190; js/edge.js:171, 186 | While on, every own fixture (body and wheels) is a sensor and passes through walls, trunks and obstacles. The tyres have no grip, there is no engine, brake, steering, coast braking or parking hold, and the velocity carries on. Off restores everything. It may be called right after construction. |
| `reset(x, y, heading)` | index.html:824 `restart()`, 970 `respawnFromWater()`, 1445 `teleport()`, 1488; js/edge.js:189, and **every step during a turn-around** at 209 | Puts the whole vehicle (body and wheels, keeping their relative layout) at the pose. Zeroes all linear and angular velocities, selects the forward gear, clears inputs, wall contact and impact dip, and un-holds. After a reset with no key the vehicle stays exactly there. Throttle drives off normally (20.1 km/h after 2 s). `getPosition()` and `getHeading()` return the new pose at once (bench: `sp.teleport.*`). |
| `getPosition()` | about 40 places in index.html, plus edge, roofs, sbahn, balloon | `{x, y}` world centre (a fresh object is fine). |
| `getHeading()` | about 30 places | Bearing in rad, the same as `body.GetAngle()`. It may be any real number (not wrapped). |
| `destroy()` | index.html:538 | See §3.1. |

`getMass()` exists today but nothing outside the module calls it.

### 3.5 Properties the game and the modules READ

| Member | Read at | Type / units | What the reader expects |
|---|---|---|---|
| `specName` | index.html:818, 834, 864, 883; js/dust.js:183, 312 | `'car'` or `'bus'` | The kind passed to the constructor. |
| `spec` | index.html:550, 1435 (`fitContact(model, spec)`), 1339 | object | Real-size dimensions. **These are not the collision outline**: see §4. |
| `spec.bodyWidth` / `spec.bodyLength` | index.html:547–548 (shadow), 737–738, 765 (camera), 1094, 1106 (spot clear), 1245 (enclosed); js/edge.js:131; js/roofs.js:108; js/eggs.js:352 | m | car 1.81 × 4.495, bus 2.5 × 12.7. Used for shadows, camera framing, "does the car fit here" tests, egg touch, and the border gap. |
| `spec.wheelBase` / `spec.tread` | index.html:919, 922, 1314 (no-drive probe), 1340 (ride height sampling at ±wheelBase/2, ±tread/2) | m | car 2.65 / 1.35, bus 6.0 / 1.9. |
| `spec.wheelRadius` | index.html:479 | m | car 0.3106, bus 0.4. Values above 0.35 draw bigger tyre contact blobs. |
| `spec.brakeForce`, `spec.mass` | js/dust.js:299 | N, kg | Dust takes `4 × brakeForce / mass` as the "full braking" deceleration (car 8.53 m/s², bus 5.91 m/s²) and starts its braking stream at a fraction of it. Keep the ratio near the vehicle's real full-brake deceleration (measured mean from 50 km/h: car 9.3 m/s², bus 6.6 m/s²). `spec.mass` is 1500 kg (car) or 13000 kg (bus). |
| `speedKmh` | index.html:599–600 (camera), 1391 (speedometer), 1394 (minimap), 1398 (eggs), 1475 (`state()`), 1493 (map broadcast); js/balloon.js:506 (`< 3` = standing at the balloon) | km/h, ≥ 0 | Magnitude of the speed, refreshed in `update()` and exactly **0 while held** (within 0.5 km/h of the true body speed while driving). |
| `held` | index.html:1343, 1348; js/dust.js:321 | bool | True while the parking hold has the vehicle (§6.7). While it is true the game freezes the drawn pose and dust stops measuring road roughness. |
| `airborne` | js/edge.js:233 | bool | Mirrors the last `setAirborne()`. |
| `tilt` / `roll` | index.html:1364, 1373; js/dust.js:170, 270, 275–276 | rad | The last `setAttitude()` values (drawn car pose, contact shadow, dust height, roughness). |
| `impactPitch` | index.html:1364 | rad, nose-up + | A visual nose-dip added to the drawn pitch after a wall hit. Head-on at 30 km/h: it dips to −1.66° (nose down) about 0.09 s after the hit and fades with no overshoot. It is back to 0 by about 0.75 s. A tail-first hit dips the tail (+), and a side-on hit dips a little. |
| `impactA` | js/dust.js:287–289 | rad | Signed amplitude of the latest nose-dip: < 0 means nose first, > 0 means tail first. At 30 km/h head-on it is −0.029. See `IMPACT` in §2. |
| `impactT` | js/dust.js:270, 277 | s | Time since the latest impact. It must **drop** (to about one step) when a new impact starts, because dust detects a new hit by `impactT` getting smaller. Otherwise it grows every step. |
| `frontLAngle` / `frontRAngle` | index.html:1386–1387 (wheel meshes `WheelFL` / `WheelFR`, `rotation.y = −angle`) | rad, + = steered right | Drawn steering angle of each front wheel. The inner wheel turns more. Full lock right at rest: L 30.9°, R 40.7° (car), L 40.8°, R 49.9° (bus). At 50 km/h with the lock held: L 28.4°, R 36.7° (car), L 36.9°, R 44.6° (bus). |
| `squealLevel` | js/dust.js:313, 317 | 0..1 | Tyre squeal or slide strength, used for turn dust. Full lock at 50 km/h peaks at 0.5 for both car and bus. |
| `gear` | js/dust.js:182 | +1 forward, −1 reverse | The direction the drivetrain is engaged. Dust uses its sign when the vehicle is nearly stopped. |
| `wallContact` | index.html:1243 (`enclosed()`); js/dust.js:301 | object or `null`; only truthiness is read | Non-null on **every** step after which any own fixture touches a static, non-sensor fixture, including while resting against it. Null otherwise. The current object is `{nx, ny, impact, trunk}` (normal from wall to car, impact speed in m/s), but nobody outside reads the fields. |
| `steering.lever` | js/edge.js:168 (optional chaining) | −1, 0, +1 | The current lever. It picks the swing direction of a 180° turn-around (left if steering left). Missing is tolerated (treated as 0). |
| `body` | everywhere (below) | b2Body, dynamic | The main body (chassis). |
| `wheels` | index.html:868, 925, 1127, 1325; js/edge.js:133; js/sbahn.js:257, 310, 486, 558; js/roofs.js:133, 193; js/tunnels.js:149, 196; js/dust.js:166 | array of **exactly 4** objects `{ body, grip }` | Order **0 FL, 1 FR, 2 RL, 3 RR**. Indices 2 and 3 are the rear pair: ice gives the rear wheels less grip, and dust puffs from the rear wheels. `wheels[i].body` must be a Box2D body at that tyre. Dust places particles at its `GetWorldCenter()`, and the game uses it for the ice lookup. |

### 3.6 Box2D calls other code makes on the vehicle's bodies

The set "all vehicle bodies" means `[vehicle.body, ...vehicle.wheels.map(w => w.body)]`. Many modules loop over it.

| Call | On | Where | Expectation |
|---|---|---|---|
| `GetLinearVelocity()` | body | index.html:866, 935, 1141, 1393; dust 181, 266; sbahn 237, 309; roofs 192 | The vehicle's velocity in m/s. The returned vector may be live and gets mutated then written back (edge.js:221–223). |
| `SetLinearVelocity(v)` | **all** bodies | index.html:868 (swap), 925 (no-drive stop); edge.js:190, 223; sbahn.js:257, 310, 558; roofs.js:193 | The whole vehicle moves with that velocity from the next step on. Setting the same velocity on all bodies must be stable: no jolt or spin (bench: `sp.swap.*`, `sp.rollon_*`). |
| `SetLinearVelocity(v)` | **main body only** | index.html:1148 (jump push), 1184 (escape hop), 1254 (hop out) | Always while airborne or just before `setAirborne(true)`. The **whole vehicle** must carry that velocity: a 3.5 m/s push gives 2.10 m in 0.6 s airborne (bench: `sp.air.push_*`). The wheels must not soak it up. |
| `GetAngularVelocity()` / `SetAngularVelocity(w)` | body (all bodies to 0 at index 925, sbahn 310, roofs 193) | index.html:866, 869, 1185, 1255 | rad/s, clockwise +. |
| `SetLinearDamping(d)` / `SetAngularDamping(d)` | body | index.html:958 (2.5 / 2 while sinking), 964 (back to 0) | Plain Box2D damping on the main body must take effect. The vehicle itself expects 0 when nobody sets it. |
| `GetWorldCenter()` | body | sbahn.js:476, tunnels.js:173, dust 166 | Equals `getPosition()`. |
| `GetPosition()` / `SetPosition(p)` | **all** bodies | sbahn.js:486–489, tunnels.js:196–199 | The corridor clamp shifts every body by the same offset while the vehicle drives on. The vehicle must keep its speed and simply be displaced: a 1 m shift at 30 km/h is kept fully and the speed stays 30 (bench: `sp.shift.*`). |
| `GetFixtureList()` → first fixture → `GetShape()` | body | index.html:1092 `overlapsWorld()` (b2Shape.TestOverlap at a candidate pose), js/balloon.js:359–372 (`GetVertices()`, `GetVertexCount()`, plus `body.GetLocalPoint()`) | The **first fixture of the main body must be the collision outline as a b2PolygonShape** in body-local coordinates (§4). |
| fixture loop `GetFixtureList()/GetNext()`, `GetFilterData()/SetFilterData()` | **all** bodies | tunnels.js:149–152, roofs.js:133–136 | `maskBits` of every own fixture is set to 0x4000 (tunnel walls only) or 0x2000 (roof boxes only), and back to 0xFFFF. With the tunnel mask, ordinary walls are passed and tunnel-category walls stop the vehicle (bench: `sp.mask_*`). |
| `GetContactList()` (`e.contact`, `e.other`, `e.next`, `contact.FlagForFiltering()`, `contact.GetWorldManifold()`) | **all** bodies | index.html:1127 `awayFromContacts()` (sums static contact normals to find which way to push a stuck car), tunnels.js:153, roofs.js:137 | Ordinary Box2D contacts: the vehicle's fixtures touch static fixtures directly. |

---

## 4. Bodies, fixtures, collision

- **Bodies.** One dynamic main body plus four dynamic wheel bodies, all created in the
  game's world. Measured wheel centres in the main body's frame:
  car FL (−0.675, −1.25), FR (0.675, −1.25), RL (−0.675, 1.40), RR (0.675, 1.40).
  Bus FL (−0.95, −2.75), FR (0.95, −2.75), RL (−0.95, 3.25), RR (0.95, 3.25).
  Each wheel stays rigidly at its place relative to the main body and steers about it.
  All velocity and contact behaviour in §6 is for this assembly.
- **Mass.** `body.GetMass()` and `getMass()` give 1500 kg (car) and 13000 kg (bus) for the
  main body. The centre of mass is at the body origin.
- **Collision outline** (first fixture of the main body, a polygon):

  | | car | bus |
  |---|---|---|
  | width (local x) | 1.67 m | 2.50 m |
  | length (local y) | 4.30 m | 12.70 m |
  | origin to nose | 2.149 m | 6.35 m |
  | origin to tail | 2.151 m | 6.35 m |
  | vertices | 10 (chamfered nose and tail) | 8 (slightly chamfered corners) |

  The car's outline is narrower and shorter than `spec.bodyWidth` / `bodyLength`
  (1.81 × 4.495). Game code uses `spec` for "does it fit" tests and the outline for
  contacts, so keep both.
- **Wheel fixtures** are small boxes inside the outline. Touching a wall with a wheel
  counts like touching it with the body (`wallContact`, `awayFromContacts`).
- **Filters.** The main body's fixtures use category 0x0001, the wheels' use 0x0002. Masks
  collide with everything (0xFFFF or 0x7FFF) by default. No own fixture is a sensor on the
  ground. Other categories in the world: tunnel walls 0x4000, roof boxes 0x2000 (also the
  roof bear sensors in js/eggs.js:316), and everything else 0x0001.
- **What the vehicle meets:**
  - Static bodies with `SOLID` material: the building walls (`wallBody`, js/walls.js cell
    bodies), the level border (index.html `addWall`, oriented boxes 0.3 m half-thickness),
    trunks (circles) and street-obstacle segments (js/clutter.js cell bodies, switchable),
    bridge rails, tunnel walls and roof boxes.
  - The balloon platform (static circle).
  - Football goals and bear sensors (js/eggs.js).
  - One dynamic **football** (radius 1.5 m, 30 kg, restitution 0.6). The football is a
    toy: a parked vehicle is not moved by it (§6.7), and a moving vehicle pushes it away.
- The world's static bodies are created and destroyed between `update()` and `world.Step()`
  (streamed cells). The vehicle must not cache fixtures of other bodies across steps.

---

## 5. Settings of the default game and URL options

The game constructs the vehicle with `power = 1` and `handling = 'arcade'`, sets
`maxSpeed = 160 km/h` and `speedLimit = reverseLimit = 50 km/h` (the Speed menu default,
saved in localStorage). These are the settings the bench uses unless a test says otherwise.

What the options do, as the user sees them:

| Option | Effect |
|---|---|
| Speed menu / `?maxspeed=N` | Top speed in km/h, forward **and** backward. The menu offers 30, 50, 70 and free (0). `?maxspeed=` accepts any value ≥ 0 and is not saved. 0 = free (up to 160 km/h). A new value takes effect immediately, also while driving. |
| `?power=P` | Engine strength multiplier (default 1). It changes the pull-away when the Speed is free: car 0–50 km/h in 7.0 s at `power=0.5`, 3.0 s at 1, 1.4 s at 2 (bus 11.8 / 4.6 / 2.1 s). With a speed limit, pull-away is gentle and the same for every power that is strong enough: 0–40 km/h takes 3.98 s at power 1 and 2. A weak engine is slower: 5.6 s (car) and 9.4 s (bus) at `power=0.5`. |
| `?handling=NAME` | Handling preset. Only the default (`arcade`) must be matched. An unknown name, including the one suggested in an index.html comment, must give the default. The current module also accepts `classic` (looser tyres, slower steering, no self-centring at rest). A rewrite may support it, but it is not required. |
| `?carscale=S` | Purely visual: it scales the drawn model, shadows and camera framing. The physics (outline, wheels, mass) does not change. |
| `?autodrive=T` | Holds the throttle for the first T seconds (testing). |
| `?icegrip=G` | Grip on frozen water (default 0.25; the rear wheels get 0.7 × G). Only on frozen levels. |

---

## 6. Behaviour (numbers from `tools/vehicle_ref.json`, flat ground, default game)

The bench prints all of these. "Stopped" means below 0.5 km/h. Values are listed as car / bus.

### 6.1 Pull-away, full throttle from rest, Speed 50
- Both vehicles accelerate the same calm way: **10.1 / 20.1 / 30.2 / 46.5 / 49.8 km/h after
  1 / 2 / 3 / 5 / 8 s**. That is 0→10 in 1.0 s (1.4 m), →20 in 2.0 s (5.6 m), →30 in 2.98 s
  (12.5 m), →40 in 3.98 s (22.3 m) and →49 in 6.27 s (51.6 m).
- The limit is approached from below **without overshoot**. Exactly 50.0 is only reached
  asymptotically (the bench records "never quite 50"). The steady top speed is **50.0 km/h**.

### 6.2 Pull-away with Speed free
- Car: 10/20/30/40/50/100 km/h after 0.6/1.2/1.8/2.4/3.0/6.1 s (50 reached in 21.1 m).
  Speed after 1/2/3/5/8 s is 16.8/33.6/50.1/82.7/129.1 km/h.
- Bus: 10/20/30/40/50/100 km/h after 0.92/1.83/2.75/3.67/4.6/9.2 s. Speed after 1/2/3/5/8 s
  is 11.0/21.9/32.8/54.5/87.0 km/h.
- Top speed 160.2 km/h (the `maxSpeed` cap) for both.

### 6.3 Full braking (brake held), stopped below 0.5 km/h
- From 50 km/h: car 1.50 s / 10.3 m, bus 2.10 s / 14.5 m.
- From 30 km/h: car 0.90 s / 3.70 m, bus 1.25 s / 5.21 m.
- Keeping the brake held after the stop engages reverse. The vehicle starts rolling
  backwards about 0.45 s after it stopped: from 50 at 1.95 / 2.53 s, from 30 at 1.35 / 1.70 s.
- Both pedals held together: braking wins (the car from 30 is stopped after 2 s, the bus
  is down to 4.7 km/h), and from rest nothing happens (≈ 0.1 km/h).

### 6.4 Releasing all keys (coasting)
- With no pedal the vehicle brakes by itself (moderate engine and coast braking) and then
  parks (§6.7).
- From 50 km/h: **car 2.78 s / 19.3 m**, bus 3.82 s / 26.5 m.
- From 30 km/h: car 1.67 s / 6.95 m, bus 2.28 s / 9.52 m.
- On an uneven road (ride pitch ±1° at 2 Hz) from 50: car 2.60 s / 18.0 m, bus 3.77 s / 26.2 m.
- Owner-accepted reference: about 2.75 s and 18.5 m from 50. The flat bench gives 2.78 s /
  19.3 m and the uneven road gives 2.60 s / 18.0 m, so the reference lies between the two.

### 6.5 Reverse
- Rule: hold the brake while (nearly) standing. After a short delay the gear changes and the
  vehicle drives backwards. The brake key then acts as the throttle for reverse, and the
  throttle key brakes. In the same way, holding the throttle while reversing first brakes to
  a stop, then the vehicle drives forward again.
- From standstill with the brake held, Speed 50: rolling backwards at 1 km/h after **0.52 s**.
  10/20/30/40 km/h backwards after 1.42/2.42/3.40/4.40 s (car and bus alike). Speed after
  1/2/3/5 s is 5.9/15.9/26.0/44.6 km/h. Reverse top speed **50.0 km/h** (= `reverseLimit`).
  `gear` is −1 while reversing.
- Speed free: the car is at 10/20/30/40 km/h after 1.02/1.62/2.22/2.82 s and the bus after
  1.33/2.25/3.17/4.08 s. The top speed is 160.2 km/h backwards too.
- Reversing at 20 km/h, then throttle: car stopped after 0.60 s and rolling forward
  (1 km/h) after 1.10 s. Bus 0.83 s / 1.32 s.

### 6.6 Steering
**Steady turn at full lock right, throttle held, Speed limit set to the target:**

| target km/h | speed held | yaw rate deg/s | path radius m | body slip deg |
|---|---|---|---|---|
| car 10 | 10.6 | 43.2 | 3.91 | 18.8 |
| car 20 | 21.2 | 84.0 | 4.02 | 19.2 |
| car 30 | 30.3 | 113.0 | 4.27 | 17.1 |
| car 40 | 35.7 | 120.3 | 4.72 | 13.1 |
| car 50 | 41.2 | 102.4 | 6.41 | 9.1 |
| bus 10 | 10.5 | 24.9 | 6.71 | 26.7 |
| bus 20 | 20.7 | 45.4 | 7.25 | 25.4 |
| bus 30 | 26.3 | 33.3 | 12.6 | 13.8 |
| bus 40 | 34.5 | 24.5 | 22.4 | 7.2 |
| bus 50 | 43.9 | 19.6 | 35.6 | 4.1 |

The radius is the path radius of the vehicle centre (speed ÷ yaw rate). Slip is the angle
between heading and velocity. At low speed most of the slip is geometric, because the centre
sits ahead of the rear axle. The available lock shrinks with speed, so the full-lock radius
grows above about 20 km/h. Turning costs speed: with throttle held the car only holds 41 km/h
in a full-lock circle at the 50 limit. While the key is held, the steering stays at that
speed-reduced full lock and does not pull back to centre against the key.

**Step steer, full lock right applied at once while cruising (throttle held):**
- Heading change after 0.25 / 0.5 / 1 / 2 s:
  - car at 30: 10.6 / 35.6 / 90.7 / 202.6°
  - car at 50: 10.4 / 29.0 / 71.9 / 169.3°
  - bus at 30: 2.5 / 8.0 / 21.0 / 51.2°
  - bus at 50: 2.6 / 7.0 / 16.0 / 34.8°
- Yaw rate after 2 s: car 112.6 / 100.7 deg/s, bus 31.8 / 19.1 deg/s.
- Steering released: the wheel centres itself quickly. The yaw rate falls below 2°/s
  within 0.33 s (car at 30), 0.40 s (car at 50), 0.40 s (bus at 30) and 0.42 s (bus at 50).
  The heading moves on by 11.1 / 12.9° (car) and 5.9 / 5.3° (bus) after release. Speed
  goes back to the limit.

**Slalom at 40 km/h, full lock alternating right/left every 1 s for 8 s, throttle held:**
car peak lateral offset 64.4 m, peak yaw rate 117.3 deg/s, final speed 35.4 km/h,
final heading +46.8°. Bus: 27.1 m, 27.2 deg/s, 36.6 km/h, +20.6°.

**In the air** (`setAirborne(true)`): full lock and brake have no effect. The heading change
is 0° and 50 km/h becomes 49.8 km/h after 0.6 s (air drag only).

### 6.7 Standstill and parking hold
- With **no key** (no pedal and no steering) and the vehicle slower than 0.5 km/h and hardly
  turning, it is **held**: every body is exactly at rest, `held = true` and `speedKmh = 0`.
  It stays held until a key arrives.
- The hold also applies on slopes. Parked on a 5° downhill with no key: 0 m drift in 5 s.
- A held vehicle is immovable for other dynamic bodies: the 30 kg football at 10 m/s moves a
  parked car by at most 3 mm and does not turn it. The ball bounces back.
- No hold while airborne or with `noHold`.
- Steering at rest (left and right for 1.5 s each, no pedal): the vehicle does not move or
  turn (0 m, 0°). The front wheels still turn visibly.
- Throttle tapped for 0.3 s from rest: the vehicle rolls 0.20 m (bus 0.22 m), peaks at
  3.0 km/h and is held again 0.50 s (bus 0.53 s) after the release.
- After construction or `reset()`, the vehicle stands still until the throttle (drive away)
  or the brake (reverse) is pressed.

### 6.8 Wall hits (static box, `SOLID` material)
**Head-on at 30 km/h** (throttle until the hit, then all keys released):
- Dull and heavy stop with no bounce. Forward speed is 0.05 / 0.09 km/h 0.1 s after the
  hit and 0 at 0.5 s.
- **Rebound distance 0 m.** Heading change after 2 s: 0.28 / 0.27°.
- `wallContact` is non-null from the hit step on (impact ≈ 8.3 m/s). Nose-dip as in §3.5.

**Throttle held against the wall for 3 s:** the vehicle stays pressed. It moves 0.11 / 0.18 m
in total, turns at most a few degrees (2.5 / 1.5°), does not climb or spin, and its speed
stays ≈ 0.

**Glancing, wall 30° off the heading, 30 km/h, throttle held:** the vehicle scrapes along
the wall and turns toward parallel:
- Heading after 0.5 s: +18.0° (car), +17.1° (bus). After 2 s: +26.0° and +26.3°, where
  30° would be exactly parallel.
- Car: speed 8.8 km/h after 0.5 s and 2.6 km/h after 1 s. Travelled 3.1 m along the wall
  in 2 s. Centre 1.39 m from the wall line.
- Bus: 27.5 and 27.1 km/h. 14.8 m along the wall. Centre 1.71 m from the wall line.
- It never bounces off or spins away.

### 6.9 Ice (per-wheel grip 0.25 front, 0.175 rear)
- Full throttle 0→30 km/h: car 7.05 s, bus 16.5 s.
- Full braking from 30: car 4.20 s / 17.6 m, bus 5.88 s / 24.8 m.

### 6.10 Special entry points (other modules driving the vehicle directly)
- **Teleport** (`reset` while driving at 50 km/h): the pose is exact, the speed is 0
  afterwards, and there is no drift in 2 s with no key.
- **Vehicle swap** (B key or menu, index.html `setVehicle()` at 857): `destroy()`, a new
  vehicle of the other kind at the same pose, and the old velocity set on all bodies (plus
  angular velocity on the main body). It carries straight on: 49.997 km/h after one step and
  49.999 km/h after 1 s with throttle held (car→bus and bus→car).
- **Roll-on** (js/sbahn.js leaving a station at 30 km/h; js/edge.js turn-around roll-out at
  3 m/s):
  1. `reset()`
  2. velocity set along the heading on all bodies
  3. `brakeLock = false` and `prevVel` set
  4. no key held

  The vehicle keeps the speed (29.7 km/h, and 10.5 km/h for the 3 m/s case, after one
  step), then coasts and parks:
  - from 30 km/h: car stops after 1.65 s and 6.95 m, bus after 2.27 s and 9.52 m
  - from 3 m/s: car stops after 0.58 s and 0.89 m, bus after 0.78 s and 1.22 m
- **Turn-around** (U key, js/edge.js): `setAirborne(true)`, then `reset()` to an animated
  pose on every step for 1.8 s, then `setAirborne(false)` and a roll-on at 3 m/s. The vehicle
  must accept a `reset()` on every step.
- **Jump** (Space): `setAirborne(true)` for about 0.75 s. Standing still, the main body
  alone first gets a 3.5 m/s push (the whole vehicle moves 2.10 m in 0.6 s). The vehicle
  flies straight through walls. On landing, `setAirborne(false)` and normal braking: from
  50 km/h, braking 0.5 s after landing gives 32.1 / 37.5 km/h. A vehicle spawned airborne
  keeps the velocity given to it (36 km/h → 35.9 km/h after 0.5 s).
- **Rescue sequences** (water, pit, no-drive zone, S-Bahn door, roof lift):
  - The game zeroes all velocities and sets damping on the main body. It sends no input,
    and `noHold = true`. It moves only the drawn model, then calls `reset()` at the
    set-down point.
  - `noHold`: no coast braking and no hold. From 30 km/h with no key the vehicle still
    has 25.0 / 25.2 km/h after 2 s. A creep of 0.36 km/h is not held (it moves 0.034 m in 1 s).
- **Tunnel / roof masks:** the masks are written on all own fixtures and contacts are
  re-flagged (§3.6). The vehicle must keep working with any `maskBits` on its fixtures.
- **Corridor clamp** (S-Bahn viaduct, tunnels): `SetPosition` shifts all bodies. The
  vehicle continues with unchanged speed (30.0 km/h) and the shift is kept (1.00 m).
- **Slopes** (`setAttitude`): with the throttle held and Speed 50, the vehicle holds 50.0 km/h
  both up and down a 5° slope. Holding the brake at rest on a 5° uphill engages reverse as
  on flat ground: it moves 0.21 m backwards between 0.5 s and 0.8 s.

### 6.11 Speed governor details
- The speed limit holds on slopes and on rough roads: 50.0 km/h after 20 s for all of
  them.
- Speed limit lowered from 70 to 30 while cruising with throttle held: the vehicle slows
  softly. Car 58.1 / 46.4 km/h after 1 / 2 s and 31 km/h after 4.85 s. Bus 58.5 / 47.1 km/h
  and 4.92 s. It then holds 30.0.

---

## 7. Easy to get wrong

1. **Call order per step:** inputs → `update()` → (static fixtures change) →
   `world.Step` → other modules move bodies and velocities → `lateUpdate()` →
   `setAttitude()`. `update()` must not step the world. Wall-hit handling has to work
   after the step, because only then are the contacts current.
2. **Heading sign:** a bearing, clockwise positive, forward is local −y. A rewrite with the
   usual Box2D forward (+x or +y) breaks the camera, dust, the edge test, spot tests, the
   S-Bahn and roof triggers and the jump push direction.
3. **Exactly zero speed:** parked means all bodies at exactly zero velocity, `held = true`
   and `speedKmh = 0`, so the drawn car does not tremble and the ball cannot push it.
   Below 0.5 km/h with no key the vehicle snaps to the hold. Steering alone is a key, but
   it must not move a standing vehicle.
4. **Reverse engagement:** only by holding the brake while (nearly) standing still, after
   a short delay. Throttle while reversing brakes first and then drives forward. A tap on
   the brake at rest must not lurch the vehicle backwards immediately.
5. **Both pedals at once** are possible (keyboard and touch): braking wins.
6. **Coast braking off** while airborne and while `noHold` is true. The rescue sequences
   and the turn-around rely on it.
7. **After `reset()` the vehicle is braked** until the throttle or brake is pressed, unless
   a module then writes `brakeLock = false` (roll-on). Both must work.
8. **Velocities set on the main body alone** (jump push, escape hop) must carry the whole
   vehicle. **Velocities set on all bodies** (swap, roll-on, cushion, stops) must not
   create a jolt or spin.
9. **Exactly four wheel bodies in the order FL, FR, RL, RR**, each a real Box2D body at
   its tyre. Many modules loop over `[body, ...wheels.map(w => w.body)]` to set velocities,
   positions and collision masks. Dust and the ice lookup use the wheels' world centres.
10. **The first fixture of the main body is the polygon outline.** The spot-overlap test
    and the balloon cable test read it.
11. **`spec` sizes ≠ collision outline** (car 1.81 × 4.495 vs 1.67 × 4.30). Both are used.
12. **`wallContact` is truthy on every step while touching**, not only on the impact step.
    The "enclosed in a building" rescue and dust depend on it.
13. **`impactT` must reset at each new impact**, because dust detects hits by it decreasing.
    `impactA` and the exported `IMPACT.dipPerMs` / `dipMax` must agree.
14. **The limit is approached from below** with no overshoot. `speedLimit = 0` means free.
    The reverse limit applies backwards, and `maxSpeed` caps everything at 160 km/h.
15. **`wheels[i].grip`** must default to 1 and act per wheel (rear lower on ice).
16. **Unknown `?handling=` values** behave exactly like the default.
17. **Static fixtures appear and disappear between steps** (streamed cells). Never keep
    references to the world's fixtures across steps.

---

## 8. What the bench cannot reproduce

The bench is plain Node with a flat world and nothing else in it. It does not reproduce:

- the road-height model (`carGround`): real pitch and roll come from the mesh, the bench
  uses fixed or synthetic values;
- the level-border cushion and the turn-around animation of js/edge.js;
- the corridor shapes of the S-Bahn and tunnels;
- streamed walls and clutter;
- rendering: the drawn model, shadows, dust and camera.

Those code paths are only exercised through the entry points they use (`reset`,
`setAirborne`, velocity and position writes, masks), and the bench records the
vehicle's reaction to them. Feel, visuals and the interplay with real streets need a
drive in the browser.

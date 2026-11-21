#!/usr/bin/env node
// Vehicle bench: drives a vehicle module through exactly the calls index.html makes
// (construction, settings, per-step order, inputs, 60 Hz fixed step) on a flat, empty
// Box2D world and measures what the driver sees: acceleration, braking, coasting,
// reverse, cornering, steering response, slalom, standstill, wall hits and the special
// entry points other modules use (teleport, swap, roll-on, airborne, noHold, masks,
// slope, ice, ball). Pure Node, no packages, deterministic (fixed step, no timers).
//
//   node tools/vehicle_bench.mjs                          # print all numbers (js/vehicle.js)
//   node tools/vehicle_bench.mjs --model js/vehicle2.js   # another model
//   node tools/vehicle_bench.mjs --json out.json          # write all numbers
//   node tools/vehicle_bench.mjs --model js/vehicle2.js --compare tools/vehicle_ref.json
//        -> table old vs new, exit 1 if any value is outside its tolerance (TOL below)
//   --only car|bus   one vehicle only (quick runs)
//
// Conventions: Box2D metres, x east, y south; heading = bearing (0 north, clockwise +).
// Speeds km/h, distances m, times s, angles deg, yaw rates deg/s (+ = turning right).
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const MODEL = opt('--model', 'js/vehicle.js'), JSON_OUT = opt('--json'), COMPARE = opt('--compare'), ONLY = opt('--only');

// ---------- tolerances per value class (data; --compare uses them) ----------
// rel: allowed relative difference; abs: allowed absolute difference (whichever is larger),
// so values near zero are not judged by percent. 'info' values are printed, never fail.
export const TOL = {
  speed:  { rel: 0.05, abs: 0.5,  unit: 'km/h' },
  time:   { rel: 0.05, abs: 0.05, unit: 's' },
  dist:   { rel: 0.05, abs: 0.1,  unit: 'm' },
  radius: { rel: 0.05, abs: 0.2,  unit: 'm' },
  angle:  { rel: 0.05, abs: 1.0,  unit: 'deg' },   // heading changes
  rate:   { rel: 0.05, abs: 1.0,  unit: 'deg/s' },  // yaw rates
  slip:   { rel: 0.10, abs: 0.5,  unit: 'deg' },    // body slip angles
  wallspeed: { rel: 0.10, abs: 0.5, unit: 'km/h' }, // wall hits: speeds after the hit
  walldist:  { rel: 0.10, abs: 0.1, unit: 'm' },    // wall hits: rebound / scrape distances
  wallangle: { rel: 0.10, abs: 1.0, unit: 'deg' },  // wall hits: heading kicks
  zero:   { rel: 0,    abs: 0.02, unit: '' },      // must stay (near) zero: standstill drift
  dim:    { rel: 0.01, abs: 0.01, unit: '' },       // dimensions, masses (set by spec)
  bool:   { rel: 0,    abs: 0,    unit: '' },       // 1 / 0, must match
  info:   { rel: Infinity, abs: Infinity, unit: '' },  // visual read-outs etc.: shown, not judged
};

// ---------- Box2D (classic script, global) + the model ----------
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'Box2D.js'), 'utf8'), { filename: 'Box2D.js' });
const modelPath = fs.existsSync(path.resolve(process.cwd(), MODEL)) ? path.resolve(process.cwd(), MODEL) : path.resolve(ROOT, MODEL);
const M = await import(pathToFileURL(modelPath).href);
const { Vehicle } = M;
const SOLID = M.SOLID || { friction: 0.35, restitution: 0 };
const b2Vec2 = Box2D.Common.Math.b2Vec2;
const b2Body = Box2D.Dynamics.b2Body;

// ---------- what index.html applies (default game) ----------
const STEP = 1 / 60;                // fixed physics step
const MAX_VEHICLE_SPEED_KMH = 160;  // vehicle.maxSpeed
const DEFAULT_LIMIT = 50;           // Speed menu default: speedLimit = reverseLimit = 50 km/h
const POWER = 1, HANDLING = 'arcade';
const KMH = 3.6, D2R = Math.PI / 180, R2D = 180 / Math.PI;
const TUN_BIT = 0x4000;             // js/tunnels.js wall category

function setLimit(g, kmh) {         // index.html applySpeedLimit()
  g.limit = kmh;
  g.v.speedLimit = kmh / 3.6;
  g.v.reverseLimit = kmh / 3.6;
}
function spawnInto(g, kind, x, y, heading) {   // index.html spawn()
  if (g.v) g.v.destroy();
  g.v = new Vehicle(g.world, kind, x, y, heading, g.power, g.handling);
  g.v.maxSpeed = MAX_VEHICLE_SPEED_KMH / 3.6;
  setLimit(g, g.limit);
  g.heldPose = null;
  g.hLast = g.hAcc = heading;   // unwrapped heading (sum of per-step changes)
}
function makeGame(kind, { x = 0, y = 0, heading = 0, limit = DEFAULT_LIMIT, power = POWER, handling = HANDLING } = {}) {
  const world = new Box2D.Dynamics.b2World(new b2Vec2(0, 0), true);
  const g = { world, v: null, kind, limit, power, handling, t: 0, keys: { up: 0, down: 0, left: 0, right: 0 },
              noHold: false, tilt: 0, roll: 0, grip: null, heldPose: null };
  world.CreateBody(new Box2D.Dynamics.b2BodyDef());   // wallBody (index.html)
  world.CreateBody(new Box2D.Dynamics.b2BodyDef());   // clutterBody
  spawnInto(g, kind, x, y, heading);
  return g;
}
// one index.html stepOnce() on a flat level, no sinking / edge / rails / tunnel / roof
function step(g) {
  const v = g.v, k = g.keys;
  v.setSteeringLever((k.right ? 1 : 0) - (k.left ? 1 : 0));
  v.setThrottle(k.up ? 1 : 0);
  v.setBrake(k.down ? 1 : 0);
  if (g.grip) v.wheels.forEach((w, i) => { w.grip = g.grip[i]; });   // ice (index.html sets it only on frozen levels)
  v.noHold = g.noHold;
  v.update(STEP);
  g.world.Step(STEP, 8, 3);
  g.world.ClearForces();
  v.lateUpdate(STEP);
  // carGround: flat ride plane (or a set slope); parked car keeps its drawn pose
  const keep = v.held && g.heldPose && Math.abs(g.tilt - g.heldPose.pitch) < 0.035 && Math.abs(g.roll - g.heldPose.roll) < 0.035;
  if (!keep) { v.setAttitude(g.tilt, g.roll); g.heldPose = v.held ? { pitch: g.tilt, roll: g.roll } : null; }
  const h = v.getHeading(); g.hAcc += wrap(h - g.hLast); g.hLast = h;
  g.t += STEP;
}
const keys = (g, o) => { g.keys = { up: 0, down: 0, left: 0, right: 0, ...o }; };
function run(g, seconds, each = null) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) { step(g); if (each && each(i + 1) === true) return i + 1; }
  return n;
}

// ---------- observables (only what other modules read) ----------
const pos = (g) => g.v.getPosition();
const hd = (g) => g.hAcc;          // unwrapped getHeading()
const vel = (g) => g.v.body.GetLinearVelocity();
const kmh = (g) => { const v = vel(g); return Math.hypot(v.x, v.y) * KMH; };
const fwdKmh = (g) => { const v = vel(g), h = hd(g); return (v.x * Math.sin(h) - v.y * Math.cos(h)) * KMH; };
const yawDeg = (g) => g.v.body.GetAngularVelocity() * R2D;
function slipDeg(g) {
  const v = vel(g), h = hd(g), fx = Math.sin(h), fy = -Math.cos(h), s = Math.hypot(v.x, v.y);
  if (s < 0.05) return 0;
  return Math.atan2(fx * v.y - fy * v.x, fx * v.x + fy * v.y) * R2D;   // + = velocity to the right of the nose
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrap = (a) => { a = ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; return a; };
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

// ---------- results ----------
const out = {};
function put(key, value, cls, note = '') {
  if (!TOL[cls]) throw new Error('unknown class ' + cls);
  out[key] = { v: typeof value === 'boolean' ? (value ? 1 : 0) : r3(value), cls, unit: TOL[cls].unit, ...(note ? { note } : {}) };
}

// cruise straight at `kmh` with throttle held (governor = Speed menu set to kmh)
function cruise(g, target, T = 15) { setLimit(g, target); keys(g, { up: 1 }); run(g, T); return kmh(g); }

// ---------- manoeuvres ----------
function pullAway(kind, P) {
  for (const [tag, lim, T] of [['limit50', 50, 25], ['free', 0, 90]]) {
    const g = makeGame(kind, { limit: lim }); keys(g, { up: 1 });
    const p0 = { ...pos(g) }, marks = [10, 20, 30, 40, 49, 50, ...(lim ? [] : [100])], hit = {}, at = {};
    const times = [1, 2, 3, 5, 8];
    run(g, T, (i) => {
      const s = kmh(g), t = i * STEP;
      for (const m of marks) if (hit[m] === undefined && s >= m) hit[m] = { t, d: dist(pos(g), p0) };
      for (const q of times) if (at[q] === undefined && Math.abs(t - q) < STEP / 2) at[q] = s;
    });
    for (const m of marks) {
      put(`${P}.pull.${tag}.t_to_${m}`, hit[m]?.t ?? null, 'time', m === 50 && lim ? 'limit approached from below; null = never quite 50' : '');
      put(`${P}.pull.${tag}.d_to_${m}`, hit[m]?.d ?? null, 'dist');
    }
    for (const q of times) put(`${P}.pull.${tag}.v_at_${q}s`, at[q], 'speed');
    put(`${P}.pull.${tag}.top_speed`, kmh(g), 'speed', `after ${T} s full throttle`);
  }
}

// stop from `from` km/h with the given keys; stopped = below 0.5 km/h (where a parked car is held)
function stopFrom(kind, from, k, P, tag) {
  const g = makeGame(kind);
  const v0 = cruise(g, from); setLimit(g, DEFAULT_LIMIT);
  keys(g, k);
  const p0 = { ...pos(g) }; let tStop = null, dStop = null, tRev = null;
  run(g, 20, (i) => {
    if (tStop === null && kmh(g) < 0.5) { tStop = i * STEP; dStop = dist(pos(g), p0); }
    if (tRev === null && fwdKmh(g) < -0.5) { tRev = i * STEP; return true; }
    if (tStop !== null && !k.down && i * STEP > tStop + 1) return true;
  });
  put(`${P}.${tag}.from${from}.entry_speed`, v0, 'speed');
  put(`${P}.${tag}.from${from}.t_stop`, tStop, 'time');
  put(`${P}.${tag}.from${from}.d_stop`, dStop, 'dist');
  if (k.down) put(`${P}.${tag}.from${from}.t_reverse_starts`, tRev, 'time', 'brake still held after the stop: reverse engages');
}

function reverse(kind, P) {
  for (const [tag, lim, T] of [['limit50', 50, 25], ['free', 0, 40]]) {
    const g = makeGame(kind, { limit: lim }); run(g, 0.5);   // parked
    keys(g, { down: 1 });
    const p0 = { ...pos(g) }, marks = [1, 10, 20, 30, 40], hit = {}, at = {};
    run(g, T, (i) => {
      const s = -fwdKmh(g), t = i * STEP;
      for (const m of marks) if (hit[m] === undefined && s >= m) hit[m] = t;
      for (const q of [1, 2, 3, 5]) if (at[q] === undefined && Math.abs(t - q) < STEP / 2) at[q] = s;
    });
    put(`${P}.reverse.${tag}.t_to_1`, hit[1] ?? null, 'time', 'brake held from standstill until rolling backwards at 1 km/h');
    for (const m of marks.slice(1)) put(`${P}.reverse.${tag}.t_to_${m}`, hit[m] ?? null, 'time');
    for (const q of [1, 2, 3, 5]) put(`${P}.reverse.${tag}.v_at_${q}s`, at[q], 'speed');
    put(`${P}.reverse.${tag}.top_speed`, -fwdKmh(g), 'speed', `backwards, after ${T} s`);
    put(`${P}.reverse.${tag}.heading_change`, Math.abs(hd(g)) * R2D, 'info', 'deg drift while reversing straight (small is fine)');
    put(`${P}.reverse.${tag}.d_back`, dist(pos(g), p0), 'dist', 'sanity: travels backwards');
    if (tag === 'limit50') put(`${P}.reverse.gear_sign`, g.v.gear, 'bool', 'vehicle.gear while reversing (dust reads its sign)');
  }
  // reversing at 20 km/h, then throttle: stop and drive forward
  const g = makeGame(kind); run(g, 0.5);
  setLimit(g, 20); keys(g, { down: 1 }); run(g, 12); setLimit(g, DEFAULT_LIMIT);
  put(`${P}.reverse.r2f.entry_speed`, -fwdKmh(g), 'speed');
  keys(g, { up: 1 }); let tStop = null, tFwd = null;
  run(g, 10, (i) => {
    if (tStop === null && fwdKmh(g) > -0.5) tStop = i * STEP;
    if (tFwd === null && fwdKmh(g) > 1) { tFwd = i * STEP; return true; }
  });
  put(`${P}.reverse.r2f.t_stop`, tStop, 'time', 'reversing at 20, throttle pressed: back to standstill');
  put(`${P}.reverse.r2f.t_forward_1kmh`, tFwd, 'time', 'then rolling forwards at 1 km/h');
}

function steadyTurn(kind, P) {
  for (const s of [10, 20, 30, 40, 50]) {
    const g = makeGame(kind);
    cruise(g, s, 15);
    keys(g, { up: 1, right: 1 });
    run(g, 16);
    let n = 0, sv = 0, sw = 0, ss = 0;
    run(g, 4, () => { n++; sv += kmh(g) / KMH; sw += g.v.body.GetAngularVelocity(); ss += slipDeg(g); });
    const v = sv / n, w = sw / n;
    put(`${P}.turn.at${s}.speed_held`, v * KMH, 'speed', `full lock right, throttle, Speed limit ${s}`);
    put(`${P}.turn.at${s}.yaw_rate`, w * R2D, 'rate');
    put(`${P}.turn.at${s}.radius`, Math.abs(w) > 1e-4 ? v / Math.abs(w) : null, 'radius', 'path radius of the centre = speed / yaw rate');
    put(`${P}.turn.at${s}.slip`, Math.abs(ss / n), 'slip', 'angle between heading and velocity');
  }
}

function stepSteer(kind, P) {
  for (const s of [30, 50]) {
    const g = makeGame(kind);
    cruise(g, s, 15);
    const h0 = hd(g);
    keys(g, { up: 1, right: 1 });
    const at = {};
    run(g, 2, (i) => { for (const q of [0.25, 0.5, 1, 2]) if (Math.abs(i * STEP - q) < STEP / 2) at[q] = (hd(g) - h0) * R2D; });
    for (const q of [0.25, 0.5, 1, 2]) put(`${P}.steer.at${s}.heading_${q}s`, at[q], 'angle', 'full lock right as a step, throttle held');
    put(`${P}.steer.at${s}.yaw_rate_2s`, yawDeg(g), 'rate');
    keys(g, { up: 1 });
    const h1 = hd(g); let tSettle = null, drift = null;
    run(g, 6, (i) => { if (tSettle === null && Math.abs(yawDeg(g)) < 2) { tSettle = i * STEP; drift = (hd(g) - h1) * R2D; } });
    put(`${P}.steer.at${s}.release_t_settle`, tSettle, 'time', 'steering released: until |yaw rate| < 2 deg/s');
    put(`${P}.steer.at${s}.release_drift`, drift, 'angle', 'heading change from release to settle');
    put(`${P}.steer.at${s}.release_speed_6s`, kmh(g), 'speed');
  }
}

function slalom(kind, P) {
  const g = makeGame(kind);
  cruise(g, 40, 15);
  const p0 = { ...pos(g) }, h0 = hd(g), fx = Math.sin(h0), fy = -Math.cos(h0);
  let maxLat = 0, maxYaw = 0;
  for (let k = 0; k < 8; k++) {
    keys(g, { up: 1, right: k % 2 === 0 ? 1 : 0, left: k % 2 === 1 ? 1 : 0 });
    run(g, 1, () => {
      const p = pos(g), lat = Math.abs((p.x - p0.x) * -fy + (p.y - p0.y) * fx);
      maxLat = Math.max(maxLat, lat); maxYaw = Math.max(maxYaw, Math.abs(yawDeg(g)));
    });
  }
  put(`${P}.slalom.peak_lateral`, maxLat, 'dist', '40 km/h, full lock R/L alternating every 1 s for 8 s, throttle held');
  put(`${P}.slalom.peak_yaw_rate`, maxYaw, 'rate');
  put(`${P}.slalom.final_speed`, kmh(g), 'speed');
  put(`${P}.slalom.final_heading`, (hd(g) - h0) * R2D, 'angle');
}

function standstill(kind, P) {
  let g = makeGame(kind); run(g, 0.5);
  const p0 = { ...pos(g) }, h0 = hd(g);
  keys(g, { right: 1 }); run(g, 1.5); keys(g, { left: 1 }); run(g, 1.5); keys(g, {}); run(g, 1);
  put(`${P}.stand.steer_drift`, dist(pos(g), p0), 'zero', 'steering left/right at rest, no pedal');
  put(`${P}.stand.steer_heading`, Math.abs((hd(g) - h0)) * R2D, 'zero');
  put(`${P}.stand.held`, !!g.v.held, 'bool', 'vehicle.held after standing still with no key');
  g = makeGame(kind); run(g, 0.5);
  const p1 = { ...pos(g) }; let vmax = 0, tHeld = null;
  keys(g, { up: 1 }); run(g, 0.3, () => { vmax = Math.max(vmax, kmh(g)); });
  keys(g, {}); run(g, 10, (i) => { vmax = Math.max(vmax, kmh(g)); if (tHeld === null && kmh(g) === 0) { tHeld = i * STEP; return true; } });
  put(`${P}.stand.tap_distance`, dist(pos(g), p1), 'dist', 'throttle tapped 0.3 s from rest, then released');
  put(`${P}.stand.tap_peak_speed`, vmax, 'speed');
  put(`${P}.stand.tap_t_to_rest`, tHeld, 'time', 'after release until speed is exactly 0');
  // the hold on a slope without a key
  g = makeGame(kind); g.tilt = -5 * D2R; run(g, 0.5);
  const p2 = { ...pos(g) }; run(g, 5);
  put(`${P}.stand.downhill5_drift`, dist(pos(g), p2), 'zero', 'parked on a 5 deg downhill, no key, 5 s');
}

function addBox(world, cx, cy, hx, hy, angle, category = null) {   // index.html addWall material
  const body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
  const s = new Box2D.Collision.Shapes.b2PolygonShape();
  s.SetAsOrientedBox(hx, hy, new b2Vec2(cx, cy), angle);
  const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = s; fd.friction = SOLID.friction; fd.restitution = SOLID.restitution;
  if (category) { const f = new Box2D.Dynamics.b2FilterData(); f.categoryBits = category; f.maskBits = 0xffff; fd.filter = f; }
  body.CreateFixture(fd);
  return body;
}

// drive at `s` km/h (throttle) until the forward speed drops in one step (the hit)
function driveToHit(g, s, maxT = 30) {
  setLimit(g, s); keys(g, { up: 1 });
  let prev = kmh(g), hitV = null, contact = null;
  run(g, maxT, () => {
    const c = kmh(g);
    if (prev > s - 1 && (prev - c > 2 || g.v.wallContact)) { hitV = prev; contact = g.v.wallContact ? { ...g.v.wallContact } : null; return true; }
    prev = c;
  });
  return { hitV, contact };
}

function wallHits(kind, P) {
  // head-on: wall across the road 100 m ahead (index.html addWall: 0.3 m half thickness)
  let g = makeGame(kind);
  addBox(g.world, 0, -100, 15, 0.3, 0);
  const { hitV, contact } = driveToHit(g, 30);
  setLimit(g, DEFAULT_LIMIT);
  const h0 = hd(g), p0 = { ...pos(g) }, fx = Math.sin(h0), fy = -Math.cos(h0);
  keys(g, {});
  const at = {}; let back = 0, minPitch = 0, maxPitch = 0;
  run(g, 2, (i) => {
    const p = pos(g), b = -((p.x - p0.x) * fx + (p.y - p0.y) * fy);
    back = Math.max(back, b);
    minPitch = Math.min(minPitch, g.v.impactPitch || 0); maxPitch = Math.max(maxPitch, g.v.impactPitch || 0);
    for (const q of [0.1, 0.5]) if (Math.abs(i * STEP - q) < STEP / 2) at[q] = fwdKmh(g);
  });
  put(`${P}.wall.head.speed_before`, hitV, 'speed', '30 km/h with throttle into a wall, keys released at the hit');
  put(`${P}.wall.head.fwd_speed_0.1s`, at[0.1], 'wallspeed', 'km/h along the heading (< 0 = moving back)');
  put(`${P}.wall.head.fwd_speed_0.5s`, at[0.5], 'wallspeed', 'km/h');
  put(`${P}.wall.head.rebound_dist`, back, 'walldist', 'm moved back from the position at the hit, max over 2 s');
  put(`${P}.wall.head.heading_change`, Math.abs((hd(g) - h0)) * R2D, 'wallangle', 'deg after 2 s');
  put(`${P}.wall.head.contact_reported`, !!contact, 'bool', 'vehicle.wallContact set at the hit');
  put(`${P}.wall.head.contact_impact`, contact?.impact ?? null, 'info', 'wallContact.impact (m/s into the wall before the step)');
  put(`${P}.wall.head.contact_normal_y`, contact?.ny ?? null, 'info', 'wallContact normal, wall -> car (car came from +y)');
  put(`${P}.wall.head.nose_dip_min`, minPitch * R2D, 'info', 'vehicle.impactPitch min (deg, < 0 = nose down)');
  put(`${P}.wall.head.nose_dip_max`, maxPitch * R2D, 'info');
  // the same with throttle held on into the wall: stays pressed, does not climb / spin
  g = makeGame(kind); addBox(g.world, 0, -100, 15, 0.3, 0);
  driveToHit(g, 30); setLimit(g, DEFAULT_LIMIT);
  const h1 = hd(g), p1 = { ...pos(g) }; keys(g, { up: 1 }); run(g, 3);
  put(`${P}.wall.press.heading_change`, Math.abs((hd(g) - h1)) * R2D, 'info', 'throttle held 3 s against the wall');
  put(`${P}.wall.press.moved`, dist(pos(g), p1), 'walldist', 'm');
  put(`${P}.wall.press.speed`, kmh(g), 'speed');
  // glancing: wall 30 deg off the heading (it runs north-north-east), throttle held throughout
  g = makeGame(kind);
  const wa = -60 * D2R, wx = Math.cos(wa), wy = Math.sin(wa);   // wall direction (0.5, -0.87): 30 deg right of north
  addBox(g.world, 0, -100, 60, 0.3, wa);
  const r = driveToHit(g, 30);
  const hg = hd(g), pg = { ...pos(g) }, at2 = {};
  keys(g, { up: 1 });
  run(g, 2, (i) => { for (const q of [0.5, 1, 2]) if (Math.abs(i * STEP - q) < STEP / 2) at2[q] = { s: kmh(g), h: (hd(g) - hg) * R2D }; });
  const p = pos(g), nx = -wy, ny = wx;   // wall normal (left side, where the car is)
  const sep = Math.abs((p.x - 0) * nx + (p.y + 100) * ny), along = (p.x - pg.x) * wx + (p.y - pg.y) * wy;
  put(`${P}.wall.glance.speed_before`, r.hitV, 'speed', '30 km/h, wall 30 deg off the heading, throttle held');
  put(`${P}.wall.glance.speed_0.5s`, at2[0.5]?.s, 'wallspeed', 'km/h');
  put(`${P}.wall.glance.speed_1s`, at2[1]?.s, 'wallspeed', 'km/h');
  put(`${P}.wall.glance.heading_0.5s`, at2[0.5]?.h, 'wallangle', 'deg turned (+ = right, toward the wall direction)');
  put(`${P}.wall.glance.heading_2s`, at2[2]?.h, 'wallangle', 'deg turned after 2 s (30 = parallel to the wall)');
  put(`${P}.wall.glance.along_2s`, along, 'walldist', 'm travelled along the wall in 2 s');
  put(`${P}.wall.glance.centre_to_wall_2s`, sep, 'walldist', 'm from the car centre to the wall line after 2 s');
}

// ---------- special entry points of other modules ----------
function specials(kind, P) {
  const other = kind === 'car' ? 'bus' : 'car';
  // teleport (berlinDrive.teleport, restart, respawn, map): reset(x, y, h) while driving
  let g = makeGame(kind); cruise(g, 50, 12); setLimit(g, DEFAULT_LIMIT);
  g.v.reset(100, 50, Math.PI / 2);
  let p = pos(g);
  put(`${P}.sp.teleport.pos_error`, Math.hypot(p.x - 100, p.y - 50), 'zero', 'getPosition() right after reset(100, 50, 90 deg)');
  put(`${P}.sp.teleport.heading_error`, Math.abs(wrap(g.v.getHeading() - Math.PI / 2)) * R2D, 'zero');
  put(`${P}.sp.teleport.speed_after`, kmh(g), 'speed', 'reset() at 50 km/h: velocity cleared');
  keys(g, {}); run(g, 2);
  put(`${P}.sp.teleport.drift_2s`, dist(pos(g), { x: 100, y: 50 }), 'zero', 'no key for 2 s after the reset');
  keys(g, { up: 1 }); run(g, 2);
  put(`${P}.sp.teleport.throttle_2s`, kmh(g), 'speed', 'throttle after a reset: drives off normally');

  // vehicle swap (index.html setVehicle): destroy, spawn other kind at pose, copy velocity to all bodies
  g = makeGame(kind); cruise(g, 50, 12); setLimit(g, DEFAULT_LIMIT);
  const bodies0 = g.world.GetBodyCount();
  { const q = pos(g), h = hd(g), lv = vel(g), vx = lv.x, vy = lv.y, w = g.v.body.GetAngularVelocity();
    spawnInto(g, other, q.x, q.y, h);
    for (const b of [g.v.body, ...g.v.wheels.map((wh) => wh.body)]) b.SetLinearVelocity(new b2Vec2(vx, vy));
    g.v.body.SetAngularVelocity(w); }
  put(`${P}.sp.swap.body_count_kept`, g.world.GetBodyCount() === bodies0, 'bool', 'destroy() removes every body it created');
  keys(g, { up: 1 }); step(g);
  put(`${P}.sp.swap.speed_1step`, kmh(g), 'speed', `swapped to ${other} at 50 km/h, throttle held`);
  run(g, 1);
  put(`${P}.sp.swap.speed_1s`, kmh(g), 'speed');

  // roll-on (js/sbahn.js rollOn 30 km/h, js/edge.js turn-around 3 m/s): reset, velocity on all bodies,
  // brakeLock = false, prevVel = velocity; then no key
  for (const [tag, sp] of [['sbahn', 30 / 3.6], ['edge', 3]]) {
    g = makeGame(kind); run(g, 0.5);
    g.v.reset(20, 20, 0);
    const vx = 0, vy = -sp;
    for (const b of [g.v.body, ...g.v.wheels.map((w) => w.body)]) b.SetLinearVelocity(new b2Vec2(vx, vy));
    g.v.brakeLock = false; g.v.prevVel = { x: vx, y: vy };
    keys(g, {}); const p0 = { ...pos(g) };
    step(g);
    put(`${P}.sp.rollon_${tag}.speed_1step`, kmh(g), 'speed', `reset + ${r3(sp * KMH)} km/h set on all bodies, no key`);
    let tRest = null;
    run(g, 10, (i) => { if (tRest === null && kmh(g) < 0.5) { tRest = i * STEP; return true; } });
    put(`${P}.sp.rollon_${tag}.t_to_rest`, tRest, 'time');
    put(`${P}.sp.rollon_${tag}.d_to_rest`, dist(pos(g), p0), 'dist');
  }

  // airborne (jump, turn-around): fixtures pass through walls, no grip, no braking, no steering effect
  g = makeGame(kind); cruise(g, 50, 12); setLimit(g, DEFAULT_LIMIT);
  const vA = kmh(g), hA = hd(g);
  g.v.setAirborne(true); keys(g, { down: 1, right: 1 }); run(g, 0.6);
  put(`${P}.sp.air.speed_after_0.6s_brake`, kmh(g), 'speed', `airborne at ${r3(vA)} km/h, brake + full lock held 0.6 s`);
  put(`${P}.sp.air.heading_change`, Math.abs((hd(g) - hA)) * R2D, 'angle');
  g.v.setAirborne(false); keys(g, { down: 1 }); run(g, 0.5);
  put(`${P}.sp.air.speed_after_landing_brake_0.5s`, kmh(g), 'speed', 'wheels down again, brake 0.5 s: brakes work');
  g = makeGame(kind); addBox(g.world, 0, -40, 15, 0.3, 0); cruise(g, 30, 4);
  g.v.setAirborne(true); keys(g, {}); run(g, 6);
  put(`${P}.sp.air.passes_wall`, pos(g).y < -40 - g.v.spec.bodyLength, 'bool', 'airborne car passes through a wall');
  // jump push at rest (index.html doJump): only the main body gets a velocity, then airborne
  g = makeGame(kind); run(g, 0.5);
  { const v0 = vel(g); g.v.body.SetLinearVelocity(new b2Vec2(v0.x + 0, v0.y + 3.5)); }
  g.v.setAirborne(true); const pj = { ...pos(g) }; keys(g, {}); run(g, 0.6);
  put(`${P}.sp.air.push_dist_0.6s`, dist(pos(g), pj), 'dist', '3.5 m/s set on the main body only (jump push), airborne 0.6 s');
  put(`${P}.sp.air.push_speed_0.6s`, kmh(g), 'speed');
  // B in mid-air: a new vehicle with setAirborne(true) right after construction keeps flying
  g = makeGame(kind); g.v.setAirborne(true);
  for (const b of [g.v.body, ...g.v.wheels.map((w) => w.body)]) b.SetLinearVelocity(new b2Vec2(0, -10));
  run(g, 0.5);
  put(`${P}.sp.air.spawned_airborne_speed`, kmh(g), 'speed', 'spawned airborne with 36 km/h, 0.5 s');

  // noHold (rescue / turn-around): no coast braking and no parking hold
  g = makeGame(kind); cruise(g, 30, 12); setLimit(g, DEFAULT_LIMIT);
  g.noHold = true; keys(g, {}); run(g, 2);
  put(`${P}.sp.nohold.speed_after_2s`, kmh(g), 'speed', 'noHold, no key, from 30 km/h');
  g = makeGame(kind); run(g, 0.5); g.noHold = true;
  for (const b of [g.v.body, ...g.v.wheels.map((w) => w.body)]) b.SetLinearVelocity(new b2Vec2(0, -0.1));
  const pn = { ...pos(g) }; run(g, 1);
  put(`${P}.sp.nohold.creep_dist_1s`, dist(pos(g), pn), 'dist', 'noHold, 0.36 km/h creep, no key, 1 s (not held)');

  // collision masks (js/tunnels.js / js/roofs.js): every fixture of body + wheels gets maskBits
  for (const [tag, cat] of [['other_wall', null], ['own_wall', TUN_BIT]]) {
    g = makeGame(kind); addBox(g.world, 0, -60, 15, 0.3, 0, cat);
    for (const b of [g.v.body, ...g.v.wheels.map((w) => w.body)]) {
      for (let f = b.GetFixtureList(); f; f = f.GetNext()) { const fd = f.GetFilterData(); fd.maskBits = TUN_BIT; f.SetFilterData(fd); }
      for (let c = b.GetContactList(); c; c = c.next) c.contact.FlagForFiltering();
    }
    cruise(g, 30, 12);
    put(`${P}.sp.mask_${tag}.passed`, pos(g).y < -60, 'bool', tag === 'own_wall' ? 'mask = tunnel bit: tunnel wall stops the car' : 'mask = tunnel bit: an ordinary wall is passed');
  }

  // position shift on all bodies while driving (js/sbahn.js / js/tunnels.js clamp)
  g = makeGame(kind); cruise(g, 30, 12);
  { const twin = makeGame(kind); cruise(twin, 30, 12);
    for (const b of [g.v.body, ...g.v.wheels.map((w) => w.body)]) { const q = b.GetPosition(); b.SetPosition(new b2Vec2(q.x + 1, q.y)); }
    run(g, 0.5); run(twin, 0.5);
    put(`${P}.sp.shift.speed_0.5s`, kmh(g), 'speed', 'all bodies moved 1 m sideways at 30 km/h');
    put(`${P}.sp.shift.lateral_kept`, pos(g).x - pos(twin).x, 'dist', 'm east of an unshifted twin after 0.5 s (1 = shift kept)'); }

  // slope (setAttitude from the ride plane): throttle with the 50 limit up / down 5 deg
  for (const [tag, deg] of [['up5', 5], ['down5', -5]]) {
    g = makeGame(kind); g.tilt = deg * D2R; keys(g, { up: 1 }); run(g, 20);
    put(`${P}.sp.slope_${tag}.speed_20s`, kmh(g), 'speed', `${deg} deg nose-up tilt, throttle, limit 50`);
  }
  g = makeGame(kind); g.tilt = 5 * D2R; keys(g, { down: 1 }); run(g, 0.5); const ps = { ...pos(g) }; run(g, 0.3);
  put(`${P}.sp.slope_up5.brake_at_rest_drift`, dist(pos(g), ps), 'info', 'brake held at rest uphill (reverse engages after a moment)');

  // Speed menu lowered while driving: 70 -> 30 km/h, throttle held (the governor slows the car)
  g = makeGame(kind); cruise(g, 70, 15);
  { setLimit(g, 30); keys(g, { up: 1 }); let t31 = null; const at = {};
    run(g, 15, (i) => { if (t31 === null && kmh(g) <= 31) t31 = i * STEP; for (const q of [1, 2]) if (Math.abs(i * STEP - q) < STEP / 2) at[q] = kmh(g); });
    put(`${P}.sp.limit_lowered.speed_1s`, at[1], 'speed', 'cruising at 70, Speed set to 30, throttle held');
    put(`${P}.sp.limit_lowered.speed_2s`, at[2], 'speed');
    put(`${P}.sp.limit_lowered.t_to_31`, t31, 'time');
    put(`${P}.sp.limit_lowered.final`, kmh(g), 'speed', 'after 15 s'); }
  // both pedals at once (keyboard / touch can send ArrowUp + ArrowDown together)
  g = makeGame(kind); cruise(g, 30, 12); keys(g, { up: 1, down: 1 }); run(g, 2);
  put(`${P}.sp.both_pedals.from30_speed_2s`, fwdKmh(g), 'speed', 'throttle + brake held together 2 s from 30 km/h (signed, forward +)');
  g = makeGame(kind); run(g, 0.5); keys(g, { up: 1, down: 1 }); run(g, 2);
  put(`${P}.sp.both_pedals.from_rest_speed_2s`, fwdKmh(g), 'speed', 'throttle + brake held together 2 s from rest');
  // uneven road: the ride plane pitches +-1 deg at 2 Hz (setAttitude every step, as carGround does)
  { const bumpy = (q) => () => { q.tilt = 1 * D2R * Math.sin(2 * Math.PI * 2 * q.t); };
    g = makeGame(kind); keys(g, { up: 1 }); run(g, 20, bumpy(g));
    put(`${P}.sp.bumpy.throttle_speed_20s`, kmh(g), 'speed', 'pitch +-1 deg at 2 Hz, throttle, limit 50');
    g = makeGame(kind); cruise(g, 50, 12); keys(g, {}); const p0 = { ...pos(g) }; let d = null;
    run(g, 20, (i) => { g.tilt = 1 * D2R * Math.sin(2 * Math.PI * 2 * g.t); if (kmh(g) < 0.5) { d = dist(pos(g), p0); put(`${P}.sp.bumpy.coast50_t_stop`, i * STEP, 'time'); return true; } });
    put(`${P}.sp.bumpy.coast50_d_stop`, d, 'dist', 'keys released at 50 on the bumpy road'); }
  // ice (index.html on frozen water: grip 0.25, rear x 0.7)
  const ice = [0.25, 0.25, 0.175, 0.175];
  g = makeGame(kind); g.grip = ice; keys(g, { up: 1 }); let t30 = null;
  run(g, 30, (i) => { if (t30 === null && kmh(g) >= 30) { t30 = i * STEP; return true; } });
  put(`${P}.sp.ice.t_to_30`, t30, 'time', 'grip 0.25 / rear 0.175, full throttle');
  g = makeGame(kind); cruise(g, 30, 12); setLimit(g, DEFAULT_LIMIT); g.grip = ice; keys(g, { down: 1 });
  { const p0 = { ...pos(g) }; let d = null;
    run(g, 20, (i) => { if (kmh(g) < 0.5) { d = dist(pos(g), p0); put(`${P}.sp.ice.brake30_t_stop`, i * STEP, 'time'); return true; } });
    put(`${P}.sp.ice.brake30_d_stop`, d, 'dist', 'full braking from 30 on ice'); }

  // a 30 kg ball (js/eggs.js, r 1.5 m) at 10 m/s against the parked vehicle's side
  g = makeGame(kind); run(g, 1);
  { const bd = new Box2D.Dynamics.b2BodyDef(); bd.type = b2Body.b2_dynamicBody; bd.position.Set(-8, 0); bd.bullet = true; bd.linearDamping = 0.3;
    const ball = g.world.CreateBody(bd); const fd = new Box2D.Dynamics.b2FixtureDef();
    fd.shape = new Box2D.Collision.Shapes.b2CircleShape(1.5); fd.density = 30 / (Math.PI * 2.25); fd.friction = 0.3; fd.restitution = 0.6;
    ball.CreateFixture(fd); ball.SetLinearVelocity(new b2Vec2(10, 0));
    const p0 = { ...pos(g) }, h0 = hd(g); run(g, 1.5);
    put(`${P}.sp.ball.car_moved`, dist(pos(g), p0), 'zero', 'parked vehicle hit by the ball: does not move');
    put(`${P}.sp.ball.car_turned`, Math.abs((hd(g) - h0)) * R2D, 'zero');
    put(`${P}.sp.ball.ball_bounced_back`, ball.GetLinearVelocity().x < 0, 'bool'); }

  // options: ?power= (engine), unknown ?handling= falls back to the default
  for (const pw of [0.5, 2]) {
    g = makeGame(kind, { limit: 0, power: pw }); keys(g, { up: 1 }); let t = null;
    run(g, 40, (i) => { if (t === null && kmh(g) >= 50) { t = i * STEP; return true; } });
    put(`${P}.opt.power${pw}.free_t_to_50`, t, 'time', `?power=${pw}, Speed free`);
    g = makeGame(kind, { power: pw }); keys(g, { up: 1 }); t = null;
    run(g, 40, (i) => { if (t === null && kmh(g) >= 40) { t = i * STEP; return true; } });
    put(`${P}.opt.power${pw}.limit50_t_to_40`, t, 'time', `?power=${pw}, Speed 50`);
  }
  { const a = makeGame(kind), b = makeGame(kind, { handling: 'no-such-mode' });
    for (const q of [a, b]) { keys(q, { up: 1, right: 1 }); run(q, 6); }
    put(`${P}.opt.unknown_handling_is_default`, dist(pos(a), pos(b)) < 1e-6, 'bool', '?handling=<unknown> drives exactly like the default'); }
}

// ---------- static facts + visual read-outs ----------
function facts(kind, P) {
  const g = makeGame(kind), v = g.v;
  const f = v.body.GetFixtureList(), sh = f.GetShape();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, nv = 0;
  if (sh.GetVertices) { const vs = sh.GetVertices(); nv = sh.GetVertexCount(); for (let i = 0; i < nv; i++) { minX = Math.min(minX, vs[i].x); maxX = Math.max(maxX, vs[i].x); minY = Math.min(minY, vs[i].y); maxY = Math.max(maxY, vs[i].y); } }
  put(`${P}.dim.outline_is_polygon`, !!sh.GetVertices, 'bool', 'first fixture of vehicle.body: polygon (balloon cable, spot overlap tests read it)');
  put(`${P}.dim.outline_vertices`, nv, 'info');
  put(`${P}.dim.outline_width`, maxX - minX, 'dim', 'm, body-local x');
  put(`${P}.dim.outline_length`, maxY - minY, 'dim', 'm, body-local y');
  put(`${P}.dim.outline_front`, -minY, 'dim', 'm from the body origin to the nose (forward = local -y)');
  put(`${P}.dim.outline_rear`, maxY, 'dim', 'm from the body origin to the tail');
  put(`${P}.dim.spec_bodyWidth`, v.spec.bodyWidth, 'dim');
  put(`${P}.dim.spec_bodyLength`, v.spec.bodyLength, 'dim');
  put(`${P}.dim.spec_wheelBase`, v.spec.wheelBase, 'dim');
  put(`${P}.dim.spec_tread`, v.spec.tread, 'dim');
  put(`${P}.dim.spec_wheelRadius`, v.spec.wheelRadius, 'dim');
  put(`${P}.dim.spec_mass`, v.spec.mass, 'dim', 'kg');
  put(`${P}.dim.mass`, v.getMass(), 'dim', 'kg, getMass() = main body mass');
  put(`${P}.dim.body_mass`, v.body.GetMass(), 'dim', 'kg');
  put(`${P}.dim.body_inertia`, v.body.GetInertia(), 'info', 'kg m2 about the body origin');
  put(`${P}.dim.full_brake_decel_expected`, 4 * v.spec.brakeForce / v.spec.mass, 'info', 'm/s2: dust.js treats 4 x spec.brakeForce / spec.mass as full braking');
  put(`${P}.dim.wheel_count`, v.wheels.length, 'dim');
  v.wheels.forEach((w, i) => {
    const l = v.body.GetLocalPoint(w.body.GetWorldCenter());
    put(`${P}.dim.wheel${i}_x`, l.x, 'dim', 'm, body-local (wheels: 0 FL, 1 FR, 2 RL, 3 RR)');
    put(`${P}.dim.wheel${i}_y`, l.y, 'dim');
  });
  put(`${P}.dim.com_offset`, Math.hypot(v.body.GetLocalCenter().x, v.body.GetLocalCenter().y), 'dim', 'm, body centre of mass from origin');
  // fixture filters
  let cats = new Set(), masks = new Set();
  for (const b of [v.body, ...v.wheels.map((w) => w.body)]) for (let q = b.GetFixtureList(); q; q = q.GetNext()) { const fd = q.GetFilterData(); cats.add(fd.categoryBits); masks.add(fd.maskBits); }
  put(`${P}.dim.filter_categories`, [...cats].reduce((a, c) => a | c, 0), 'info', 'OR of categoryBits over all own fixtures');
  put(`${P}.dim.filter_masks_all_ffff`, [...masks].every((m) => (m & 0x7fff) === 0x7fff), 'bool', 'every own fixture collides with categories 0x0001..0x4000');
  put(`${P}.dim.sensor_default`, [v.body, ...v.wheels.map((w) => w.body)].every((b) => { for (let q = b.GetFixtureList(); q; q = q.GetNext()) if (q.IsSensor()) return false; return true; }), 'bool', 'no own fixture is a sensor on the ground');
  // visual read-outs at full lock
  keys(g, { right: 1 }); run(g, 0.5);
  put(`${P}.vis.frontL_at_rest`, g.v.frontLAngle * R2D, 'info', 'deg drawn front-left wheel angle, full lock right at rest (+ = right)');
  put(`${P}.vis.frontR_at_rest`, g.v.frontRAngle * R2D, 'info');
  put(`${P}.vis.steer_right_turns_clockwise`, null, 'info');
  const g2 = makeGame(kind); cruise(g2, 50, 12); keys(g2, { up: 1, right: 1 }); let sq = 0;
  run(g2, 3, () => { sq = Math.max(sq, g2.v.squealLevel || 0); });
  put(`${P}.vis.frontL_at50`, g2.v.frontLAngle * R2D, 'info', 'deg, full lock right held at 50 km/h');
  put(`${P}.vis.frontR_at50`, g2.v.frontRAngle * R2D, 'info');
  put(`${P}.vis.squeal_peak_at50`, sq, 'info', 'squealLevel 0..1, full lock at 50');
  put(`${P}.vis.right_lever_yaw_positive`, yawDeg(g2) > 0, 'bool', 'lever +1 (ArrowRight) turns right: heading grows');
  const g3 = makeGame(kind); g3.tilt = 0.05; g3.roll = -0.03; step(g3);
  put(`${P}.vis.attitude_echo`, Math.abs(g3.v.tilt - 0.05) < 1e-9 && Math.abs(g3.v.roll + 0.03) < 1e-9, 'bool', 'tilt / roll read back what setAttitude got');
  const g4 = makeGame(kind); keys(g4, { up: 1 }); run(g4, 3);
  put(`${P}.vis.speedKmh_matches`, Math.abs(g4.v.speedKmh - kmh(g4)) < 0.5, 'bool', 'vehicle.speedKmh within 0.5 km/h of the body speed while driving');
  delete out[`${P}.vis.steer_right_turns_clockwise`];
}

// ---------- run ----------
const kinds = ONLY ? [ONLY] : ['car', 'bus'];
for (const kind of kinds) {
  facts(kind, kind);
  pullAway(kind, kind);
  stopFrom(kind, 50, { down: 1 }, kind, 'brake');
  stopFrom(kind, 30, { down: 1 }, kind, 'brake');
  stopFrom(kind, 50, {}, kind, 'coast');
  stopFrom(kind, 30, {}, kind, 'coast');
  reverse(kind, kind);
  steadyTurn(kind, kind);
  stepSteer(kind, kind);
  slalom(kind, kind);
  standstill(kind, kind);
  wallHits(kind, kind);
  specials(kind, kind);
}

const doc = { model: path.relative(ROOT, modelPath), step: STEP, settings: { handling: HANDLING, power: POWER, speedLimitKmh: DEFAULT_LIMIT, reverseLimitKmh: DEFAULT_LIMIT, maxSpeedKmh: MAX_VEHICLE_SPEED_KMH }, tolerances: TOL, values: out };
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(doc, null, 1) + '\n'); console.log(`wrote ${Object.keys(out).length} values to ${JSON_OUT}`); }

if (COMPARE) {
  const ref = JSON.parse(fs.readFileSync(COMPARE, 'utf8')).values;
  let bad = 0, n = 0;
  const pad = (s, w) => String(s).padEnd(w), num = (x) => (x == null ? 'null' : String(x));
  console.log(pad('value', 52) + pad('ref', 11) + pad('new', 11) + pad('diff', 9) + 'ok');
  for (const [k, r] of Object.entries(ref)) {
    if (ONLY && !k.startsWith(ONLY + '.')) continue;
    const c = out[k], tol = TOL[r.cls] || TOL.info; n++;
    let ok, diff = '';
    if (!c) { ok = false; diff = 'missing'; }
    else if (r.v == null || c.v == null) ok = r.v == null && c.v == null || r.cls === 'info';
    else {
      const d = Math.abs(c.v - r.v);
      ok = r.cls === 'info' || d <= Math.max(tol.abs, tol.rel * Math.abs(r.v));
      diff = r.v !== 0 ? (((c.v - r.v) / Math.abs(r.v)) * 100).toFixed(1) + '%' : (c.v - r.v).toFixed(3);
    }
    if (!ok) bad++;
    console.log(pad(k, 52) + pad(num(r.v), 11) + pad(num(c?.v), 11) + pad(diff, 9) + (ok ? (r.cls === 'info' ? '(info)' : 'ok') : 'FAIL'));
  }
  console.log(`\n${n - bad}/${n} within tolerance` + (bad ? `, ${bad} outside` : ''));
  process.exit(bad ? 1 : 0);
} else if (!JSON_OUT) {
  for (const [k, r] of Object.entries(out)) console.log(k.padEnd(52) + String(r.v).padEnd(11) + r.unit + (r.note ? '   ' + r.note : ''));
}

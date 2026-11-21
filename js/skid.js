// Skid marks (owner: "Bremsspuren would be nice, too"): dark soft-edged strips on the road under
// the tyres that slide, fading out over `life` s.
//
// When (thresholds are js/dust.js's DUST, so dust and marks agree):
//   hard brake   decel >= brakeFrac x full braking above brakeV m/s; held while decel >= half that
//                and the car still moves: all four tyres
//   sharp turn   lateral acceleration >= turnA (bus turnABus) above turnV m/s, or squeal >= squeal:
//                the outer pair
//   pull away    standing >= standT s, then full throttle: the driven pair for pullT s
//   landing      air -> ground after a fall of >= 1 m/s: the rear pair for landT s
// None while a sequence owns the car (car.off: rescue, sinking, edge turn-around, tunnels), in the
// air, on the S-Bahn tracks, or when switched off. Paused game: index.html calls update() only from
// the running frame loop, so marks neither age nor appear while paused (dt from the caller).
//
// Geometry: a ring buffer of MAX quads in one BufferGeometry (one draw call, no per-frame
// allocations). Per wheel a mark is a chain: every `step` m of travel a quad from the previous end
// edge to the new one, so a mark reads as one continuous line; a gap > `jump` m (teleport) starts
// a new chain. Each vertex carries its birth time and start alpha; the shader fades it with the
// mark clock (uNow), so attributes upload only when a quad is laid. Height: the ride plane at that
// wheel (car height + pitch / roll, as dust's wheel()). No z-fight: drawn in index.html's shadow
// pass (after the world, before the car) depth-tested but pulled `bias` m toward the camera, as the
// dust is; buildings still hide old marks.
//
// Moods: snow a little stronger (dark slush on white), moon weaker.
// berlinDrive.skid: opts (live), setEnabled(bool) (saved as 'berlinDrive.skid'), clear(), enabled.
import * as THREE from 'three';
import { DUST } from './dust.js';

export const SKID = {
  alpha: 0.42,          // opacity when laid (x strength 0.6..1, x mood)
  life: 10,             // s until gone (fades all the way, a little faster at first)
  width: 0.24,          // m (car), bus x busWidth
  busWidth: 1.4,
  // turns (owner 2026-11-21: no marks in not-so-fast turns): stricter than the dust's thresholds
  turnV: 11,            // m/s (40 km/h): below this a turn never marks
  turnA: 7.5,           // m/s2 lateral (car), bus turnABus
  turnABus: 4.5,
  squeal: 0.6,          // tyre squeal level that marks on its own
  step: 0.4,            // m of travel per quad
  jump: 3,              // m: a longer gap starts a new chain (teleport)
  bias: 0.6,            // m toward the camera (depth only)
  lift: 0.02,           // m above the ride plane
  pullT: 0.7, landT: 0.25,   // s of marks after a hard pull-away / a landing
  pullThrottle: 0.9,    // throttle for a "hard" pull-away
};
const MAX = 480;        // quads in the ring
const STORE_KEY = 'berlinDrive.skid';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const VERT = /* glsl */`
uniform float uNow, uLife, uBias;
attribute vec2 aMark;   // birth time (mark clock), start alpha
attribute float aSide;  // -1 .. 1 across the strip
varying float vA, vSide;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = length(mv.xyz);
  mv.xyz -= mv.xyz / max(d, 1e-3) * min(uBias, 0.5 * d);
  gl_Position = projectionMatrix * mv;
  float u = clamp((uNow - aMark.x) / uLife, 0.0, 1.0);
  vA = aMark.y * pow(1.0 - u, 1.3);
  vSide = aSide;
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
varying float vA, vSide;
void main() {
  float a = vA * (1.0 - smoothstep(0.45, 1.0, abs(vSide)));   // soft edges
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// car: getters from index.html (vehicle, y, air, vy, off, under, rail); scene: where the marks draw
export function createSkid({ car, scene, mood = null, carScale = 1 } = {}) {
  const mname = mood?.name || '';
  const night = /night|moon/.test(mname), snow = mname === 'snow';
  const moodA = snow ? 1.3 : night ? 0.75 : 1;

  const geo = new THREE.BufferGeometry();
  const P = new Float32Array(MAX * 4 * 3), M = new Float32Array(MAX * 4 * 2), S = new Float32Array(MAX * 4);
  const idx = new Uint16Array(MAX * 6);
  for (let q = 0; q < MAX; q++) {
    S[q * 4] = -1; S[q * 4 + 1] = 1; S[q * 4 + 2] = -1; S[q * 4 + 3] = 1;   // 0 / 1 start edge left / right, 2 / 3 end edge
    M[q * 8 + 0] = M[q * 8 + 2] = M[q * 8 + 4] = M[q * 8 + 6] = -1e6;      // never laid: long faded
    const v = q * 4, i = q * 6;
    idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1; idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
  }
  const aPos = new THREE.BufferAttribute(P, 3), aMark = new THREE.BufferAttribute(M, 2);
  aPos.setUsage(THREE.DynamicDrawUsage); aMark.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aMark', aMark); geo.setAttribute('aSide', new THREE.BufferAttribute(S, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const U = { uNow: { value: 0 }, uLife: { value: SKID.life }, uBias: { value: SKID.bias },
              uColor: { value: new THREE.Color(snow ? 0x2a2c30 : 0x0b0b0c) } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 1;   // after the sun blob, under the contact shadow
  mesh.visible = false;
  scene?.add(mesh);

  let enabled = store.get(STORE_KEY) !== '0';
  let now = 0, head = 0, laid = 0, lastLay = -1e6;   // mark clock (s), next quad, quads ever laid, last lay time (visibility)
  // per wheel chain: active, last centre, last edge (left / right x y z)
  const ch = [0, 1, 2, 3].map(() => ({ on: false, x: 0, y: 0, z: 0, e: new Float32Array(6), k: 1 }));
  const want = [0, 0, 0, 0];
  // detection state (as js/dust.js detect)
  let have = false, vfPrev = 0, vxPrev = 0, vzPrev = 0, aLong = 0, axS = 0, azS = 0;
  let stand = 0, pullLeft = 0, landLeft = 0, wasAir = false, airVy = 0, braking = false;

  function clear() {
    for (let q = 0; q < MAX; q++) M[q * 8] = M[q * 8 + 2] = M[q * 8 + 4] = M[q * 8 + 6] = -1e6;
    aMark.needsUpdate = true; laid = 0; mesh.visible = false;
    for (const c of ch) c.on = false;
  }

  const W = [0, 0, 0];
  function wheel(v, i) {   // world x, ride-plane y, z of wheel i (0 FL, 1 FR, 2 RL, 3 RR)
    const c = v.wheels[i].body.GetWorldCenter(), b = v.body.GetWorldCenter(), h = v.getHeading();
    const dx = c.x - b.x, dz = c.y - b.y, chh = Math.cos(h), sh = Math.sin(h);
    const xl = dx * chh + dz * sh, zl = dz * chh - dx * sh;
    W[0] = c.x; W[2] = c.y; W[1] = car.y + xl * Math.sin(v.roll) - zl * Math.sin(v.tilt) + SKID.lift * carScale;
    return W;
  }
  function edge(out, x, y, z, dx, dz, hw) {   // left / right corners across the travel direction
    const l = Math.hypot(dx, dz) || 1, nx = -dz / l * hw, nz = dx / l * hw;
    out[0] = x + nx; out[1] = y; out[2] = z + nz; out[3] = x - nx; out[4] = y; out[5] = z - nz;
  }
  const eNew = new Float32Array(6);
  function lay(c, x, y, z, hw) {
    const dx = x - c.x, dz = z - c.z;
    edge(eNew, x, y, z, dx, dz, hw);
    if (!c.started) edge(c.e, c.x, c.y, c.z, dx, dz, hw);   // first quad: start edge square to it
    const q = head; head = (head + 1) % MAX; laid++;
    const p = q * 12;
    P[p] = c.e[0]; P[p + 1] = c.e[1]; P[p + 2] = c.e[2]; P[p + 3] = c.e[3]; P[p + 4] = c.e[4]; P[p + 5] = c.e[5];
    P[p + 6] = eNew[0]; P[p + 7] = eNew[1]; P[p + 8] = eNew[2]; P[p + 9] = eNew[3]; P[p + 10] = eNew[4]; P[p + 11] = eNew[5];
    const a = SKID.alpha * moodA * c.k;
    for (let j = 0; j < 4; j++) { M[q * 8 + j * 2] = now; M[q * 8 + j * 2 + 1] = a; }
    aPos.needsUpdate = true; aMark.needsUpdate = true;
    c.e.set(eNew); c.x = x; c.y = y; c.z = z; c.started = true;
    lastLay = now; mesh.visible = true;
  }

  function detect(v, dt) {   // fills want[] (strength 0 = no mark)
    want[0] = want[1] = want[2] = want[3] = 0;
    const lv = v.body.GetLinearVelocity(), h = v.getHeading();
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const vf = lv.x * fx + lv.y * fz, sp = Math.hypot(lv.x, lv.y);
    if (!have) { vfPrev = vf; vxPrev = lv.x; vzPrev = lv.y; aLong = axS = azS = 0; have = true; }
    const ka = 1 - Math.exp(-dt / DUST.accTau);
    aLong += ((vf - vfPrev) / dt - aLong) * ka;
    axS += ((lv.x - vxPrev) / dt - axS) * ka; azS += ((lv.y - vzPrev) / dt - azS) * ka;
    vfPrev = vf; vxPrev = lv.x; vzPrev = lv.y;
    if (car.air) { wasAir = true; airVy = Math.min(airVy, car.vy || 0); braking = false; pullLeft = 0; stand = 0; return; }
    if (wasAir) { wasAir = false; if (airVy < -1) landLeft = SKID.landT; airVy = 0; }
    // hard braking (start and hold as dust's brake stream)
    const fullDecel = 4 * v.spec.brakeForce / v.spec.mass, decel = -aLong * Math.sign(vf);
    if (!braking) braking = decel >= DUST.brakeFrac * fullDecel && Math.abs(vf) > DUST.brakeV && !v.wallContact;
    else braking = decel >= 0.5 * DUST.brakeFrac * fullDecel && Math.abs(vf) > 0.5;
    if (braking) { const k = Math.min(1, decel / fullDecel + 0.3); want[0] = want[1] = want[2] = want[3] = k; }
    // sharp turn: the outer pair (centripetal to the right -> left tyres)
    const aLat = axS * rx + azS * rz, thr = v.specName === 'bus' ? SKID.turnABus : SKID.turnA;
    if (sp > SKID.turnV && (Math.abs(aLat) >= thr || v.squealLevel >= SKID.squeal)) {
      const k = Math.min(1, Math.max(Math.abs(aLat) / (1.6 * thr), v.squealLevel, 0.6));
      for (const i of aLat > 0 ? [0, 2] : [1, 3]) want[i] = Math.max(want[i], k);
    }
    // hard pull-away: the driven pair
    if (sp < 0.5) stand += dt;
    else if (sp > DUST.pullV) {
      if (stand >= DUST.standT && v.throttle >= SKID.pullThrottle) pullLeft = SKID.pullT;
      stand = 0;
    }
    if (pullLeft > 0) { pullLeft -= dt; for (const i of v.spec.drive === 'front' ? [0, 1] : [2, 3]) want[i] = Math.max(want[i], 0.8); }
    if (landLeft > 0) { landLeft -= dt; want[2] = Math.max(want[2], 0.7); want[3] = Math.max(want[3], 0.7); }
  }

  // per frame from index.html's running frame loop (after the physics steps), dt in s
  function update(dt) {
    if (!(dt > 0)) return;
    now += dt; U.uNow.value = now; U.uLife.value = SKID.life; U.uBias.value = SKID.bias;
    mesh.visible = laid > 0 && now - lastLay < SKID.life;
    const v = car.vehicle;
    if (!v || !enabled || car.off || car.under || car.rail) { have = false; braking = false; for (const c of ch) c.on = false; return; }
    detect(v, dt);
    const hw = 0.5 * SKID.width * carScale * (v.specName === 'bus' ? SKID.busWidth : 1);
    for (let i = 0; i < 4; i++) {
      const c = ch[i], w = wheel(v, i);
      if (!want[i]) {   // chain ends: a last short piece up to here
        if (c.on && c.started && Math.hypot(w[0] - c.x, w[2] - c.z) > 0.1) lay(c, w[0], w[1], w[2], hw);
        c.on = false; continue;
      }
      c.k = 0.6 + 0.4 * want[i];
      const d = c.on ? Math.hypot(w[0] - c.x, w[2] - c.z) : 0;
      if (!c.on || d > SKID.jump) { c.on = true; c.started = false; c.x = w[0]; c.y = w[1]; c.z = w[2]; continue; }
      if (d >= SKID.step) lay(c, w[0], w[1], w[2], hw);
    }
  }
  function setEnabled(on) {
    enabled = !!on; store.set(STORE_KEY, enabled ? '1' : '0');
    if (!enabled) clear();
    return enabled;
  }
  return { update, setEnabled, clear, mesh, opts: SKID, get enabled() { return enabled; }, get laid() { return laid; } };
}

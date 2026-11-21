// Street dust: now and then soft dust puffs kick up behind the car's rear wheels, so the car reads
// as touching the street (the next step after the contact shadow). Not a constant trail: every
// puff is tied to something the car does.
//
// Triggers (thresholds in DUST below; car / bus from the vehicle's own numbers):
//   pull away   standing >= standT s (< 0.5 m/s), then past pullV m/s (4 km/h): a 0.45 s burst
//   hard brake  smoothed deceleration >= brakeFrac x full braking (car 0.65 x 8.5 = 5.5 m/s2, bus
//               0.65 x 5.9 = 3.8 m/s2; coasting is 0.5 x, the governor 2.5 m/s2) above brakeV m/s: a
//               stream from both rear wheels while it lasts (<= brakeMax s)
//   sharp turn  lateral acceleration >= turnA m/s2 (bus turnABus) above turnV m/s, or tyre squeal
//               >= squeal: a puff from the outer rear wheel, again every turnEvery s while it holds
//   landing     air -> ground after a hop: a ring from all four wheels, strength from the fall speed
//   wall hit    a new impact nose-dip (js/vehicle.js IMPACT) of >= 2 m/s into the wall: from the
//               wheels at the hitting end
//   bump        pitch + roll change >= bumpJolt rad in one frame above bumpV m/s (kerb-like)
//   cruise      above cruiseV m/s, irregular (Poisson, mean cruiseEvery s, never closer than cruiseGap):
//               a light puff; more often on rough ground (smoothed attitude rate, see `rough`)
// Every kind has a cooldown; a full pool just skips new particles.
//
// Look: one shared soft lumpy texture (canvas), particles drawn as points: start at the tyre contact
// (rear wheel on the ride plane: car height + pitch / roll at that wheel), drift back, out and up,
// grow from size0 to size1 m and fade over life s; vertical shade (lighter top). Street dust is a
// warm light grey-beige, semi-transparent (peak alpha <= `alpha`).
//
// Scene: own scene, drawn by draw() right after the car pass (index.html drawPasses). Depth-tested,
// no depth writes: buildings hide puffs like they hide the car; pulled `bias` m toward the camera
// (as the car pass is pulled 3 m) so the street mesh does not cut the lower half off. Not in the
// main scene -> never a camera occluder and never triggers the ghost; not in carScene -> no ghost.
// Inside drawPasses -> with a mood it goes through the same HDR buffer, tone mapping and bloom.
//
// Moods: off / day = beige street dust; snow = snow spray (whiter, denser, more often, settles
// instead of rising; the snow mood itself only cuts tyre tracks, no spray, so nothing doubles);
// moon = dim, bluish, a little fainter. S-Bahn rails: sparser, darker brown "ballast and rust".
// Roof: plain dust. None in a tunnel (pool cleared), while a sequence owns the car (rescue, lift,
// S-Bahn, edge turn-around, water / pit sinking), or in the air (the landing puff comes instead).
//
// Cost: pool of MAX = 56 points, one THREE.Points = 1 draw call, nothing drawn while none is alive.
// Per frame: a few vector reads (no allocations), attribute upload only while puffs live.
//
// Setting: localStorage 'berlinDrive.dust' ('0' = off, default on); berlinDrive.dust.setEnabled(bool),
// berlinDrive.dust.puff(kind?, strength?) (one now, kind: 'pull' | 'brake' | 'turn' | 'land' | 'wall' |
// 'bump' | 'cruise'), berlinDrive.dust.opts (live tuning), .alive, .rough.
import * as THREE from 'three';
import { IMPACT } from './vehicle.js';

export const DUST = {
  scale: 1.15,          // size x (1: puff grows 0.8 -> 2.4 m; 1.15 for the 60/80 camera, was 1 for 60/60)
  size0: 0.8, size1: 2.4,   // m, start / end diameter of one particle (bus x busSize)
  busSize: 1.4,
  life: [1.2, 1.8],     // s per particle
  alpha: 0.4,           // peak opacity of one particle (x strength 0.55..1)
  bias: 2.5,            // m toward the camera (depth only)
  back: [0.6, 1.8],     // m/s backward (against the travel direction), x strength
  side: [0.2, 0.9],     // m/s outward
  up: [0.35, 0.8],      // m/s up at the start
  inherit: 0.25,        // share of the car's velocity the dust starts with
  drag: 1.8,            // 1/s
  lift: 0.12,           // m/s2 buoyancy (snow: -0.5, it settles)
  // triggers
  standT: 0.5, pullV: 1.1, pullN: 12,
  brakeFrac: 0.65, brakeV: 3.5, brakeRate: 14, brakeMax: 1.2,
  turnA: 5.0, turnABus: 3.0, turnV: 7, squeal: 0.35, turnN: 5, turnEvery: 0.7,
  landN: 14,
  wallN: 8, wallMinV: 2,
  bumpJolt: 0.03, bumpV: 2.2, bumpN: 5,
  cruiseV: 5.5, cruiseEvery: 7, cruiseGap: 2, cruiseN: [2, 3], rough: 0.05, roughMax: 3,
  cool: { pull: 1.5, brake: 1.5, turn: 0.7, land: 0.3, wall: 0.6, bump: 0.8, cruise: 0 },
  accTau: 0.12,         // s, acceleration smoothing
};
const MAX = 56;
const STORE_KEY = 'berlinDrive.dust';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const rnd = (a, b) => a + Math.random() * (b - a);

// soft lumpy puff: a few overlapping radial blobs inside the inner 70 % (edges stay fully clear)
function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const blob = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  };
  blob(32, 32, 30, 0.75);
  for (const [dx, dy, r, a] of [[-7, -4, 15, 0.45], [8, -6, 13, 0.4], [5, 8, 14, 0.4], [-8, 7, 12, 0.35], [1, -11, 11, 0.3]]) blob(32 + dx, 32 + dy, r, a);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

const VERT = /* glsl */`
uniform float uPx, uBias;
attribute vec4 aData;   // size (m), alpha, rotation (rad), shade
attribute vec3 aColor;
varying float vA, vRot, vShade;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = length(mv.xyz);
  mv.xyz -= mv.xyz / max(d, 1e-3) * min(uBias, 0.5 * d);   // depth bias toward the camera
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aData.x * uPx / max(-mv.z, 1.0);
  vA = aData.y; vRot = aData.z; vShade = aData.w; vCol = aColor;
}`;
const FRAG = /* glsl */`
uniform sampler2D uMap;
varying float vA, vRot, vShade;
varying vec3 vCol;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  float a = texture2D(uMap, vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5).a * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * mix(1.06, 0.8, gl_PointCoord.y) * vShade, a);   // lighter top, darker underside
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// car: getters from index.html (vehicle, y, air, vy, off, under, rail)
export function createDust({ car, mood = null, carScale = 1 } = {}) {
  const mname = mood?.name || '';
  const night = /night|moon/.test(mname), snow = mname === 'snow';
  // colours (sRGB) and mood factors: alpha, particle count, how often cruising puffs come
  const C = night ? { street: '#566073', rail: '#3b3a44', a: 0.8, n: 1, often: 1 }
          : snow  ? { street: '#f2f5f8', rail: '#9a9089', a: 1.25, n: 1.3, often: 1.6 }
          :         { street: '#cbbfa8', rail: '#6b5240', a: 1, n: 1, often: 1 };
  const colStreet = new THREE.Color(C.street), colRail = new THREE.Color(C.rail);   // -> linear (colour management)
  const RAIL = { n: 0.5, often: 0.5, a: 0.85, size: 0.8 };   // S-Bahn: sparser, smaller

  const scene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  const P = new Float32Array(MAX * 3), D = new Float32Array(MAX * 4), K = new Float32Array(MAX * 3);
  const aPos = new THREE.BufferAttribute(P, 3), aData = new THREE.BufferAttribute(D, 4), aCol = new THREE.BufferAttribute(K, 3);
  for (const a of [aPos, aData, aCol]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aData', aData); geo.setAttribute('aColor', aCol);
  geo.setDrawRange(0, 0);
  const U = { uMap: { value: puffTexture() }, uPx: { value: 500 }, uBias: { value: DUST.bias } };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthTest: true, depthWrite: false, blending: THREE.NormalBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; scene.add(points);

  // particle state (struct of arrays, alive ones packed at 0..n-1)
  let n = 0;
  const vx = new Float32Array(MAX), vy = new Float32Array(MAX), vz = new Float32Array(MAX),
        age = new Float32Array(MAX), life = new Float32Array(MAX), s0 = new Float32Array(MAX), s1 = new Float32Array(MAX),
        a0 = new Float32Array(MAX), rot = new Float32Array(MAX), spin = new Float32Array(MAX), lift = new Float32Array(MAX);

  let enabled = store.get(STORE_KEY) !== '0';
  // vehicle-derived state
  let vfPrev = 0, vxPrev = 0, vzPrev = 0, axS = 0, azS = 0, aLong = 0, have = false;
  let stand = 0, wasAir = false, airVy = 0, impactPrev = 9, tiltPrev = 0, rollPrev = 0, rough = 0;
  let brakeT = -1, turnT = 0, cruiseWait = rnd(2, 8);
  const cool = { pull: 0, brake: 0, turn: 0, land: 0, wall: 0, bump: 0, cruise: 0 };
  let burst = null;   // reused object: { left, n, k, where, kind } while a pull-away burst runs
  const burstObj = { left: 0, every: 0, t: 0, k: 1, where: 0, kind: 'pull', per: 0 };

  function clear() { n = 0; geo.setDrawRange(0, 0); burst = null; brakeT = -1; }

  // wheel at index i: world x, z, ride-plane height; out: [x, y, z, side (+1 right / -1 left)]
  const W = [0, 0, 0, 0];
  function wheel(v, i) {
    const c = v.wheels[i].body.GetWorldCenter(), b = v.body.GetWorldCenter(), h = v.getHeading();
    const dx = c.x - b.x, dz = c.y - b.y, ch = Math.cos(h), sh = Math.sin(h);
    const xl = dx * ch + dz * sh, zl = dz * ch - dx * sh;   // local right / back (model +X / +Z)
    W[0] = c.x; W[2] = c.y; W[3] = xl >= 0 ? 1 : -1;
    W[1] = car.y + xl * Math.sin(v.roll) - zl * Math.sin(v.tilt);
    return W;
  }

  // spawn count particles at wheels (where: 0 rear pair, 1 front pair, 2 all four, 3 / 4 rear left / right)
  function spawn(kind, count, k, where) {
    const v = car.vehicle; if (!v) return;
    const rail = !!car.rail, col = rail ? colRail : colStreet;
    count = Math.round(count * C.n * (rail ? RAIL.n : 1));
    if (count < 1) return;
    const h = v.getHeading(), fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const lv = v.body.GetLinearVelocity(), vf = lv.x * fx + lv.y * fz;
    const dir = Math.abs(vf) > 0.3 ? Math.sign(vf) : (v.gear || 1);
    const bus = v.specName === 'bus' ? DUST.busSize : 1;
    const sz = DUST.scale * carScale * bus * (rail ? RAIL.size : 1);
    const ring = kind === 'land' || kind === 'wall';
    for (let j = 0; j < count && n < MAX; j++) {
      const wi = where === 0 ? 2 + (j & 1) : where === 1 ? (j & 1) : where === 2 ? (j & 3) : where === 3 ? 2 : 3;
      const w = wheel(v, wi), i = n++;
      const jitter = 0.25 * carScale;
      P[i * 3] = w[0] + rnd(-jitter, jitter); P[i * 3 + 1] = w[1] + 0.15 * carScale; P[i * 3 + 2] = w[2] + rnd(-jitter, jitter);
      const back = rnd(DUST.back[0], DUST.back[1]) * (0.6 + 0.4 * k) * (ring ? 0.4 : 1) * -dir;
      const side = rnd(DUST.side[0], DUST.side[1]) * w[3] * (ring ? 1.8 : 1);
      vx[i] = lv.x * DUST.inherit + fx * back + rx * side;
      vz[i] = lv.y * DUST.inherit + fz * back + rz * side;
      vy[i] = rnd(DUST.up[0], DUST.up[1]) * (snow ? 0.8 : 1) * (0.7 + 0.3 * k);
      age[i] = 0; life[i] = rnd(DUST.life[0], DUST.life[1]) * (snow ? 0.85 : 1);
      s0[i] = DUST.size0 * sz * rnd(0.8, 1.15); s1[i] = DUST.size1 * sz * rnd(0.85, 1.15) * (0.75 + 0.25 * k);
      a0[i] = DUST.alpha * C.a * (rail ? RAIL.a : 1) * (0.55 + 0.45 * k) * rnd(0.8, 1);
      rot[i] = rnd(0, 6.283); spin[i] = rnd(-0.6, 0.6);
      lift[i] = snow ? -0.5 : DUST.lift;
      const shade = rnd(0.9, 1.04);
      K[i * 3] = col.r * shade; K[i * 3 + 1] = col.g * shade; K[i * 3 + 2] = col.b * shade;
      D[i * 4 + 3] = 1;
    }
  }
  function startBurst(kind, total, dur, k, where) {
    const b = burstObj; b.kind = kind; b.k = k; b.where = where; b.t = 0;
    b.per = 2; b.left = Math.max(1, Math.round(total / 2)); b.every = dur / b.left;
    burst = b; spawn(kind, b.per, k, where); b.left--;
  }

  function fire(kind, k = 1) {
    const v = car.vehicle; if (!v) return false;
    k = Math.min(1, Math.max(0.2, k));
    switch (kind) {
      case 'pull': startBurst('pull', DUST.pullN, 0.45, k, 0); break;
      case 'brake': brakeT = 0; spawn('brake', 4, k, 0); break;
      case 'turn': spawn('turn', DUST.turnN, k, turnSide); break;
      case 'land': spawn('land', DUST.landN, k, 2); break;
      case 'wall': spawn('wall', DUST.wallN, k, wallEnd); break;
      case 'bump': spawn('bump', DUST.bumpN, k, 0); break;
      default: spawn('cruise', Math.random() < 0.5 ? DUST.cruiseN[0] : DUST.cruiseN[1], k, Math.random() < 0.5 ? 3 : 4);
    }
    return true;
  }
  let turnSide = 3, wallEnd = 1;

  // per frame (index.html frame(), after the physics steps: vehicle and ride height final)
  function update(dt) {
    if (dt <= 0) return;
    if (car.under) { if (n) clear(); have = false; return; }
    const v = car.vehicle;
    for (const key in cool) cool[key] -= dt;
    if (v && enabled && !car.off) detect(v, dt); else { have = false; burst = null; brakeT = -1; wasAir = false; }
    // bursts / streams
    if (burst) {
      burst.t += dt;
      while (burst && burst.t >= burst.every) { burst.t -= burst.every; spawn(burst.kind, burst.per, burst.k, burst.where); if (--burst.left <= 0) burst = null; }
    }
    // particles
    const dr = Math.exp(-DUST.drag * dt);
    for (let i = 0; i < n;) {
      age[i] += dt;
      if (age[i] >= life[i]) { kill(i); continue; }
      vx[i] *= dr; vz[i] *= dr; vy[i] = vy[i] * dr + lift[i] * dt;
      P[i * 3] += vx[i] * dt; P[i * 3 + 1] += vy[i] * dt; P[i * 3 + 2] += vz[i] * dt;
      const u = age[i] / life[i];
      D[i * 4] = s0[i] + (s1[i] - s0[i]) * (1 - Math.exp(-3.2 * u));
      D[i * 4 + 1] = a0[i] * Math.min(1, age[i] / 0.12) * Math.pow(1 - u, 1.5);
      rot[i] += spin[i] * dt; D[i * 4 + 2] = rot[i];
      i++;
    }
    geo.setDrawRange(0, n);
    if (n) { aPos.needsUpdate = true; aData.needsUpdate = true; aCol.needsUpdate = true; }
  }
  function kill(i) {
    const j = --n;
    if (i === j) return;
    for (let c = 0; c < 3; c++) { P[i * 3 + c] = P[j * 3 + c]; K[i * 3 + c] = K[j * 3 + c]; }
    for (let c = 0; c < 4; c++) D[i * 4 + c] = D[j * 4 + c];
    vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j]; age[i] = age[j]; life[i] = life[j];
    s0[i] = s0[j]; s1[i] = s1[j]; a0[i] = a0[j]; rot[i] = rot[j]; spin[i] = spin[j]; lift[i] = lift[j];
  }

  function detect(v, dt) {
    const lv = v.body.GetLinearVelocity(), h = v.getHeading();
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const vf = lv.x * fx + lv.y * fz, sp = Math.hypot(lv.x, lv.y);
    const air = !!car.air;
    if (!have) { vfPrev = vf; vxPrev = lv.x; vzPrev = lv.y; axS = azS = aLong = 0; tiltPrev = v.tilt; rollPrev = v.roll; impactPrev = v.impactT; have = true; }
    const ka = 1 - Math.exp(-dt / DUST.accTau);
    aLong += ((vf - vfPrev) / dt - aLong) * ka;
    axS += ((lv.x - vxPrev) / dt - axS) * ka; azS += ((lv.y - vzPrev) / dt - azS) * ka;
    vfPrev = vf; vxPrev = lv.x; vzPrev = lv.y;
    const jolt = Math.abs(v.tilt - tiltPrev) + Math.abs(v.roll - rollPrev);
    tiltPrev = v.tilt; rollPrev = v.roll;
    const imp = v.impactT, newImpact = imp < impactPrev; impactPrev = imp;

    // in the air: nothing; remember the fall speed for the landing
    if (air) { wasAir = true; airVy = Math.min(airVy, car.vy || 0); brakeT = -1; burst = null; stand = 0; return; }
    if (wasAir) {
      wasAir = false;
      if (airVy < -1 && cool.land <= 0) { fire('land', 0.4 + 0.6 * Math.min(1, -airVy / 9.6)); cool.land = DUST.cool.land; }
      airVy = 0;
    }
    // wall hit (vehicle.impactA: nose-dip, < 0 = nose first)
    if (newImpact && Math.abs(v.impactA) >= IMPACT.dipPerMs * DUST.wallMinV && cool.wall <= 0) {
      wallEnd = v.impactA < 0 ? 1 : 0;
      fire('wall', Math.abs(v.impactA) / IMPACT.dipMax); cool.wall = DUST.cool.wall;
    }
    if (newImpact) cool.brake = Math.max(cool.brake, DUST.cool.wall);   // the stop at a wall is no braking
    // pull away from standstill
    if (sp < 0.5) stand += dt;
    else if (sp > DUST.pullV) {
      if (stand >= DUST.standT && cool.pull <= 0) { fire('pull', 1); cool.pull = DUST.cool.pull; }
      stand = 0;
    }
    // hard braking: a stream while it lasts
    const fullDecel = 4 * v.spec.brakeForce / v.spec.mass;
    const decel = -aLong * Math.sign(vf);
    const hard = decel >= DUST.brakeFrac * fullDecel && Math.abs(vf) > DUST.brakeV && !v.wallContact;
    if (brakeT >= 0) {
      const keep = decel >= 0.5 * DUST.brakeFrac * fullDecel && Math.abs(vf) > 0.5 && brakeT <= DUST.brakeMax;
      if (!keep) { brakeT = -1; cool.brake = DUST.cool.brake; }
      else {
        const prev = brakeT; brakeT += dt;
        const k = Math.min(1, decel / fullDecel + 0.3);
        if (Math.floor(brakeT * DUST.brakeRate / 2) > Math.floor(prev * DUST.brakeRate / 2)) spawn('brake', 2, k, 0);
      }
    } else if (hard && cool.brake <= 0) fire('brake', Math.min(1, decel / fullDecel + 0.3));
    // sharp turn: lateral acceleration (smoothed) or squeal
    const aLat = axS * rx + azS * rz, thr = v.specName === 'bus' ? DUST.turnABus : DUST.turnA;
    if (sp > DUST.turnV && (Math.abs(aLat) >= thr || v.squealLevel >= DUST.squeal)) {
      turnT -= dt;
      if (turnT <= 0 && cool.turn <= 0) {
        turnSide = aLat > 0 ? 3 : 4;   // centripetal to the right -> dust from the outer (left) rear wheel
        fire('turn', Math.max(Math.abs(aLat) / (1.6 * thr), v.squealLevel)); turnT = DUST.turnEvery; cool.turn = DUST.cool.turn;
      }
    } else turnT = 0;
    // kerb-like bump; roughness (rad/s of attitude change, smoothed ~1.5 s)
    if (!v.held) rough += (jolt / dt - rough) * (1 - Math.exp(-dt / 1.5));
    if (jolt >= DUST.bumpJolt && sp > DUST.bumpV && cool.bump <= 0) { fire('bump', Math.min(1, jolt / (3 * DUST.bumpJolt))); cool.bump = DUST.cool.bump; }
    // cruising: sparse, irregular, more on rough ground
    if (sp > DUST.cruiseV && brakeT < 0 && !burst) {
      const rate = C.often * (car.rail ? RAIL.often : 1) * Math.min(DUST.roughMax, 1 + rough / DUST.rough);
      cruiseWait -= dt * rate;
      if (cruiseWait <= 0) {
        fire('cruise', rnd(0.3, 0.5));
        cruiseWait = DUST.cruiseGap - Math.log(1 - Math.random()) * Math.max(0, DUST.cruiseEvery - DUST.cruiseGap);
      }
    }
  }

  const px = new THREE.Vector2();
  function draw(renderer, cam) {
    if (!n) return;
    U.uPx.value = renderer.getDrawingBufferSize(px).y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    U.uBias.value = DUST.bias;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(scene, cam);
    renderer.autoClear = ac;
  }
  function setEnabled(on) {
    enabled = !!on; store.set(STORE_KEY, enabled ? '1' : '0');
    if (!enabled) clear();
    return enabled;
  }
  // one puff now (for trying; also when switched off), kind as in the header
  function puff(kind = 'pull', k = 1) {
    if (car.under) return false;
    return fire(kind, k);
  }
  return {
    update, draw, puff, setEnabled, clear, scene, opts: DUST,
    get enabled() { return enabled; }, get alive() { return n; }, get rough() { return rough; },
  };
}

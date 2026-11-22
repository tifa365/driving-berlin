// Border shimmer: now and then a soft wave of light runs along the level border near the car,
// so the invisible edge (js/edge.js glass) can be found. At rest it is barely there; every few
// seconds a band of brighter streaks travels along the wall past the car, and a stronger pulse
// comes when the car touches the border or is turned around (edge.js opts.onTouch -> pulse()).
//
// - One mesh: up to two vertical strips (the nearest side, and the second one near a corner),
//   each the stretch of border within `reach` m of the car's projection onto it, standing on the
//   inner face of the Box2D border (where the glass stands). Base `below` m under the game's
//   ground (groundAt, sampled per column, lowest of neighbours), `height` m high.
// - Shader: per-fragment fade around the car (full within nearFull, gone at nearGone), brightest
//   at the ground fading to nothing at the top, fine vertical streaks (value noise along the
//   wall, world-anchored so they do not slide when the strip is rebuilt), additive, no depth
//   writes, depth-tested (buildings in front hide it), double-sided, not tone mapped.
// - Own scene, drawn after the edge glass: never a camera occluder (js/camcollide.js only takes
//   userData.world meshes of the main scene), no collider.
// - Cost: geometry rewritten only when the car moved `rebuild` m or the side set changed; no
//   per-frame allocations; nothing drawn when the car is further than nearGone from every side,
//   in a tunnel, while loading or while the map covers the screen (opts.hidden()).
// - Time: update(dt) with the game's scaled dt (pause / menu slow motion honoured).
// Console: berlinDrive.borderShimmer.pulse(), .setEnabled(bool) (saved as berlinDrive.shimmer,
// '0' = off, default on), .opts (live tuning).
import * as THREE from 'three';

export const SHIMMER = {
  nearFull: 40, nearGone: 150,   // m, fade around the car (per fragment)
  reach: 160,                    // m of border drawn either side of the car's projection
  height: 28, below: 1.5,        // m curtain height over the ground / base under it
  rebuild: 4,                    // m the car moves before the strip is rebuilt
  rest: 0.065,                   // opacity at rest
  wave: 0.35,                    // peak opacity of a passing wave
  waveEvery: [2.5, 4],           // s between waves (counted only while the border is in reach)
  waveT: 1.1,                    // s a wave takes to run past
  waveSpan: 130,                 // m: runs from -span to +span along the wall around the car
  waveW: 14,                     // m, half-width of the bright band
  pulse: 0.55,                   // peak opacity of the contact pulse
  pulseT: 1.4,                   // s the pulse ring runs / fades
  pulseSpeed: 90,                // m/s the pulse ring spreads along the wall
  pulseGap: 1.5,                 // s, minimum between two pulses
  streakScale: 1.6,              // streaks per metre (coarse noise frequency)
  wallHalf: 0.3,                 // index.html addWall half thickness (edge.js WALL_HALF)
};
const COLS = 32;                 // columns per strip
const STORE_KEY = 'berlinDrive.shimmer';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const rnd = (a, b) => a + Math.random() * (b - a);

const VERT = /* glsl */`
attribute vec3 aData;   // along-wall world coordinate (m), ground height, strip (0 / 1)
varying vec3 vW; varying float vU, vH, vS;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vU = aData.x; vH = position.y - aData.y; vS = aData.z;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */`
uniform vec2 uCar, uProj; uniform vec3 uColor;
uniform float uT, uNearFull, uNearGone, uH, uRest, uGain, uScale;
uniform float uWaveS, uWaveA, uWaveW, uPulseR, uPulseA, uPulseW;
varying vec3 vW; varying float vU, vH, vS;
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float noise(float x) { float i = floor(x), f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float near = 1.0 - smoothstep(uNearFull, uNearGone, distance(vW.xz, uCar));
  if (near <= 0.0 || vH < -0.5) discard;
  float u = vU * uScale;
  // fine vertical streaks: coarse + fine noise, slowly drifting; each streak reaches its own height
  float st = noise(u + 0.3 * uT) * 0.65 + noise(u * 3.7 - 0.5 * uT) * 0.35;
  float top = uH * (0.45 + 0.55 * noise(u * 0.5 + 17.0));
  float prof = 1.0 - smoothstep(0.0, top, vH);
  prof *= prof;
  float streak = 0.35 + 1.3 * st * st;
  // travelling wave and contact pulse, by the distance along the wall from the car's projection
  float rel = vU - (vS < 0.5 ? uProj.x : uProj.y);
  float wd = (rel - uWaveS) / uWaveW, wave = uWaveA * exp(-wd * wd);
  float pd = (abs(rel) - uPulseR) / uPulseW, pulse = uPulseA * (exp(-pd * pd) + 0.35 * exp(-rel * rel / 900.0));
  float a = (uRest * streak + (wave + pulse) * (0.25 + 1.2 * st * st)) * prof * near * uGain;
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.8));
}`;

// opts: { extent, groundAt(x, z), vehicle() -> Vehicle, mood, hidden() -> bool }
export function createBorderShimmer({ extent: ex, groundAt, vehicle, mood = null, hidden = () => false }) {
  const O = SHIMMER;
  const mname = mood?.name || '';
  const look = /night|moon/.test(mname) ? { color: 0xb4d4ff, gain: 1.3 } : { color: 0xdcf6ff, gain: 1 };   // day / snow / off: pale cyan-white
  const X0 = ex.minX + O.wallHalf, X1 = ex.maxX - O.wallHalf, Z0 = ex.minZ + O.wallHalf, Z1 = ex.maxZ - O.wallHalf;   // inner faces (as edge.js)

  const NV = 2 * (COLS + 1) * 2;
  const P = new Float32Array(NV * 3), D = new Float32Array(NV * 3), G = new Float32Array(COLS + 1);
  const idx = [];
  for (let s = 0; s < 2; s++) for (let i = 0; i < COLS; i++) {
    const v = s * (COLS + 1) * 2 + 2 * i; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(P, 3), aData = new THREE.BufferAttribute(D, 3);
  aPos.setUsage(THREE.DynamicDrawUsage); aData.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aData', aData); geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const U = {
    uCar: { value: new THREE.Vector2() }, uProj: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(look.color) },
    uT: { value: 0 }, uNearFull: { value: O.nearFull }, uNearGone: { value: O.nearGone }, uH: { value: O.height },
    uRest: { value: O.rest }, uGain: { value: look.gain }, uScale: { value: O.streakScale },
    uWaveS: { value: 0 }, uWaveA: { value: 0 }, uWaveW: { value: O.waveW },
    uPulseR: { value: 0 }, uPulseA: { value: 0 }, uPulseW: { value: 10 },
  };
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false,
  }));
  mesh.frustumCulled = false; mesh.name = 'borderShimmer'; mesh.visible = false;
  const scene = new THREE.Scene(); scene.add(mesh);

  let enabled = store.get(STORE_KEY) !== '0';
  let t = 0, nextWave = rnd(...O.waveEvery), waveAge = -1, waveDir = 1, pulseAge = -1, sincePulse = 99;
  let bx = NaN, bz = NaN, bKey = -1;   // last build: car position, side set
  const dist = [0, 0, 0, 0], pick = [-1, -1];

  // strip s on side k (0: z = Z0, 1: x = X1, 2: z = Z1, 3: x = X0), around the car's projection c
  function buildStrip(s, k, cx, cz) {
    const alongX = k === 0 || k === 2;
    const lo = alongX ? X0 : Z0, hi = alongX ? X1 : Z1, c = alongX ? cx : cz, fixed = [Z0, X1, Z1, X0][k];
    const a = Math.max(lo, c - O.reach), b = Math.min(hi, c + O.reach);
    for (let i = 0; i <= COLS; i++) {
      const u = a + (b - a) * i / COLS;
      G[i] = alongX ? groundAt(u, fixed) : groundAt(fixed, u);
    }
    for (let i = 0; i <= COLS; i++) {
      const u = a + (b - a) * i / COLS;
      const g = Math.min(G[i], G[Math.max(0, i - 1)], G[Math.min(COLS, i + 1)]);   // never floats over a dip
      const x = alongX ? u : fixed, z = alongX ? fixed : u;
      const v = (s * (COLS + 1) + i) * 2, p = v * 3;
      P[p] = x; P[p + 1] = g - O.below; P[p + 2] = z;
      P[p + 3] = x; P[p + 4] = g + O.height; P[p + 5] = z;
      D[p] = u; D[p + 1] = g; D[p + 2] = s;
      D[p + 3] = u; D[p + 4] = g; D[p + 5] = s;
    }
  }

  function update(dt) {
    const veh = vehicle();
    mesh.visible = false;
    if (!enabled || !veh || hidden()) return;
    const p = veh.getPosition(), x = p.x, z = p.y;
    dist[0] = z - Z0; dist[1] = X1 - x; dist[2] = Z1 - z; dist[3] = x - X0;
    pick[0] = pick[1] = -1;
    for (let i = 0; i < 4; i++) {
      if (dist[i] >= O.nearGone) continue;
      if (pick[0] < 0 || dist[i] < dist[pick[0]]) { pick[1] = pick[0]; pick[0] = i; }
      else if (pick[1] < 0 || dist[i] < dist[pick[1]]) pick[1] = i;
    }
    sincePulse += dt;
    if (pick[0] < 0) { waveAge = -1; pulseAge = -1; bKey = -1; return; }   // middle of the map: nothing
    const key = pick[0] * 4 + (pick[1] + 1);
    if (key !== bKey || Math.hypot(x - bx, z - bz) > O.rebuild) {
      buildStrip(0, pick[0], x, z);
      const n = pick[1] >= 0 ? 2 : 1;
      if (n === 2) buildStrip(1, pick[1], x, z);
      geo.setDrawRange(0, n * COLS * 6);
      aPos.needsUpdate = true; aData.needsUpdate = true;
      bx = x; bz = z; bKey = key;
    }
    // clock, waves, pulse
    t += dt;
    if (waveAge < 0 && (nextWave -= dt) <= 0) { waveAge = 0; waveDir = Math.random() < 0.5 ? -1 : 1; nextWave = rnd(...O.waveEvery); }
    if (waveAge >= 0) {
      const f = (waveAge += dt) / O.waveT;
      if (f >= 1) { waveAge = -1; U.uWaveA.value = 0; }
      else {
        U.uWaveS.value = waveDir * O.waveSpan * (2 * f - 1);
        U.uWaveA.value = O.wave * Math.min(1, f / 0.15) * Math.min(1, (1 - f) / 0.15);
      }
    } else U.uWaveA.value = 0;
    if (pulseAge >= 0) {
      const f = (pulseAge += dt) / O.pulseT;
      if (f >= 1) { pulseAge = -1; U.uPulseA.value = 0; }
      else { U.uPulseR.value = O.pulseSpeed * pulseAge; U.uPulseA.value = O.pulse * (1 - f) * (1 - f); }
    } else U.uPulseA.value = 0;
    U.uCar.value.set(x, z);
    U.uProj.value.set(pick[0] === 0 || pick[0] === 2 ? x : z, pick[1] === 0 || pick[1] === 2 ? x : z);
    U.uT.value = t; U.uNearFull.value = O.nearFull; U.uNearGone.value = O.nearGone; U.uH.value = O.height;
    U.uRest.value = O.rest; U.uWaveW.value = O.waveW; U.uScale.value = O.streakScale;
    mesh.visible = true;
  }
  function draw(renderer, cam) {   // after the edge glass (autoClear off)
    if (!mesh.visible) return;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(scene, cam);
    renderer.autoClear = ac;
  }
  // a stronger pulse now (border touched / turned around); also a wave starts soon after
  function pulse() {
    if (!enabled || sincePulse < O.pulseGap) return false;
    sincePulse = 0; pulseAge = 0;
    nextWave = Math.max(nextWave, O.pulseT);
    return true;
  }
  function setEnabled(on) {
    enabled = !!on; store.set(STORE_KEY, enabled ? '1' : '0');
    if (!enabled) mesh.visible = false;
    return enabled;
  }
  return { update, draw, pulse, setEnabled, scene, mesh, opts: O, get enabled() { return enabled; } };
}

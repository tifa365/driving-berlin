// Ambient: white doves. Now and then (irregular, every 3-5 min) a pair of simplified white
// doves crosses the picture - the old Google Maps trick that makes a
// city feel alive. Purely visual: no colliders, no interaction, never a camera occluder.
//
// Look: one low-poly bird = 15 triangles (body 8, tail fan 1, two wings of 3 each), vertex
// colours (white, soft grey belly and wing tips), flat-shaded Lambert under its own hemisphere +
// sun light, so the flapping wings catch the light. The wing beat runs in the vertex shader
// (per-instance time offset / beat rate / beats per burst / glide length, one time uniform + one
// stroke uniform): bursts of 5-6 asymmetric beats per second (sharp downstroke ~40 % of the beat,
// slower upstroke, root +60 / -40 deg; the outer panel lags - stretched on the downstroke, folded
// down and swept back on the upstroke), then a 0.3-0.6 s glide with the wings in a shallow V; the
// body bobs up on each downstroke, climbs a little over a burst and sinks over the glide.
// Outline: the same instances drawn once more, a little larger, in soft grey, before the birds
// (depthWrite off) - so white on white (snow, bright roofs) still reads. 2 draw calls, <= 12 birds.
//
// Flight: positioned relative to the camera at spawn - a ray through the upper-middle of the
// picture, a point 24-70 m along it (between the camera and the street), a gently curved
// quadratic Bezier across the view through that point, from beyond one edge of the frustum to
// beyond the other. Birds keep individual offsets (the second trails the leader loosely, drifting
// a little along and sideways), near-equal speed factors and a slow bob. The flock is in
// world space (parallax against the buildings as the car moves) and ends once every bird is past
// the path end and out of the frustum (hard cap MAX_LIFE).
//
// Scene: own scene, drawn by draw() after the car pass (index.html drawPasses, after the balloon).
// Depth-tested against world + car, so buildings hide them and a dove in front of the car covers it
// for a moment; not in the main scene -> never triggers the car's ghost silhouette and is never in
// the camera-collision occluder set; not in carScene -> not drawn as a ghost itself.
//
// Moods: day / plain = white with a soft grey underside (hemisphere ground colour) and a light grey
// outline; snow = slightly lower light (so the shading shows) + darker outline and fog toward the
// horizon; moon = doves sleep: no automatic flocks (release() still sends one, dimmed, for trying).
// Tunnel (under = true): no flocks, a flock that is out vanishes.
//
// Cost: nothing but a timer check while no flock is out (draw() returns early); while one is out,
// <= 12 instance matrices per frame, no allocations.
//
// Setting: localStorage 'berlinDrive.doves' ('0' = off, default on); berlinDrive.doves.setEnabled(bool),
// berlinDrive.doves.release() (a flock right now), berlinDrive.doves.opts (live tuning).
import * as THREE from 'three';

export const DOVES = {
  scale: 1.0,           // bird size: 1 = 1.8 m wingspan (a real dove ~0.65 m; larger than life to read from 60/80; was 0.85 for 60/60)
  every: [180, 300],    // s between pairs (uniform random 3-5 min, never a fixed beat; owner 2026-11-21)
  first: [180, 300],    // s until the first pair after loading (same rule)
  count: 2,             // doves per flight: a pair (release(n) can send more, up to 12)
  speed: [6.5, 9],      // m/s along the path (was 11-16; ~58 %, owner 2026-11-21: slower, so the eye can follow)
  dist: [24, 70],       // m from the camera where the path crosses the view ray
  rayY: [-0.15, 0.55],  // NDC height of that ray (0 = picture centre; the car sits a little below it)
  minAlt: 12,           // m above the height model, at least
  curve: 0.18,          // sideways bulge of the path (x path length)
  maxLife: 50,          // s, hard cap per flock (each flock's own life = its path length / speed + margin)
  // wing beat (dove/pigeon: flap-flap-flap ... glide), read per bird at spawn (beatHz/burst/glide)
  // or every frame (strokeUp/strokeDown/downShare/climb)
  beatHz: [5.0, 6.0],   // beats per second while flapping, per bird
  burst: [1.0, 2.0],    // s of flapping before a glide (rounded to whole beats), per bird
  glide: [0.3, 0.6],    // s of gliding, wings held in a shallow V, per bird
  strokeUp: 60,         // deg, wing root at the top of the stroke (above the back)
  strokeDown: -40,      // deg, wing root at the bottom
  downShare: 0.4,       // share of a beat spent on the (sharply eased) downstroke; the upstroke is slower
  climb: 0.35,          // m (x scale): rise over a burst, sink over the glide
};
const MAX = 12;
const STORE_KEY = 'berlinDrive.doves';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- geometry: local metres at scale 1, forward +Z, up +Y, wings along X ----
function doveGeometry() {
  const P = [], C = [], W = [];
  const col = new THREE.Color();
  const tri = (a, b, c, ca, cb, cc, w = 0) => {
    for (const [v, h] of [[a, ca], [b, cb], [c, cc]]) { P.push(v[0], v[1], v[2]); col.setHex(h); C.push(col.r, col.g, col.b); W.push(w ? Math.sign(v[0]) || w : 0); }
  };
  const WHITE = 0xf8f8f5, BELLY = 0xc9ced6, TIP = 0xbfc5ce;
  // body: two pyramids (head, tail) on a diamond cross-section
  const H = [0, 0.03, 0.42], T = [0, 0.085, 0.05], B = [0, -0.07, 0.05], L = [-0.085, 0, 0.05], R = [0.085, 0, 0.05], Pt = [0, 0.01, -0.3];
  tri(H, T, L, WHITE, WHITE, WHITE); tri(H, R, T, WHITE, WHITE, WHITE);
  tri(H, L, B, WHITE, WHITE, BELLY); tri(H, B, R, WHITE, BELLY, WHITE);
  tri(Pt, L, T, WHITE, WHITE, WHITE); tri(Pt, T, R, WHITE, WHITE, WHITE);
  tri(Pt, B, L, WHITE, BELLY, WHITE); tri(Pt, R, B, WHITE, WHITE, BELLY);
  // tail fan
  tri([0, 0.01, -0.24], [-0.14, 0.01, -0.5], [0.14, 0.01, -0.5], WHITE, TIP, TIP);
  // wings: inner panel (2 tris) + outer panel to the tip (1 tri); the shader folds at |x| = 0.05 / 0.45
  for (const s of [1, -1]) {
    const sf = [0.05 * s, 0.03, 0.14], sb = [0.05 * s, 0.03, -0.1], m = [0.45 * s, 0.03, 0.09],
          mb = [0.45 * s, 0.03, -0.2], tip = [0.9 * s, 0.03, -0.13];
    tri(sf, m, sb, WHITE, WHITE, WHITE, s); tri(sb, m, mb, WHITE, WHITE, WHITE, s); tri(m, tip, mb, WHITE, TIP, TIP, s);
  }
  // shoulder vertices (|x| = 0.05) get wing weight too; harmless (r1 = r2 = 0 there)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.computeVertexNormals();
  return g;
}

// wing beat + bob (+ outline growth) in the vertex shader
const FLAP_HEAD = /* glsl */`
attribute float aWing;
attribute vec4 aFlap;   // time offset (s), beat rate (Hz), beats per burst, glide length (s)
uniform float uDoveTime;
uniform vec4 uStroke;   // root angle at the top / bottom (rad), downstroke share, climb (m)`;
const FLAP_BODY = /* glsl */`
{
  float dvBurst = aFlap.z / aFlap.y, dvPer = dvBurst + aFlap.w;
  float dvT = mod(uDoveTime + aFlap.x, dvPer);
  bool dvGliding = dvT >= dvBurst;
  float dvTg = dvT - dvBurst;
  float dvP = fract(dvT * aFlap.y);   // beat phase, 0 = wings at the top (a burst is whole beats)
  float a1, a2, dvFold;
  if (dvP < uStroke.z) {               // downstroke: quick, powerful (double smoothstep = sharp middle)
    float s = dvP / uStroke.z;
    float e = smoothstep(0.0, 1.0, smoothstep(0.0, 1.0, s));
    a1 = mix(uStroke.x, uStroke.y, e);
    a2 = 0.28 * sin(3.1416 * s);       // wing stretched, the tip lagging above the root
    dvFold = 0.0;
  } else {                             // upstroke: slower, outer panel folded down and swept back
    float s = (dvP - uStroke.z) / (1.0 - uStroke.z);
    a1 = mix(uStroke.y, uStroke.x, smoothstep(0.0, 1.0, s));
    dvFold = sin(3.1416 * s);
    a2 = -0.8 * dvFold;
  }
  // glide: blend into a shallow V over 0.12 s, back into the beat over the first 0.12 s of a burst
  float gl = dvGliding ? smoothstep(0.0, 0.12, dvTg) : 1.0 - smoothstep(0.0, 0.12, dvT);
  a1 = mix(a1, 0.21, gl); a2 = mix(a2, 0.06, gl); dvFold *= 1.0 - gl;
  if (aWing != 0.0) {
    float ax = abs(transformed.x);
    float r1 = clamp(ax - 0.05, 0.0, 0.4) * (1.0 - 0.12 * dvFold), r2 = max(ax - 0.45, 0.0);
    transformed.x = aWing * (0.05 + r1 * cos(a1) + r2 * cos(a1 + a2));
    transformed.y += r1 * sin(a1) + r2 * sin(a1 + a2);
    transformed.z -= 0.35 * dvFold * r2;
  }
  // body: up on each downstroke; climb over the burst, sink over the glide (continuous at both ends)
  float dvLift = -0.035 * cos(6.2832 * dvP) * (1.0 - gl)
    + uStroke.w * (dvGliding ? 0.5 * cos(3.1416 * dvTg / aFlap.w) : -0.5 * cos(3.1416 * dvT / dvBurst));
#ifdef DOVE_HALO
  transformed.x *= aWing != 0.0 ? 1.08 : 1.8;
  if (aWing == 0.0) transformed.y *= 1.7;
  transformed.z = (transformed.z + 0.04) * 1.3 - 0.04;
#endif
  transformed.y += dvLift;
}`;
function flapMaterial(mat, uTime, uStroke, halo) {
  if (halo) mat.defines = { DOVE_HALO: '' };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDoveTime = uTime;
    sh.uniforms.uStroke = uStroke;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + FLAP_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + FLAP_BODY);
  };
  mat.customProgramCacheKey = () => (halo ? 'doveHalo' : 'dove');
  return mat;
}

export function createDoves({ camera, groundAt = null, mood = null } = {}) {
  const P = mood?.preset || null, mname = mood?.name || '';
  const night = /night|moon/.test(mname), snow = mname === 'snow';
  const scene = new THREE.Scene();
  if (mood) scene.fog = new THREE.Fog(mood.uniforms.uHorizon.value.clone(), P.fogDist * 0.25, P.fogDist * 2.5);
  // light: tops ~white, underside soft grey (hemisphere ground colour); snow a bit lower so the facets show
  const LIGHT = night ? { hemi: 0.45, sun: 0.5, sky: 0xb8c8ff, ground: 0x30384c, halo: 0x2a3244 }
              : snow  ? { hemi: 1.6, sun: 0.9, sky: 0xffffff, ground: 0x8a92a2, halo: 0x6c7584 }
              :         { hemi: 2.0, sun: 1.3, sky: 0xffffff, ground: 0x9aa2b0, halo: 0x9ba2ad };
  scene.add(new THREE.HemisphereLight(LIGHT.sky, LIGHT.ground, LIGHT.hemi));
  const sun = new THREE.DirectionalLight(0xffffff, LIGHT.sun);
  const sd = mood?.uniforms?.uSunDir?.value;
  if (sd && sd.length() > 0.1) sun.position.copy(sd).normalize(); else sun.position.set(-0.5, 1, 0.3);
  scene.add(sun);

  const uTime = { value: 0 }, uStroke = { value: new THREE.Vector4() };
  const D2R = Math.PI / 180;
  function syncStroke() {   // opts -> uniform (live tuning; per frame while a flock is out)
    uStroke.value.set(DOVES.strokeUp * D2R, DOVES.strokeDown * D2R,
      Math.min(0.9, Math.max(0.1, DOVES.downShare)), DOVES.climb);
  }
  syncStroke();
  const geo = doveGeometry();
  const flap = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  geo.setAttribute('aFlap', flap);
  const birdMat = flapMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }), uTime, uStroke, false);
  const haloMat = flapMaterial(new THREE.MeshBasicMaterial({ color: LIGHT.halo, side: THREE.DoubleSide, depthWrite: false }), uTime, uStroke, true);
  const birds = new THREE.InstancedMesh(geo, birdMat, MAX);
  birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const halo = new THREE.InstancedMesh(geo, haloMat, MAX);
  halo.instanceMatrix = birds.instanceMatrix;   // same instances
  for (const m of [birds, halo]) { m.frustumCulled = false; m.count = 0; m.castShadow = m.receiveShadow = false; scene.add(m); }
  halo.renderOrder = 0; birds.renderOrder = 1;   // both opaque: outline first, the bird over it

  // ---- state (preallocated) ----
  let enabled = store.get(STORE_KEY) !== '0';
  let wait = rnd(DOVES.first[0], DOVES.first[1]);
  let flock = null;   // { n, t, len, speed } when out
  const S = new THREE.Vector3(), Cc = new THREE.Vector3(), E = new THREE.Vector3(), ACC = new THREE.Vector3();
  const along = new Float32Array(MAX), lat = new Float32Array(MAX), up = new Float32Array(MAX),
        k = new Float32Array(MAX), bobPh = new Float32Array(MAX), bobA = new Float32Array(MAX),
        wanA = new Float32Array(MAX), wanL = new Float32Array(MAX), wanW = new Float32Array(MAX);
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), mid = new THREE.Vector3(), ray = new THREE.Vector3();
  const pos = new THREE.Vector3(), tan = new THREE.Vector3(), ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
  const WUP = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), pv = new THREE.Matrix4(), frustum = new THREE.Frustum(), sphere = new THREE.Sphere();

  function ground(x, z, fallback) {
    const g = groundAt ? groundAt(x, z) : NaN;
    return Number.isFinite(g) ? g : fallback;
  }
  // quadratic Bezier S-Cc-E, extrapolated straight beyond both ends
  function bez(u, out, t) {
    const uc = Math.min(1, Math.max(0, u)), a = 1 - uc;
    out.set(0, 0, 0).addScaledVector(S, a * a).addScaledVector(Cc, 2 * a * uc).addScaledVector(E, uc * uc);
    t.copy(Cc).sub(S).multiplyScalar(2 * a).addScaledVector(v1.copy(E).sub(Cc), 2 * uc);   // dB/du
    if (u !== uc) out.addScaledVector(t, u - uc);
    return out;
  }

  function spawn(n) {
    camera.updateMatrixWorld();
    const cp = camera.position;
    const gy = ground(cp.x, cp.z, cp.y - 60);
    ray.set(0, rnd(DOVES.rayY[0], DOVES.rayY[1]), 0.5).unproject(camera).sub(cp).normalize();
    const hit = ray.y < -0.05 ? (cp.y - gy) / -ray.y : 200;
    const s = Math.min(DOVES.dist[1], Math.max(DOVES.dist[0], hit * rnd(0.35, 0.6)));
    mid.copy(cp).addScaledVector(ray, s);
    const lo = gy + DOVES.minAlt, hi = Math.max(lo, cp.y - 3);
    mid.y = Math.min(hi, Math.max(lo, mid.y));
    // across the view: camera right (horizontal), turned up to +-0.5 rad, either way
    const e = camera.matrixWorld.elements;
    v2.set(e[0], 0, e[2]); if (v2.lengthSq() < 1e-6) v2.set(1, 0, 0);
    v2.normalize().applyAxisAngle(WUP, rnd(-0.5, 0.5)).multiplyScalar(Math.random() < 0.5 ? 1 : -1);
    const hw = s * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    const half = (hw + 8) / Math.max(0.6, Math.abs(v2.dot(ax.set(e[0], 0, e[2]).normalize()))) + 6;
    S.copy(mid).addScaledVector(v2, -half); E.copy(mid).addScaledVector(v2, half);
    S.y += rnd(-3, 3); E.y += rnd(-3, 3);
    ax.crossVectors(WUP, v2).normalize();   // sideways
    Cc.copy(mid).addScaledVector(ax, rnd(-1, 1) * DOVES.curve * 2 * half); Cc.y += rnd(-2, 3);
    for (const p of [S, Cc, E]) p.y = Math.max(ground(p.x, p.z, gy) + DOVES.minAlt, p.y);
    ACC.copy(S).addScaledVector(Cc, -2).add(E).multiplyScalar(2);   // d2B/du2 (constant)
    // birds: leader + loose cluster behind it
    n = Math.max(1, Math.min(MAX, n | 0));
    const spread = 1.2 + 0.6 * n;
    let per0 = 1, off0 = 0, trail = 0;
    for (let i = 0; i < n; i++) {
      along[i] = i === 0 ? 0 : -rnd(1.5, 3 + 0.9 * n);
      trail = Math.min(trail, along[i]);
      lat[i] = i === 0 ? 0 : rnd(-spread, spread);
      up[i] = i === 0 ? 0 : rnd(-1.5, 1.5);
      k[i] = i === 0 ? 1 : rnd(0.985, 1.015);   // near-equal: over a 30 s crossing they drift < 4 m apart
      bobPh[i] = rnd(0, 6.283); bobA[i] = rnd(0.15, 0.4);
      wanA[i] = i === 0 ? 0 : rnd(0.5, 1.2); wanL[i] = i === 0 ? 0 : rnd(0.3, 0.8); wanW[i] = rnd(0.25, 0.5);
      // beat: own rate, whole beats per burst, own glide; followers off-phase to the leader
      const hz = rnd(DOVES.beatHz[0], DOVES.beatHz[1]);
      const beats = Math.max(3, Math.round(rnd(DOVES.burst[0], DOVES.burst[1]) * hz));
      const gl = Math.max(0.05, rnd(DOVES.glide[0], DOVES.glide[1]));
      const off = i === 0 ? rnd(0, 3) : off0 + per0 * rnd(0.3, 0.7);
      if (i === 0) { per0 = beats / hz + gl; off0 = off; }
      flap.setXYZW(i, off, hz, beats, gl);
    }
    flap.needsUpdate = true;
    const speed = rnd(DOVES.speed[0], DOVES.speed[1]);
    // own life: the slowest bird from its start (behind S) past E, + margin to clear the frustum;
    // place() normally ends the flock earlier (all past E and out of view)
    const life = Math.min(DOVES.maxLife, (2 * half - trail + 2) / (speed * 0.985) + 6);
    flock = { n, t: 0, len: 2 * half, speed, life };
    syncStroke();
    birds.count = halo.count = n;
    place();
    return true;
  }
  function end() { flock = null; birds.count = halo.count = 0; }

  // instance matrices; returns true while some bird is still on its way or in view
  function place() {
    const f = flock, sCam = DOVES.scale;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    sphere.radius = 1.2 * sCam;
    let busy = false;
    const du = f.speed / f.len;
    for (let i = 0; i < f.n; i++) {
      const wan = Math.sin(f.t * wanW[i] + bobPh[i]);   // follower drifts loosely along / sideways
      const u = (f.t * f.speed * k[i] + along[i] + wanA[i] * wan) / f.len;
      bez(u, pos, tan);
      az.copy(tan).normalize();
      ax.crossVectors(WUP, az); if (ax.lengthSq() < 1e-6) ax.set(1, 0, 0); ax.normalize();
      ay.crossVectors(az, ax);
      const bob = bobA[i] * Math.sin(f.t * 1.4 + bobPh[i]);
      pos.addScaledVector(ax, lat[i] + wanL[i] * Math.cos(f.t * wanW[i] * 0.8 + bobPh[i])).addScaledVector(WUP, up[i] + bob);
      // bank into the curve (lateral acceleration of the path) + a little wobble
      const aLat = u > 0 && u < 1 ? ACC.dot(ax) * du * du : 0;
      // x4: at dove speed the physical bank is ~1 deg; a few degrees read as "leaning into the turn"
      const r = Math.atan(4 * aLat / 9.81) + 0.06 * Math.sin(f.t * 1.0 + bobPh[i]);
      const c = Math.cos(r), sn = Math.sin(r);
      v1.copy(ax).multiplyScalar(c).addScaledVector(ay, -sn);   // x'
      ay.multiplyScalar(c).addScaledVector(ax, sn);              // y'
      m4.makeBasis(v1, ay, az).scale(sc.setScalar(sCam)).setPosition(pos);
      birds.setMatrixAt(i, m4);
      if (u < 1) busy = true;
      else if (!busy) { sphere.center.copy(pos); if (frustum.intersectsSphere(sphere)) busy = true; }
    }
    birds.instanceMatrix.needsUpdate = true;
    return busy;
  }

  // per frame (index.html frame(), after the balloon took the camera); under = car in a tunnel
  function update(dt, under = false) {
    if (under) { if (flock) end(); return; }
    if (!flock) {
      if (!enabled || night) return;
      if ((wait -= dt) > 0) return;
      wait = rnd(DOVES.every[0], DOVES.every[1]);
      spawn(DOVES.count);
      return;
    }
    flock.t += dt; uTime.value += dt;
    syncStroke();
    if (!place() || flock.t > flock.life) end();
  }
  function draw(renderer, cam) {
    if (!flock) return;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(scene, cam);
    renderer.autoClear = ac;
  }
  function setEnabled(v) {
    enabled = !!v; store.set(STORE_KEY, enabled ? '1' : '0');
    if (!enabled) end(); else wait = rnd(DOVES.first[0], DOVES.first[1]);
    return enabled;
  }
  // a pair right now (for trying it; n = other count). Also in the moon mood; in a tunnel the next update clears it.
  function release(n) {
    end();
    return spawn(n ?? DOVES.count);
  }
  return {
    update, draw, release, setEnabled, scene, opts: DOVES,
    get enabled() { return enabled; }, get active() { return !!flock; }, get count() { return flock ? flock.n : 0; },
    get next() { return flock ? 0 : wait; },   // s until the next flock (while none is out)
    get night() { return night; },
  };
}

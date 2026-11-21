// Edge of the map: a half-visible glass wall on the level border (level.json extent,
// where the Box2D border stops the car), a soft cushion in the last metres and a
// turn-around (U, berlinDrive.turnAround()). No on-screen hint (quiet game, README Rules).
//
// - Glass: one static strip per side (8 m columns, from 4 m under the height model
//   to 30 m over it), one shader. Visible only around the car (full within 40 m,
//   gone beyond 150 m, per fragment). Neutral milky white like a sheet of plexiglas:
//   an even, faint translucency, a little denser near the ground, fading out toward
//   the top; no pattern, no lines, nothing animated. Own scene, drawn after the car
//   (draw()), no depth writes: not a camera occluder (js/camcollide.js only takes
//   userData.world meshes of the main scene), does not touch the ghost silhouette,
//   not graded by the mood (only the HDR tone map of the mood's output applies).
// - info.hint (state only, nothing on screen): within 120 m heading for the edge; after 3 s
//   of pushing into the glass the car turns around by itself.
// - Cushion: in the last metres the speed toward the wall is capped to what a
//   gentle brake (CUSHION_DECEL) can still stop before it - per body (car + wheels),
//   only the wall-normal component; sliding along the glass stays free. Velocity
//   only, so the speed governor (js/vehicle.js) is not touched.
// - Turn-around: a breadcrumb trail of where the car drove (every 2 m, ~80 m).
//   U lifts the car (fixtures as sensors, like the jump), swings it round 180 deg
//   while gliding back ~20 m along that trail and sets it down there facing back the
//   way it came, rolling at ~11 km/h; then control returns. The trail is driven
//   ground, so no building, obstacle, water or pit; every candidate is still checked
//   (spotClear / isWater / isPit). Short trail: turn on the spot.
import * as THREE from 'three';

const NEAR_FULL = 40, NEAR_GONE = 150;          // glass fade around the car (m)
const HINT_DIST = 120;                           // info.hint when heading for the edge within this
const CUSHION_DECEL = 7;                         // m/s2: speed toward the wall <= sqrt(2 a d)
const CUSHION_GAP = 0.6;                         // m left between car corner and glass
const PUSH_AUTO = 3;                             // s pushing into the wall -> auto turn
const CRUMB = 2, TRAIL_LEN = 80;                 // trail spacing / length (m)
const BACK_MIN = 15, BACK_GOAL = 20, BACK_MAX = 25;
const TURN_T = 1.8, TURN_LIFT = 1.2, ROLL_OUT = 3;   // s, m, m/s
const WALL_HALF = 0.3;                           // index.html addWall half thickness
const SAMPLE = 8, BELOW = 4, ABOVE = 30;          // glass columns (m)
// plexiglas look (alpha): even body fading out from 1 m to 24 m over the ground, a denser
// band in the lowest 2.5 m (reads as a surface standing on the road), a little more at
// grazing view angles; colour neutral white. Live: berlinDrive.edgeModule.glass.material.uniforms
const GLASS = { color: 0xf2f4f6, body: 0.09, band: 0.09, grazing: 0.35, fadeFrom: 1, fadeTo: 24, bandH: 2.5 };

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const smooth = (a, b, x) => ease((x - a) / (b - a));

const VERT = /* glsl */`
attribute float aGround; attribute vec2 aNormal;
varying vec3 vW; varying float vH; varying vec2 vN;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vH = position.y - aGround; vN = aNormal;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */`
uniform vec2 uCar; uniform float uNearFull, uNearGone, uBody, uBand, uGrazing, uFadeFrom, uFadeTo, uBandH;
uniform vec3 uColor;
varying vec3 vW; varying float vH; varying vec2 vN;
void main() {
  float near = 1.0 - smoothstep(uNearFull, uNearGone, distance(vW.xz, uCar));
  if (near <= 0.0 || vH < -1.0) discard;
  float body = 1.0 - smoothstep(uFadeFrom, uFadeTo, vH);   // soft vertical gradient
  float band = 1.0 - smoothstep(0.0, uBandH, vH);          // denser near the ground
  vec3 v = normalize(cameraPosition - vW);
  float graze = 1.0 - abs(dot(v, vec3(vN.x, 0.0, vN.y)));   // plexi looks denser seen edge-on
  float a = (uBody * body + uBand * band) * (1.0 + uGrazing * graze) * near;
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 0.6));
}`;

// opts: { extent, groundAt(x, z), vehicle() -> Vehicle, busy() -> bool (sinking),
//         endJump(), spotClear(x, z, h), isWater(x, z), isPit(x, z) }
export function createEdge(opts) {
  const { extent: ex, groundAt } = opts;
  // inner faces of the Box2D border
  const X0 = ex.minX + WALL_HALF, X1 = ex.maxX - WALL_HALF, Z0 = ex.minZ + WALL_HALF, Z1 = ex.maxZ - WALL_HALF;
  // sides: start, end, inward normal (x, z)
  const sides = [
    { a: [X0, Z0], b: [X1, Z0], n: [0, 1] }, { a: [X1, Z0], b: [X1, Z1], n: [-1, 0] },
    { a: [X1, Z1], b: [X0, Z1], n: [0, -1] }, { a: [X0, Z1], b: [X0, Z0], n: [1, 0] },
  ];

  // ---- glass geometry ----
  const pos = [], gr = [], nm = [], idx = [];
  for (const s of sides) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), k = Math.max(1, Math.ceil(len / SAMPLE));
    const base = pos.length / 3;
    for (let i = 0; i <= k; i++) {
      const f = i / k, x = s.a[0] + (s.b[0] - s.a[0]) * f, z = s.a[1] + (s.b[1] - s.a[1]) * f;
      // lowest ground across the column's width: the glass never floats over a dip
      let g = Infinity;
      for (const o of [-SAMPLE / 2, 0, SAMPLE / 2]) {
        const t = Math.min(len, Math.max(0, f * len + o)) / len;
        g = Math.min(g, groundAt(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t));
      }
      pos.push(x, g - BELOW, z, x, g + ABOVE, z);
      gr.push(g, g); nm.push(...s.n, ...s.n);
      if (i < k) { const v = base + 2 * i; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aGround', new THREE.Float32BufferAttribute(gr, 1));
  geo.setAttribute('aNormal', new THREE.Float32BufferAttribute(nm, 2));
  geo.setIndex(idx);
  const uniforms = {
    uCar: { value: new THREE.Vector2() }, uNearFull: { value: NEAR_FULL }, uNearGone: { value: NEAR_GONE },
    uColor: { value: new THREE.Color(GLASS.color) }, uBody: { value: GLASS.body }, uBand: { value: GLASS.band },
    uGrazing: { value: GLASS.grazing }, uFadeFrom: { value: GLASS.fadeFrom }, uFadeTo: { value: GLASS.fadeTo }, uBandH: { value: GLASS.bandH },
  };
  const glass = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, fog: false, toneMapped: false,
  }));
  glass.frustumCulled = false; glass.name = 'edgeGlass';
  const scene = new THREE.Scene(); scene.add(glass);

  // ---- state ----
  const trail = [];   // [{x, z}] oldest -> newest
  let turn = null, lift = 0, pushT = 0, idleT = 0, lastVeh = null;
  const info = { dist: Infinity, gap: Infinity, side: -1, toward: 0, opacity: 0, hint: false, pushT: 0, turning: false, trail: 0 };

  // nearest side: signed distance of the car centre to each inner face
  function nearest(x, z) {
    const d = [z - Z0, X1 - x, Z1 - z, x - X0];
    let k = 0; for (let i = 1; i < 4; i++) if (d[i] < d[k]) k = i;
    return { d, k };
  }
  // distance of the car's nearest corner to side k's face (car half-extents along the normal)
  function gapTo(veh, k, dCentre) {
    const h = veh.getHeading(), fx = Math.sin(h), fz = -Math.cos(h), n = sides[k].n;
    const c = Math.abs(fx * n[0] + fz * n[1]), s = Math.sqrt(Math.max(0, 1 - c * c));
    return dCentre - (c * veh.spec.bodyLength + s * veh.spec.bodyWidth) / 2;
  }
  const bodies = (veh) => [veh.body, ...veh.wheels.map((w) => w.body)];
  const trailLen = () => { let s = 0; for (let i = 1; i < trail.length; i++) s += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].z - trail[i - 1].z); return s; };

  function pickTarget(veh) {
    const p = veh.getPosition(), h = veh.getHeading();
    const pts = [{ x: p.x, z: p.y }, ...trail.slice().reverse()];   // car -> back in time
    const ok = (x, z, hd) => !opts.isWater(x, z) && !opts.isPit(x, z) && opts.spotClear(x, z, hd);
    let s = 0, best = null;
    for (let i = 1; i < pts.length; i++) {
      s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      if (s < 6) continue;
      // facing back the way the car came: from this crumb toward the older one (or away from the newer)
      const o = pts[i + 1] || null, a = pts[i];
      const dx = o ? o.x - a.x : a.x - pts[i - 1].x, dz = o ? o.z - a.z : a.z - pts[i - 1].z;
      const hd = Math.atan2(dx, -dz);
      const { d, k } = nearest(a.x, a.z);
      const score = Math.abs(s - BACK_GOAL) + (s < BACK_MIN || s > BACK_MAX ? 30 : 0) + (d[k] < 12 ? 20 : 0);
      if ((!best || score < best.score) && ok(a.x, a.z, hd)) best = { x: a.x, z: a.z, h: hd, score, path: pts.slice(0, i + 1) };
      if (s > BACK_MAX + 10) break;
    }
    if (best) return best;
    // short trail (just spawned / teleported): turn on the spot, or a few metres back
    for (const back of [0, 3, 6, 9]) {
      const x = p.x - Math.sin(h) * back, z = p.y + Math.cos(h) * back;
      if (ok(x, z, h + Math.PI)) return { x, z, h: wrap(h + Math.PI), path: [{ x: p.x, z: p.y }, { x, z }] };
    }
    return { x: p.x, z: p.y, h: wrap(h + Math.PI), path: [{ x: p.x, z: p.y }] };
  }

  function turnAround() {
    const veh = opts.vehicle();
    if (turn || !veh || opts.busy()) return false;
    opts.endJump();
    const t = pickTarget(veh), h0 = veh.getHeading();
    let dh = wrap(t.h - h0);
    if (Math.abs(dh) > Math.PI - 0.15) dh = (veh.steering?.lever || 0) < 0 ? -Math.abs(dh) : Math.abs(dh);   // a straight 180: swing left unless steering left
    const cum = [0];
    for (let i = 1; i < t.path.length; i++) cum.push(cum[i - 1] + Math.hypot(t.path[i].x - t.path[i - 1].x, t.path[i].z - t.path[i - 1].z));
    veh.setAirborne(true);
    turn = { t: 0, veh, h0, dh, path: t.path, cum, len: cum[cum.length - 1], target: t };
    info.turning = true;
    return true;
  }
  function poseAt(u) {
    const T = turn, s = ease(u) * T.len;
    let i = 1; while (i < T.cum.length - 1 && T.cum[i] < s) i++;
    if (T.path.length < 2) return { x: T.path[0].x, z: T.path[0].z };
    const a = T.path[i - 1], b = T.path[i], seg = T.cum[i] - T.cum[i - 1], f = seg > 1e-6 ? (s - T.cum[i - 1]) / seg : 1;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  }
  function endTurn(done) {
    const T = turn; turn = null; lift = 0; info.turning = false;
    if (T.veh !== opts.vehicle()) return;   // car / bus swapped mid-turn
    T.veh.setAirborne(false);
    if (!done) return;
    const { x, z, h } = T.target;
    T.veh.reset(x, z, h);
    const vx = Math.sin(h) * ROLL_OUT, vz = -Math.cos(h) * ROLL_OUT;
    for (const b of bodies(T.veh)) b.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(vx, vz));   // Box2D: global (Box2D.js)
    T.veh.brakeLock = false; T.veh.prevVel = { x: vx, y: vz };
    // the glided-over stretch is now behind the car: it is the new trail (U again = back again)
    trail.length = 0; trail.push(...T.path);
    pushT = 0;
  }

  // physics step (after world.Step): turn animation, cushion, trail, push timer
  function step(dt) {
    const veh = opts.vehicle();
    if (!veh) return;
    if (veh !== lastVeh) { trail.length = 0; lastVeh = veh; }
    if (turn) {
      if (turn.veh !== veh || opts.busy()) { endTurn(false); return; }
      turn.t += dt;
      const u = Math.min(1, turn.t / TURN_T);
      if (u >= 1) { endTurn(true); return; }
      const p = poseAt(u);
      veh.reset(p.x, p.z, turn.h0 + turn.dh * ease(u));
      lift = TURN_LIFT * Math.sin(Math.PI * u);
      return;
    }
    const p = veh.getPosition(), { d, k } = nearest(p.x, p.y);
    // cushion: per side within reach, cap the outward speed
    let pushing = false;
    for (let i = 0; i < 4; i++) {
      if (d[i] > 60) continue;
      const gap = gapTo(veh, i, d[i]), vmax = Math.sqrt(2 * CUSHION_DECEL * Math.max(0, gap - CUSHION_GAP));
      const nx = -sides[i].n[0], nz = -sides[i].n[1];   // outward
      for (const b of bodies(veh)) {
        const v = b.GetLinearVelocity(), vn = v.x * nx + v.y * nz;
        if (vn > vmax) {
          const cut = vn - vmax; v.x -= cut * nx; v.y -= cut * nz; b.SetLinearVelocity(v);
          if (b === veh.body && gap < 3 && cut > 0.02) pushing = true;
        }
      }
    }
    const gap = gapTo(veh, k, d[k]);
    info.dist = d[k]; info.gap = gap; info.side = k;   // also between frames (berlinDrive.steps)
    if (pushing) { pushT += dt; idleT = 0; } else if ((idleT += dt) > 0.3) pushT = 0;
    if (pushT >= PUSH_AUTO) { pushT = 0; turnAround(); return; }
    // trail
    if (!opts.busy() && !veh.airborne) {
      const l = trail[trail.length - 1];
      const dl = l ? Math.hypot(p.x - l.x, p.y - l.z) : Infinity;
      if (l && dl > 15) trail.length = 0;   // teleport / respawn / restart: a new trail
      if (!l || dl > 15 || dl >= CRUMB) {
        trail.push({ x: p.x, z: p.y });
        while (trail.length > TRAIL_LEN / CRUMB + 2) trail.shift();
      }
    }
  }

  // per frame, before the glass is drawn: car position uniform, info
  function frame() {
    const veh = opts.vehicle();
    if (!veh) return;
    const p = veh.getPosition(), { d, k } = nearest(p.x, p.y), n = sides[k].n, h = veh.getHeading();
    const toward = -(Math.sin(h) * n[0] - Math.cos(h) * n[1]);   // heading . outward normal
    const gap = gapTo(veh, k, d[k]);
    uniforms.uCar.value.set(p.x, p.y);
    // hysteresis (on at 0.35 / 120 m / 8 m, off at 0.15 / 135 m / 11 m): no on-off flicker at the threshold
    const was = info.hint, m = was ? 1 : 0;
    const hint = !turn && !opts.busy() && (d[k] < HINT_DIST + 15 * m && toward > 0.35 - 0.2 * m || gap < 8 + 3 * m);
    Object.assign(info, { dist: d[k], gap, side: k, toward, hint, pushT, trail: trailLen(),
                          opacity: 1 - smooth(NEAR_FULL, NEAR_GONE, Math.max(0, d[k])) });
  }

  return {
    scene, glass, trail, info, turnAround, step, frame,
    get lift() { return lift; }, get turning() { return !!turn; },
    draw(renderer, camera) {   // after the car pass (autoClear off)
      frame();
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = ac;
    },
  };
}

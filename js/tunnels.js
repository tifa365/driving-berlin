// Drivable road tunnels (Tunnel Tiergarten Spreebogen, Tunnel Alexanderplatz). The city
// mesh only shows the open ramps down to the portals; there is no tunnel interior in it.
// Before this module the car just kept going under the surface at the last road height
// (js/ground.js "carry on"), unguided, and drowned where it passed under the Spree.
//
// Data: levels/<name>/tunnels.json from build_tunnels.py: per tube (one bore) the centre
// lines (OSM tunnel ways + the open ramps), half width, roadway height (mesh ramp, then a
// smooth synthetic profile: <= 5 % grades, 7 m under the street, 10.5 m under rivers),
// portal faces (where the mesh closes over the road) and corridor wall segments.
//
// States:
//   guided - the car is on a deep part of an open ramp (walls there: >= 1 m below the
//            street) or in the tunnel: the corridor walls (one static Box2D body, SOLID
//            material, own collision category) are active. Height still from the mesh.
//   active - "tunnel mode": entered by driving through a portal face inward (direction
//            sensitive, a line across the carriageway), left by driving out through any
//            face of the same tube. The roadway profile replaces the mesh under the car
//            (carGround override), the car's fixtures only collide with the tunnel walls
//            (filter mask: no buildings, clutter, ball, bears, balloon platform from the
//            surface), the car centre is clamped into the corridor (jumps: fixtures are
//            sensors in the air), and index.html skips water / pit / no-drive / hop-out /
//            camera avoidance / safe poses / tyre tracks.
// Shown: the camera stays as on the street; the car under the ground is the usual ghost
// silhouette, and the tube is drawn the same way - a see-through outline (floor and
// ceiling edges, a faint centre dash, cross ribs every 8 m, portal frames) on top of the
// world, no depth test, ghost colour, static, not mood-graded. Visible only in a tunnel
// or within ~80 m of a portal, and only within ~300 m of the car.
// No level without tunnels.json does anything (createTunnels(null) is an inert stub).
import * as THREE from 'three';

export async function loadTunnels(base) {
  try {
    const r = await fetch(base + 'tunnels.json');
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const CELL = 20, REACH = 25;      // projection grid (m), farthest distance from a centre line
const TUN_BIT = 0x4000;           // Box2D collision category of the tunnel walls
const WALL_HALF = 0.3;            // as index.html addWall
const CLAMP_M = 1.0;              // m: the car centre stays this far inside the corridor edge
const GUIDE_DEPTH = 1.2;          // m below the street: the ramp walls take over (builder: 1.0)
const NEAR_Y = 3;                 // m: the car must be this close to the roadway profile to enter / be guided
const PORTAL_NEAR = 30;           // m: face crossings are tested within this
// outline look (alpha x the ghost's opacity), widths in m; fade with distance from the car
// owner 2026-11-21: "a little bit denser, it's hard to see" -> ribs every 8 m (was 20), stronger and wider lines
const LOOK = { floor: 1.0, ceil: 0.8, centre: 0.6, rib: 0.7, portal: 1.0,
               wFloor: 0.45, wCeil: 0.32, wCentre: 0.25, wRib: 0.28, wPortal: 0.45,
               ribEvery: 8, dashOn: 4, dashOff: 4, nearFull: 150, nearGone: 300, showNear: 80, fadeS: 0.6,
               veil: 0.5, veilS: 0.8 };   // surface dimming in tunnel mode (0 = off) and its fade time (s)
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

const VERT = /* glsl */`
attribute float aA;
varying float vA; varying vec2 vXZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vA = aA; vXZ = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = /* glsl */`
uniform vec2 uCar; uniform float uFade, uOpacity, uNearFull, uNearGone; uniform vec3 uColor;
varying float vA; varying vec2 vXZ;
void main() {
  float a = uOpacity * uFade * vA * (1.0 - smoothstep(uNearFull, uNearGone, distance(vXZ, uCar)));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

// opts: { data, world, vehicle() -> Vehicle, edge (js/edge.js: trail restarted on enter / exit),
//         carY() -> the car's road height (index.html), place(x, z, h) (teleport, test hook), ghostMat (colour + opacity of the outline follow the car's ghost) }
export function createTunnels({ data, world, vehicle, carY = () => null, place = null, edge = null, ghostMat = null }) {
  const off = () => false;
  if (!data || !data.tubes?.length) {
    return { data: null, active: false, guided: false, routes: [], items: () => [], ground: () => null,
             step() {}, frame() {}, draw() {}, setActive() {}, resume: off, heightAt: () => null, project: () => null,
             enter: off, exit: off };
  }
  const tubes = data.tubes;
  // ---- projection grid over all edge segments ----
  const grid = new Map(), key = (i, j) => i * 100003 + j;
  tubes.forEach((T, t) => T.edges.forEach((E, e) => {
    for (let k = 0; k + 1 < E.x.length; k++) {
      const i0 = Math.floor((Math.min(E.x[k], E.x[k + 1]) - REACH) / CELL), i1 = Math.floor((Math.max(E.x[k], E.x[k + 1]) + REACH) / CELL);
      const j0 = Math.floor((Math.min(E.z[k], E.z[k + 1]) - REACH) / CELL), j1 = Math.floor((Math.max(E.z[k], E.z[k + 1]) + REACH) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = key(i, j); let l = grid.get(c); if (!l) grid.set(c, (l = [])); l.push(t, e, k);
      }
    }
  }));
  const q = { t: 0, e: 0, k: 0, u: 0, dist: 0, px: 0, pz: 0, y: 0, hw: 0, st: 0, under: false };
  // nearest centre-line point (of tube `only`, or any tube; with yRef only segments within
  // NEAR_Y of that height: an open ramp of the same tube may cross over the bore) -> q (shared) or null beyond REACH
  function project(x, z, only = -1, yRef = null) {
    const l = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return null;
    let best = Infinity, bt = -1, be = 0, bk = 0, bu = 0;
    for (let n = 0; n < l.length; n += 3) {
      const t = l[n]; if (only >= 0 && t !== only) continue;
      const E = tubes[t].edges[l[n + 1]], k = l[n + 2];
      if (yRef != null && Math.abs(E.y[k] - yRef) > NEAR_Y && Math.abs(E.y[k + 1] - yRef) > NEAR_Y) continue;
      const ax = E.x[k], az = E.z[k], dx = E.x[k + 1] - ax, dz = E.z[k + 1] - az, L2 = dx * dx + dz * dz;
      let u = L2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + u * dx - x, ez = az + u * dz - z, d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bt = t; be = l[n + 1]; bk = k; bu = u; }
    }
    if (bt < 0 || best > REACH * REACH) return null;
    const E = tubes[bt].edges[be], k = bk, u = bu, L = (a) => a[k] + (a[k + 1] - a[k]) * u;
    Object.assign(q, { t: bt, e: be, k, u, dist: Math.sqrt(best), px: L(E.x), pz: L(E.z), y: L(E.y), hw: L(E.hw), st: L(E.st),
                       under: !!(u < 0.5 ? E.u[k] : E.u[k + 1]) });
    return q;
  }

  // height-preferring projection; without a segment near that height (teleport: carY not updated yet) the plain nearest
  const projectNear = (x, z, only, y) => (y != null && project(x, z, only, y)) || project(x, z, only);

  // ---- portals ----
  const portals = [];
  tubes.forEach((T, t) => T.portals.forEach((p) => portals.push({ ...p, t, tube: T.name })));
  const lastSide = new Map();

  // ---- walls: one static body, active while guided ----
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  const body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
  const filt = new Box2D.Dynamics.b2FilterData(); filt.categoryBits = TUN_BIT; filt.maskBits = 0xffff;
  let nWalls = 0;
  for (const T of tubes) {
    const W = T.walls;
    for (let o = 0; o + 6 < W.length; o += 7) {
      const x0 = W[o], z0 = W[o + 1], x1 = W[o + 3], z1 = W[o + 4], len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      const s = new Box2D.Collision.Shapes.b2PolygonShape();
      s.SetAsOrientedBox(len / 2 + WALL_HALF, WALL_HALF, new b2Vec2((x0 + x1) / 2, (z0 + z1) / 2), Math.atan2(z1 - z0, x1 - x0));
      const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = s;
      fd.friction = 0.35; fd.restitution = 0;   // js/vehicle.js SOLID
      fd.filter = filt;
      body.CreateFixture(fd); nWalls++;
    }
  }
  body.SetActive(false);

  let active = false, guided = false, cur = -1, maskOn = null, maskVeh = null;
  // the car's fixtures: only the tunnel walls while active (nothing from the surface above)
  function applyMask(v) {
    const on = active;
    if (maskOn === on && maskVeh === v) return;
    maskOn = on; maskVeh = v;
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) {
      for (let f = b.GetFixtureList(); f; f = f.GetNext()) {
        const fd = f.GetFilterData(); fd.maskBits = on ? TUN_BIT : 0xffff; f.SetFilterData(fd);
      }
      for (let c = b.GetContactList(); c; c = c.next) c.contact.FlagForFiltering();   // Box2D.js skips this in SetFilterData
    }
  }
  function setGuided(on) {
    if (on === guided) return;
    guided = on; body.SetActive(on);
  }
  function setActive(on, t = cur) {
    on = !!on;
    if (on === active && (!on || t === cur)) return;
    active = on; cur = on ? t : -1;
    if (edge?.trail) edge.trail.length = 0;   // U must not glide back across the face / onto the street
    const v = vehicle(); if (v) applyMask(v);
    if (on) setGuided(true);
  }

  // ---- per physics step (after world.Step): portals, guidance, clamp ----
  function step() {
    const v = vehicle(); if (!v) return;
    applyMask(v);
    const c = v.body.GetWorldCenter(), x = c.x, z = c.y, cy = carY();
    const nearY = (y, tol = NEAR_Y) => cy == null || Math.abs(cy - y) < tol;   // on the roadway, not on the street above
    // face crossings (direction sensitive): inward -> on, outward through a face of this tube -> off
    for (const p of portals) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz > PORTAL_NEAR * PORTAL_NEAR) { lastSide.delete(p); continue; }
      const side = dx * p.nx + dz * p.nz, lat = Math.abs(dx * p.nz - dz * p.nx), prev = lastSide.get(p);
      lastSide.set(p, side);
      if (prev === undefined) continue;
      if (!active && prev < 0 && side >= 0 && lat < p.hw + 0.5 && nearY(p.y)) setActive(true, p.t);
      else if (active && p.t === cur && prev >= -1 && side < -1 && lat < p.hw + 2) setActive(false);
    }
    let P = projectNear(x, z, active ? cur : -1, cy);
    if (active && (!P || P.dist > P.hw + 4)) { setActive(false); P = projectNear(x, z, -1, cy); }   // lost (should not happen)
    // guided only on the OPEN ramp (never over the underground part: a car on the street above a tube is
    // never touched), and only with the car down on the ramp (tolerance half the ramp depth, <= 3 m)
    setGuided(active || !!(P && !P.under && P.dist < P.hw - 0.3 && P.st - P.y >= GUIDE_DEPTH
                                && nearY(P.y, Math.min(NEAR_Y, 0.5 * (P.st - P.y)))));
    if (!active || !P) return;
    // clamp the car centre into the corridor (the walls keep the body in; jumps: sensors)
    const lim = Math.max(0.2, P.hw - CLAMP_M);
    if (P.dist <= lim) return;
    const nx = (P.px - x) / P.dist, nz = (P.pz - z) / P.dist, push = P.dist - lim;
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) {
      const o = b.GetPosition();
      b.SetPosition(new b2Vec2(o.x + nx * push, o.y + nz * push));
      const lv = b.GetLinearVelocity(), vn = lv.x * nx + lv.y * nz;
      if (vn < 0) b.SetLinearVelocity(new b2Vec2(lv.x - vn * nx, lv.y - vn * nz));
    }
  }
  // roadway height in tunnel mode (carGround override / fallback), else null
  function heightAt(x, z) {
    const P = projectNear(x, z, cur, carY());
    return P ? P.y : null;
  }

  // ---- outline: ribbons (quads) with a per-vertex strength, one mesh ----
  const pos = [], aA = [], idx = [];
  const CEIL = data.ceiling || 5;
  function quad(p0, p1, p2, p3, a) {
    const b = pos.length / 3;
    pos.push(...p0, ...p1, ...p2, ...p3); aA.push(a, a, a, a);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // flat ribbon along (x0, y0, z0) -> (x1, y1, z1), width w
  function hRib(x0, y0, z0, x1, y1, z1, w, a) {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz); if (l < 1e-4) return;
    const ox = -dz / l * w / 2, oz = dx / l * w / 2;
    quad([x0 + ox, y0, z0 + oz], [x1 + ox, y1, z1 + oz], [x1 - ox, y1, z1 - oz], [x0 - ox, y0, z0 - oz], a);
  }
  // upright post at (x, z) from y0 to y1, width w along (ux, uz)
  function vRib(x, z, y0, y1, ux, uz, w, a) {
    const ox = ux * w / 2, oz = uz * w / 2;
    quad([x - ox, y0, z - oz], [x + ox, y0, z + oz], [x + ox, y1, z + oz], [x - ox, y1, z - oz], a);
  }
  // cross-section frame at centre (x, z), roadway y, left normal (nx, nz), half width hw
  function frameAt(x, z, y, nx, nz, hw, w, a) {
    const lx = x + nx * hw, lz = z + nz * hw, rx = x - nx * hw, rz = z - nz * hw;
    hRib(lx, y + 0.05, lz, rx, y + 0.05, rz, w, a);
    hRib(lx, y + CEIL, lz, rx, y + CEIL, rz, w, a);
    vRib(lx, lz, y, y + CEIL, nx, nz, w, a); vRib(rx, rz, y, y + CEIL, nx, nz, w, a);
  }
  for (const T of tubes) {
    const W = T.walls;
    for (let o = 0; o + 6 < W.length; o += 7) {
      if (!W[o + 6]) continue;   // open ramp: the mesh shows it
      hRib(W[o], W[o + 2] + 0.05, W[o + 1], W[o + 3], W[o + 5] + 0.05, W[o + 4], LOOK.wFloor, LOOK.floor);
      hRib(W[o], W[o + 2] + CEIL, W[o + 1], W[o + 3], W[o + 5] + CEIL, W[o + 4], LOOK.wCeil, LOOK.ceil);
    }
    for (const E of T.edges) {
      let s = 0;
      for (let k = 0; k + 1 < E.x.length; k++) {
        const dx = E.x[k + 1] - E.x[k], dz = E.z[k + 1] - E.z[k], l = Math.hypot(dx, dz);
        if (E.u[k] && E.u[k + 1]) {
          // centre dash
          const ph = s % (LOOK.dashOn + LOOK.dashOff);
          if (ph < LOOK.dashOn) hRib(E.x[k], E.y[k] + 0.05, E.z[k], E.x[k + 1], E.y[k + 1] + 0.05, E.z[k + 1], LOOK.wCentre, LOOK.centre);
          // rib where s passes a multiple of ribEvery
          if (Math.floor((s + l) / LOOK.ribEvery) > Math.floor(s / LOOK.ribEvery) && l > 1e-3)
            frameAt(E.x[k + 1], E.z[k + 1], E.y[k + 1], -dz / l, dx / l, E.hw[k + 1], LOOK.wRib, LOOK.rib);
        }
        s += l;
      }
    }
    for (const p of T.portals) frameAt(p.x, p.z, p.y, -p.nz, p.nx, p.hw, LOOK.wPortal, LOOK.portal);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aA', new THREE.Float32BufferAttribute(aA, 1));
  geo.setIndex(idx);
  const uniforms = { uCar: { value: new THREE.Vector2() }, uFade: { value: 0 }, uOpacity: { value: 0.45 },
                     uNearFull: { value: LOOK.nearFull }, uNearGone: { value: LOOK.nearGone }, uColor: { value: new THREE.Color(0xffffff) } };
  const outline = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    side: THREE.DoubleSide, fog: false, toneMapped: false }));
  outline.frustumCulled = false; outline.name = 'tunnelOutline'; outline.renderOrder = 5;
  const scene = new THREE.Scene(); scene.add(outline);
  // veil (owner 2026-11-21: "make the real surface more transparent when driving through a tunnel"): the mesh
  // cannot be made see-through (nothing lies under it), so in tunnel mode the surface is dimmed with a dark
  // screen-filling veil drawn before the outline; the tube lines and the car's ghost then stand out on top of it
  const veilU = { uA: { value: 0 } };
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: veilU, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform float uA; void main() { gl_FragColor = vec4(0.03, 0.045, 0.06, uA); }' }));
  veil.frustumCulled = false; veil.renderOrder = 1; veil.name = 'tunnelVeil'; scene.add(veil);
  let veilK = 0;
  // a tube cut before the level border: plain milky glass across it (as js/edge.js, static)
  for (const T of tubes) for (const en of T.ends || []) {
    const g = new THREE.PlaneGeometry(2 * en.hw, CEIL);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf2f4f6, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(en.x, en.y + CEIL / 2, en.z); m.rotation.y = Math.atan2(en.nx, en.nz);   // plane normal along the tube
    scene.add(m);
  }

  // ---- per render frame: fade ----
  let fade = 0, last = performance.now();
  function frame(x, z) {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    let near = Infinity;
    for (const p of portals) near = Math.min(near, Math.hypot(x - p.x, z - p.z));
    const want = active || guided ? 1 : 1 - ease((near - LOOK.showNear * 0.6) / (LOOK.showNear * 0.4));
    fade += Math.sign(want - fade) * Math.min(Math.abs(want - fade), dt / LOOK.fadeS);
    uniforms.uCar.value.set(x, z);
    uniforms.uFade.value = ease(fade);
    veilK += Math.sign((active ? 1 : 0) - veilK) * Math.min(Math.abs((active ? 1 : 0) - veilK), dt / LOOK.veilS);
    veilU.uA.value = LOOK.veil * ease(veilK); veil.visible = veilK > 0.01;
    if (ghostMat) { uniforms.uColor.value.copy(ghostMat.color); uniforms.uOpacity.value = ghostMat.opacity; }
  }

  const items = () => portals.map((p) => ({ id: p.id, kind: 'tunnel-portal', name: `${p.tube} - ${p.name}`, lat: p.lat, lon: p.lon, x: p.x, z: p.z }));
  const routes = tubes.map((T) => ({ id: T.id, name: T.name, lines: T.edges.map((E) => E.x.map((x, i) => [x, E.z[i], E.u[i]])) }));
  return {
    data, routes, items, step, frame, setActive, project: (x, z) => { const p = project(x, z); return p && { ...p }; },
    heightAt: (x, z) => (active ? heightAt(x, z) : null),
    ground: (x, z) => (active ? heightAt(x, z) : null),   // carGround groundAt in tunnel mode
    get active() { return active; }, get guided() { return guided; }, get tube() { return cur >= 0 ? tubes[cur].name : null; },
    get fade() { return fade; }, stats: () => ({ walls: nWalls, portals: portals.length, tubes: tubes.length, active, guided, fade }),
    draw(renderer, camera) {   // after the world (autoClear off): outline over everything, no depth
      if (fade <= 0.01) return;
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = ac;
    },
    // mood switch reload: back in tunnel mode if the stored position is underground in a tube
    resume(x, z) {
      const P = project(x, z);
      if (P && P.under && P.dist < P.hw) { setActive(true, P.t); return true; }
      return false;
    },
    // test hook: enter(portal id | name | index) puts the car 15 m inside that face, heading in
    enter(which = 0) {
      const p = typeof which === 'string' ? portals.find((q) => q.id === which || q.name === which) : portals[which];
      if (!p || !place) return false;
      place(p.x + p.nx * 15, p.z + p.nz * 15, Math.atan2(p.nx, -p.nz));
      setActive(true, p.t); return true;
    },
    portals: () => portals.map((p) => ({ ...p })),
  };
}

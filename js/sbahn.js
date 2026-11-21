// Easter egg: the Stadtbahn. At every station of the route a door (data.entrances: Jannowitzbruecke
// in the viaduct, Alexanderplatz, Hackescher Markt, Friedrichstrasse, Hauptbahnhof; each on the side
// with the clear straight approach, build_sbahn.py door_sides), marked only by a steady green column
// of light standing on the spot to drive into (js/liftpad.js makeLiftBeacon; no lettering). Drive in: the car rolls on by itself into the station
// until it is gone, a short black blink, and it is on the open deck beside the tracks at that station
// (data.lifts[i].deck, build_sbahn.py lift_pads; the lift slabs themselves are gone), rolling at
// 30 km/h toward the longer ride, in rails mode (index.html sinking.kind 'sbahn', target.noBear).
// On the tracks that deck spot is the station's stop (a shorter green light): drive into
// it, blink, and the car rolls out of the station's street door at walking pace (kind 'sbahnOut');
// the door waits until the car is 8 m away, the deck stop likewise. Old data without `lifts`: the
// old bear sequences.
// Both route ends (buffer stop strips): the Rescue Bear carries the car down (kind 'sbahnOut').
// "Runter von den Gleisen" (button #sbahnOff bottom centre, key G; only on the tracks, not
// during a scene): anywhere on the route the bear picks the car up where it stands and carries it
// to the nearest of data.bailouts (street spots checked offline).
// "Tiefgarage" (data.portal, a spatial joke): drive into the underground-garage ramp on Am
// Friedrichshain (a line across the driveway at the entrance node, inward only): the game takes
// over like at a station door (kind 'sbahn', the garage as a door), the car rolls on 10 m down the
// driveway axis, sinking down the ramp until it is gone (camera on the mouth), a short fade to
// black, and it is on the open deck just east of the Friedrichstrasse hall, rolling east at the
// speed it had (vmin..vmax). No bear (target.noBear). No on-screen text in this module (owner: a
// quiet game); the only UI is the #sbahnOff button.
//
// Data: levels/<name>/sbahn.json from build_sbahn.py (route = reference S-Bahn track every
// `step` m, left normal, corridor [left, right] offsets, deck height, roofs bridged).
// Rails mode:
//   - height: carGround asks `ground(x, z)` = the deck profile instead of the street height
//     model (fallback + (re)acquire); the mesh probes then only ever look at the band
//     around the track bed, so station roofs (bridged in the profile) are never hit;
//   - corridor: a closed loop of Box2D boxes (active only in rails mode) + a position
//     clamp on the car centre (jumps: fixtures are sensors in the air);
//   - water rescue / ice are off (index.html guards), the edge trail is restarted.
// No level without sbahn.json does anything (createSbahn(null) is an inert stub).
import * as THREE from 'three';
import { makeLiftBeacon } from './liftpad.js';   // the green light column (js/roofs.js uses it in white)

export async function loadSbahn(base) {
  try {
    const r = await fetch(base + 'sbahn.json');
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const CELL = 20, REACH = 34;   // projection grid (m), farthest lateral distance from the reference track
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a, b, u) => a + (b - a) * u;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// route geometry: projection (s, lateral offset), deck height, corridor test
export function makeRoute(d) {
  const n = d.x.length, X = d.x, Z = d.z, NX = d.nx, NZ = d.nz;
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let k = 0; k + 1 < n; k++) {
    const i0 = Math.floor((Math.min(X[k], X[k + 1]) - REACH) / CELL), i1 = Math.floor((Math.max(X[k], X[k + 1]) + REACH) / CELL);
    const j0 = Math.floor((Math.min(Z[k], Z[k + 1]) - REACH) / CELL), j1 = Math.floor((Math.max(Z[k], Z[k + 1]) + REACH) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const c = key(i, j); let l = grid.get(c); if (!l) grid.set(c, (l = [])); l.push(k);
    }
  }
  const q = { k: 0, u: 0, s: 0, d: 0, a: 0, dist: 0 };
  // nearest point on the route -> q (shared object) or null beyond REACH
  function project(x, z) {
    const l = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return null;
    let best = Infinity, bk = -1, bu = 0;
    for (const k of l) {
      const ax = X[k], az = Z[k], dx = X[k + 1] - ax, dz = Z[k + 1] - az, L2 = dx * dx + dz * dz;
      let u = ((x - ax) * dx + (z - az) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + u * dx - x, ez = az + u * dz - z, e = ex * ex + ez * ez;
      if (e < best) { best = e; bk = k; bu = u; }
    }
    if (bk < 0 || best > REACH * REACH) return null;
    const nx = lerp(NX[bk], NX[bk + 1], bu), nz = lerp(NZ[bk], NZ[bk + 1], bu);
    const px = lerp(X[bk], X[bk + 1], bu), pz = lerp(Z[bk], Z[bk + 1], bu);
    q.k = bk; q.u = bu; q.s = (bk + bu) * d.step; q.dist = Math.sqrt(best);
    q.d = (x - px) * nx + (z - pz) * nz;
    q.a = (x - px) * nz - (z - pz) * nx;   // along the route (tangent = (nz, -nx)), != 0 only beyond the ends
    return q;
  }
  const at = (arr, p) => lerp(arr[p.k], arr[p.k + 1], p.u);
  const deckAt = (x, z) => { const p = project(x, z); return p ? at(d.deck, p) : null; };
  // inside the corridor by margin m (both sides and both ends)
  function inside(x, z, m = 0) {
    const p = project(x, z);
    if (!p) return false;
    if ((p.k === 0 && p.u === 0 && p.a < m) || (p.k === n - 2 && p.u === 1 && p.a > -m)) return false;
    return p.d >= at(d.left, p) + m && p.d <= at(d.right, p) - m;
  }
  // deck height inside the corridor, else null (for the snow shader's height model)
  const deckIn = (x, z) => (inside(x, z) ? deckAt(x, z) : null);
  const point = (s) => {          // route point + heading (west) at distance s
    const f = Math.min(n - 1.001, Math.max(0, s / d.step)), k = Math.floor(f), u = f - k;
    const nx = lerp(NX[k], NX[k + 1], u), nz = lerp(NZ[k], NZ[k + 1], u);
    return { x: lerp(X[k], X[k + 1], u), z: lerp(Z[k], Z[k + 1], u), h: Math.atan2(nz, nx) };   // forward (sin h, -cos h) = (nz, -nx)
  };
  return { n, project, at, deckAt, inside, deckIn, point };
}

// opts: { data, level, scene, world, vehicle() -> Vehicle, place(x, z, h) (teleport),
//         edge (js/edge.js, trail restarted on enter / exit) }
export function createSbahn({ data, scene, world, vehicle, place, edge = null }) {
  if (!data) {
    const off = () => false;
    return { data: null, active: false, ghostOff: false, route: [], ground: null, deckIn: () => null, hit: () => null, bail: off,
             start() {}, pose() { return null; }, landed() {}, setActive() {}, resume: off, step() {}, frame() {},
             items: () => [], enter: off, exit: off, inside: off, deckAt: () => null };
  }
  const R = makeRoute(data);
  // all doors (old sbahn.json: only `entrance`); E = the door of the current / last sequence
  const ES = data.entrances?.length ? data.entrances : data.entrance ? [data.entrance] : [];
  let E = ES[0];
  const disarmed = new Set();   // doors next to where the bear set the car down: off until it drove away
  let active = false, ghostOff = false;
  // ---- "off the tracks": button + key G; the request is taken by hit() (on the ground, no scene running) ----
  const BAIL = data.bailouts || [];
  let wantBail = false, btnShown = null;
  const btn = typeof document !== 'undefined' ? document.getElementById('sbahnOff') : null;
  function bail() {
    if (!active || !BAIL.length) return false;
    wantBail = true; return true;
  }
  if (btn) btn.addEventListener('click', (e) => { bail(); e.currentTarget.blur(); });
  if (BAIL.length) addEventListener('keydown', (e) => {
    if ((e.key === 'g' || e.key === 'G') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) bail();
  });

  // ---- corridor walls: static boxes, only active in rails mode ----
  const body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
  const W = data.walls, HALF = 0.3;
  for (let i = 0; i < W.length / 2; i++) {
    const j = (i + 1) % (W.length / 2);
    const x0 = W[2 * i], z0 = W[2 * i + 1], x1 = W[2 * j], z1 = W[2 * j + 1], len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) continue;
    const s = new Box2D.Collision.Shapes.b2PolygonShape();
    // 0.6 m box centred on the corridor line (as index.html addWall)
    s.SetAsOrientedBox(len / 2 + HALF, HALF, new Box2D.Common.Math.b2Vec2((x0 + x1) / 2, (z0 + z1) / 2), Math.atan2(z1 - z0, x1 - x0));
    const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = s; fd.friction = 0.2; fd.restitution = 0.1;
    body.CreateFixture(fd);
  }
  body.SetActive(false);

  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on; body.SetActive(on); wantBail = false;
    if (edge?.trail) edge.trail.length = 0;   // U must not glide back to the street (or onto the deck)
  }

  // ---- markers (secret: faint, only near the car) ----
  const group = new THREE.Group(); group.name = 'sbahn'; scene.add(group);
  const GREEN = '#008d4f';   // S-Bahn green
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  const glowTex = canvasTex(128, 128, (g, w) => {
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(60,220,140,0.9)'); r.addColorStop(0.6, 'rgba(0,141,79,0.45)'); r.addColorStop(1, 'rgba(0,141,79,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });
  function disc(r, y, x, z, depthTest) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, depthTest, opacity: 0, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    if (!depthTest) m.renderOrder = 10;
    return m;
  }
  const markers = [];   // { obj[], x, z, near, far, max, when: 'street' | 'rails' }
  // stations: the doors (data.entrances) take the car in; data.lifts[i].deck (build_sbahn.py lift_pads,
  // kept as data, the slabs are gone) = that station's spot on the open deck beside the tracks: where
  // the car comes out (rolling toward the longer ride) and the stop that lets it off (out of the door)
  const STOPS = ES.map((D) => ({ D, deck: (data.lifts || []).find((l) => l.id === D.id)?.deck || null }));
  const CUT = STOPS.some((q) => q.deck);   // the blink cut instead of the bear (old data: the bear)
  const GREEN_S = '#1fbf6a', DECK_R = 3.5;   // m, the deck stop's trigger radius (centre or nose)
  // the marker (owner: "show only the green light where the entrance is"): a steady green column of
  // light standing exactly on the spot to drive into, with its soft glow at the foot; no lettering
  const lights = [];   // { b, x, z, when, near, far }
  for (const q of STOPS) {
    const D = q.D;
    const b = makeLiftBeacon({ color: GREEN_S, height: 22, radius: 2.6, opacity: 0.45 }); b.position.set(D.x, D.y, D.z);
    group.add(b); lights.push({ b, x: D.x, z: D.z, when: 'street', near: 250, far: 650 });
    if (q.deck) {   // deck stop: the shorter light
      const P = q.deck, bd = makeLiftBeacon({ color: GREEN_S, height: 7, radius: 2.4, opacity: 0.4 }); bd.position.set(P.x, P.y, P.z);
      group.add(bd); lights.push({ b: bd, x: P.x, z: P.z, when: 'rails', near: 120, far: 320 });
    }
  }
  for (const e of data.exits) {   // exits on the track (seen under station roofs too: no depth test)
    if (CUT && !e.end) continue;   // station exits: the deck stops
    const y = e.y + 0.06;
    if (e.end) {
      const s0 = e.s0, s1 = e.s1, pos = [];
      for (let s = s0; s <= s1 + 1e-6; s += data.step) {
        const k = Math.min(R.n - 1, Math.round(s / data.step));
        for (const off of [data.left[k], data.right[k]]) pos.push(data.x[k] + data.nx[k] * off, data.deck[k] + 0.06, data.z[k] + data.nz[k] * off);
      }
      const geo = new THREE.BufferGeometry(), idx = [], uv = [];
      for (let i = 0; i < pos.length / 6; i++) { uv.push(0, 0.5, 1, 0.5); if (i) { const a = 2 * (i - 1); idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
      const strip = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2fd58a, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      group.add(strip);
      markers.push({ obj: [strip], x: e.x, z: e.z, near: 40, far: 120, max: [0.22], when: 'rails' });
    } else {
      const g = disc(e.r, y, e.x, e.z, false);
      group.add(g);
      markers.push({ obj: [g], x: e.x, z: e.z, near: 25, far: 60, max: [0.45], when: 'rails' });
    }
  }
  for (const b of data.ends) {   // buffer stop: a low red / white bar across the deck
    const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], len = Math.hypot(dx, dz);
    const tex = canvasTex(256, 16, (g, w, h) => { for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#c8102e'; g.fillRect(i * w / 16, 0, w / 16, h); } });
    tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(len / 4, 1);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 0.35), new THREE.MeshBasicMaterial({ map: tex }));
    bar.position.set((b.a[0] + b.b[0]) / 2, b.y + 0.85, (b.a[1] + b.b[1]) / 2);
    bar.rotation.y = -Math.atan2(dz, dx);
    const posts = new THREE.Group();
    for (let t = 0; t <= 1.0001; t += 1 / Math.max(1, Math.round(len / 5))) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.1, 0.25), new THREE.MeshBasicMaterial({ color: 0x333333 }));
      p.position.set(b.a[0] + dx * t, b.y + 0.55, b.a[1] + dz * t); posts.add(p);
    }
    group.add(bar, posts);
    markers.push({ obj: [bar, posts], x: bar.position.x, z: bar.position.z, near: 150, far: 300, max: null, when: 'always' });
  }

  let mmStations = ES.length ? ES.map((D) => ({ id: 'station-' + D.id, kind: 'lift', x: D.x, z: D.z, label: '', found: false, mode: 'exact' })) : null;
  const deckDisarmed = new Set();   // deck stops where the car just came out: off until it is DECK_R + 8 m away

  // ---- "Tiefgarage" portal: street line -> cut onto the deck, still rolling ----
  const PO = data.portal || null;
  let poPrev = null;
  function portalHit(x, z, h) {   // centre crosses the line inward, facing in, moving in
    const rx = x - PO.x, rz = z - PO.z, t = rx * PO.ux + rz * PO.uz, w = rx * -PO.uz + rz * PO.ux;
    const near = Math.abs(w) < PO.half + 3 && Math.abs(t) < 15;
    const prev = poPrev; poPrev = near ? t : null;
    if (prev === null || !(prev < 0 && t >= 0) || Math.abs(w) > PO.half) return false;
    const lv = vehicle().body.GetLinearVelocity();
    return Math.sin(h) * PO.ux - Math.cos(h) * PO.uz > 0.5 && lv.x * PO.ux + lv.y * PO.uz > 0.3;
  }
  // the garage as a door of the 'sbahn' sequence: roll on along the driveway, sink down the ramp, gone,
  // blink, then (landed) on the deck - no bear (target.noBear: index.html skips the bear's exit)
  const PD = PO && { portal: true, id: PO.id, name: PO.name, door: [PO.x + PO.ux * 4, PO.z + PO.uz * 4], roll: PO.roll,
                     lift: PO.to, heading: Math.atan2(PO.ux, -PO.uz) };
  let cutLand = null, blinkEl = null;   // cutLand: { T, sp, stop } for landed()
  function blink(o, fade) {
    if (!blinkEl) {
      blinkEl = document.createElement('div');
      blinkEl.style.cssText = 'position:fixed;inset:0;background:#000;pointer-events:none;z-index:19;opacity:0';
      document.body.appendChild(blinkEl);
    }
    blinkEl.style.transition = fade ? 'opacity 0.35s ease-out' : 'none'; blinkEl.style.opacity = String(o);
  }
  function rollOn(T, sp, rails) {   // car already placed (respawn / teleport): rails on / off, rolling along T.h at sp, blink out
    const v = vehicle();
    setActive(rails);
    const fx = Math.sin(T.h) * sp, fz = -Math.cos(T.h) * sp;
    for (const b of [v.body, ...v.wheels.map((q) => q.body)]) b.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(fx, fz));
    v.brakeLock = false; v.prevVel = { x: fx, y: fz };   // reset() locks the brake until throttle: keep rolling
    blink(1, false);
    requestAnimationFrame(() => requestAnimationFrame(() => blink(0, true)));
  }

  // ---- triggers (index.html calls on the ground only, not while sinking / in the air) ----
  // car footprint: centre + nose (the zone is entered nose first)
  function hit(x, z, h, halfLen = 2) {
    const fx = Math.sin(h) * halfLen, fz = -Math.cos(h) * halfLen;
    for (const q of deckDisarmed) if (Math.hypot(x - q.deck.x, z - q.deck.z) > DECK_R + 8) deckDisarmed.delete(q);
    if (!active) {
      if (PO && portalHit(x, z, h)) { pendingEnt = PD; return 'sbahn'; }   // the garage: roll in, then the deck
      for (const D of ES) {
        if (disarmed.has(D)) { if (Math.hypot(x - D.x, z - D.z) > D.r + 8) disarmed.delete(D); continue; }
        for (const [px, pz] of [[x, z], [x + fx, z + fz]]) if (Math.hypot(px - D.x, pz - D.z) < D.r) { pendingEnt = D; return 'sbahn'; }
      }
      return null;
    }
    if (wantBail) {   // the button / G: the nearest checked street spot
      wantBail = false;
      let best = null, bd = Infinity;
      for (const q of BAIL) {
        const d = Math.hypot(q.x - x, q.z - z); if (d < bd) { bd = d; best = q; }
      }
      if (best) { pendingExit = { bail: true, name: best.road || 'Straße', street: best }; return 'sbahnOut'; }
    }
    for (const q of STOPS) {   // deck stop: blink, out of that station's street door
      if (!q.deck || deckDisarmed.has(q)) continue;
      for (const [px, pz] of [[x, z], [x + fx, z + fz]]) if (Math.hypot(px - q.deck.x, pz - q.deck.z) < DECK_R) { pendingExit = { cutOut: q }; return 'sbahnOut'; }
    }
    for (const e of data.exits) {
      if (CUT && !e.end) continue;   // station exits: the deck stops
      if (e.end) {
        const p = R.project(x, z);
        if (p && p.s >= e.s0 - 0.01 && p.s <= e.s1 + 0.01) return exitOf(e);
      } else {
        for (const [px, pz] of [[x, z], [x + fx, z + fz]]) if (Math.hypot(px - e.x, pz - e.z) < e.r) return exitOf(e);
      }
    }
    return null;
  }
  let pendingExit = null, pendingEnt = null;
  const exitOf = (e) => { pendingExit = e; return 'sbahnOut'; };

  // ---- the sequences: index.html startSinking(..., 'sbahn' | 'sbahnOut') -> start(sk);
  // every frame pose(sk) -> car pose, rescuer, camera focus; sk.shift makes the sinking
  // timer end at sk.T (RESCUE.done + shift); then respawnFromWater() + landed(kind) ----
  const BEAT = 1.0, ARRIVE = 1.2, LINE = 0.6, LIFT = 1.6, SET = 0.5;   // s
  const PORTAL_BLINK = 0.25;   // s from gone to full black (the garage, the station doors, the deck stops)
  const STATION_IN_V = 30 / 3.6, STATION_OUT_V = 2.8;   // m/s: out on the deck at 30 km/h, out of the door at walking pace
  function start(sk, done) {
    const v = vehicle(), lv = v.body.GetLinearVelocity(), sp = Math.hypot(lv.x, lv.y);
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) { b.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(0, 0)); b.SetAngularVelocity(0); }
    if (sk.kind === 'sbahnOut' && pendingExit?.cutOut) {   // deck stop: the car stops, blink, then out of the street door
      const q = pendingExit.cutOut, D = q.D, ix = Math.sin(D.heading), iz = -Math.cos(D.heading);
      Object.assign(sk, { sb: { cutOut: q, T: PORTAL_BLINK + 0.1 }, rest: sk.h,
        target: { x: D.door[0] - ix * 5, z: D.door[1] - iz * 5, h: wrap(D.heading + Math.PI), y: D.y, t: -1, noBear: true } });
      cutLand = { T: sk.target, sp: STATION_OUT_V, rails: false, stop: null };
      sk.shift = sk.sb.T - done; return;
    }
    if (sk.kind === 'sbahn') {
      E = pendingEnt ?? ES[0];
      // roll: quadratic Bezier car -> door -> out of sight under the deck, slowing to a crawl
      const P0 = [sk.x, sk.z], P1 = E.door, P2 = E.roll, tab = [0];
      const B = (u) => [(1 - u) * (1 - u) * P0[0] + 2 * u * (1 - u) * P1[0] + u * u * P2[0],
                        (1 - u) * (1 - u) * P0[1] + 2 * u * (1 - u) * P1[1] + u * u * P2[1]];
      for (let i = 1, q = P0; i <= 32; i++) { const p = B(i / 32); tab.push(tab[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1])); q = p; }
      const len = tab[32], v0 = Math.min(8, Math.max(2.5, sp)), v1 = E.portal ? 2.5 : 1.2, Tr = 2 * len / (v0 + v1);
      const L = E.lift, D = Math.hypot(L.x - E.roll[0], L.z - E.roll[1]);
      const Tc = D > 6 ? Math.min(6, Math.max(1.5, D / 28)) : 0;   // lift point away from the door: carried over
      Object.assign(sk, { sb: { B, tab, len, v0, v1, Tr, Tc, h0: sk.hd, y0: E.y ?? sk.h },
        target: { x: L.x, z: L.z, h: L.h, y: L.y, t: -1 }, rest: E.y ?? sk.h });
      sk.sb.T = Tr + BEAT + ARRIVE + LINE + (Tc ? 1.0 + Tc + 0.8 : LIFT + SET);
      const stop = STOPS.find((q) => q.D === E);
      if (E.portal || stop?.deck) {   // the garage / a station door: gone at Tr, blink, cut onto the deck - no bear
        const to = E.portal ? PO.to : stop.deck;
        Object.assign(sk.sb, { portal: true, drop: E.portal ? (PO.drop ?? 3.5) : 0, T: Tr + PORTAL_BLINK + 0.05 });
        sk.target = { x: to.x, z: to.z, h: to.h, y: to.y, t: -1, noBear: true };
        cutLand = { T: sk.target, sp: E.portal ? Math.min(PO.vmax, Math.max(PO.vmin, sp)) : STATION_IN_V, rails: true, stop: E.portal ? null : stop };
      }
    } else {
      const e = pendingExit, st = e.street;
      const D = Math.hypot(st.x - sk.x, st.z - sk.z), Tc = Math.min(6, Math.max(1.5, D / 28));
      // bail spot: set down along the street in the direction closest to the car's (one-way streets: as signed)
      const h = e.bail && !st.one && Math.cos(st.h - sk.hd) < 0 ? wrap(st.h + Math.PI) : st.h;
      Object.assign(sk, { sb: { exit: e, D, Tc, y0: sk.h }, target: { x: st.x, z: st.z, h, y: st.y, t: -1 }, rest: sk.h });
      sk.sb.T = ARRIVE + LINE + 1.0 + Tc + 0.8;
    }
    sk.shift = sk.sb.T - done;
  }
  const out = { x: 0, y: 0, z: 0, yaw: 0, gone: false, fx: 0, fz: 0, tip: null, line: 1 };
  function pose(sk) {
    const t = sk.t, b = sk.sb, T = sk.target;
    out.gone = false; out.tip = null; ghostOff = false; out.fy = undefined;
    if (b.cutOut) {   // deck stop: the car stands, the screen goes black
      Object.assign(out, { x: sk.x, z: sk.z, y: sk.h, yaw: sk.hd, fx: sk.x, fz: sk.z, fy: sk.h });
      blink(Math.min(1, t / PORTAL_BLINK), false);
      return out;
    }
    if (sk.kind === 'sbahn' && b.portal) {   // the garage: roll on, sink down the ramp, gone, fade to black
      const dist = t < b.Tr ? b.v0 * t + (b.v1 - b.v0) * t * t / (2 * b.Tr) : b.len;
      let i = 1; while (i < 32 && b.tab[i] < dist) i++;
      const u = Math.min(1, (i - 1 + (dist - b.tab[i - 1]) / Math.max(1e-6, b.tab[i] - b.tab[i - 1])) / 32);
      const p = b.B(u), p2 = b.B(Math.min(1, u + 0.02)), p1 = b.B(Math.max(0, u - 0.02));
      const ht = Math.atan2(p2[0] - p1[0], -(p2[1] - p1[1]));
      Object.assign(out, { x: p[0], z: p[1], y: b.y0 - (b.drop ?? 0) * Math.pow(dist / b.len, 1.6),
                           yaw: b.h0 + wrap(ht - b.h0) * ease(u / 0.35), fx: E.door[0], fz: E.door[1] });
      out.gone = t >= b.Tr;
      ghostOff = out.gone || out.y < b.y0 - 1.0;          // below the ramp mouth: no see-through car
      if (t >= b.Tr) blink(Math.min(1, (t - b.Tr) / PORTAL_BLINK), false);
      return out;
    }
    if (sk.kind === 'sbahn') {
      const tL = b.Tr + BEAT + ARRIVE + LINE;   // lift starts
      const bx = E.roll[0], bz = E.roll[1], hover = T.y + 14;
      if (t < b.Tr) {                                        // rolls in by itself, slowing down
        const dist = b.v0 * t + (b.v1 - b.v0) * t * t / (2 * b.Tr);
        let i = 1; while (i < 32 && b.tab[i] < dist) i++;
        const u = (i - 1 + (dist - b.tab[i - 1]) / Math.max(1e-6, b.tab[i] - b.tab[i - 1])) / 32;
        const p = b.B(Math.min(1, u)), p2 = b.B(Math.min(1, u + 0.02)), p1 = b.B(Math.max(0, u - 0.02));
        const ht = Math.atan2(p2[0] - p1[0], -(p2[1] - p1[1]));
        Object.assign(out, { x: p[0], z: p[1], y: b.y0, yaw: b.h0 + wrap(ht - b.h0) * ease(u / 0.35) });
        b.lastYaw = out.yaw;
      } else {
        Object.assign(out, { x: bx, z: bz, y: b.y0, yaw: b.lastYaw ?? E.heading });
        out.gone = t < tL;                                   // inside the station: really gone
      }
      // camera: on the doorway while the car vanishes, then over to where the bear lifts it
      const uf = ease((t - b.Tr - BEAT) / ARRIVE);
      out.fx = lerp(E.door[0], bx, uf); out.fz = lerp(E.door[1], bz, uf);
      if (t >= b.Tr + BEAT) {                                // the bear
        const ta = t - b.Tr - BEAT;
        const roofY = out.y + 1.6;
        if (ta < ARRIVE) {
          const u = ease(ta / ARRIVE);
          out.tip = [lerp(bx - 30, bx, u), lerp(hover + 42, hover, u), lerp(bz + 25, bz, u)]; out.line = 1;
        } else if (ta < ARRIVE + LINE) {
          out.tip = [bx, hover, bz]; out.line = lerp(1, hover - roofY, ease((ta - ARRIVE) / LINE));
        } else {
          const tl = t - tL;
          if (b.Tc) {                                        // up over the deck, carried over to the track, set down
            const top = Math.max(b.y0, T.y) + 4;
            if (tl < 1.0) out.y = lerp(b.y0, top, ease(tl));
            else if (tl < 1.0 + b.Tc) {
              const u = ease((tl - 1.0) / b.Tc);
              out.x = lerp(bx, T.x, u); out.z = lerp(bz, T.z, u);
              out.y = lerp(top, T.y + 0.5, u) + 6 * Math.sin(Math.PI * u);
              out.yaw = out.yaw + wrap(T.h - out.yaw) * u;
            } else {
              const u = ease((tl - 1.0 - b.Tc) / 0.8);
              Object.assign(out, { x: T.x, z: T.z, y: T.y + 0.5 * (1 - u), yaw: T.h });
            }
          } else if (tl < LIFT) {                            // straight up, then the last metres over onto the track
            const r = tl / LIFT, up = ease(Math.min(1, r / 0.6)), over = ease((r - 0.55) / 0.45);
            out.y = lerp(b.y0, T.y + 0.5, up);
            out.x = lerp(bx, T.x, over); out.z = lerp(bz, T.z, over);
            out.yaw = out.yaw + wrap(T.h - out.yaw) * over;
          } else {                                           // set down on the track bed
            const u = ease((tl - LIFT) / SET);
            Object.assign(out, { x: T.x, z: T.z, y: T.y + 0.5 * (1 - u), yaw: T.h });
          }
          out.fx = out.x; out.fz = out.z;
          const line = hover - (b.y0 + 1.6);
          out.tip = [out.x, out.y + 1.6 + line, out.z]; out.line = line;
        }
      }
      ghostOff = t < tL || out.y < T.y - 0.3;               // no see-through car inside the viaduct
      return out;
    }
    // sbahnOut: the bear comes at once, lifts the car off the track, carries it down to the street
    const y0 = b.y0, hover = y0 + 11, tl = t - ARRIVE - LINE, roofY0 = y0 + 1.6;   // 11 m: bear + car both in the 35 deg frame
    Object.assign(out, { x: sk.x, z: sk.z, y: y0, yaw: sk.hd });
    if (t < ARRIVE) {
      const u = ease(t / ARRIVE);
      out.tip = [lerp(sk.x - 30, sk.x, u), lerp(hover + 42, hover, u), lerp(sk.z + 25, sk.z, u)]; out.line = 1;
    } else if (tl < 0) {
      out.tip = [sk.x, hover, sk.z]; out.line = lerp(1, hover - roofY0, ease((t - ARRIVE) / LINE));
    } else {
      const top = Math.max(y0, T.y) + 4;
      if (tl < 1.0) out.y = lerp(y0, top, ease(tl));
      else if (tl < 1.0 + b.Tc) {
        const u = ease((tl - 1.0) / b.Tc);
        out.x = lerp(sk.x, T.x, u); out.z = lerp(sk.z, T.z, u);
        out.y = lerp(top, T.y + 0.5, u) + 6 * Math.sin(Math.PI * u);
        out.yaw = sk.hd + wrap(T.h - sk.hd) * u;
      } else {
        const u = ease((tl - 1.0 - b.Tc) / 0.8);
        Object.assign(out, { x: T.x, z: T.z, y: T.y + 0.5 * (1 - u), yaw: T.h });
      }
      const line = hover - roofY0;
      out.tip = [out.x, out.y + 1.6 + line, out.z]; out.line = line;
    }
    out.fx = out.x; out.fz = out.z;
    out.fy = out.y + 4;   // look point between the car and the bear, at their height (not the street under the deck)
    return out;
  }
  // after respawnFromWater(): rails on / off (the garage: also rolling on)
  function landed(kind) {
    ghostOff = false;
    if (cutLand) {   // after a blink: rolling on (deck: rails on; street door: rails off)
      const c = cutLand; cutLand = null;
      rollOn(c.T, c.sp, c.rails);
      if (c.stop) deckDisarmed.add(c.stop);   // came out on the deck stop: it waits until the car moved on
      if (c.rails) return;
    }
    if (kind === 'sbahn') {
      setActive(true);
    } else if (kind === 'sbahnOut') {
      setActive(false);
      const c = vehicle().getPosition();   // set down next to a door: that door waits until the car drove off
      for (const D of ES) if (Math.hypot(c.x - D.x, c.y - D.z) < D.r + 8) disarmed.add(D);
    }
  }

  // ---- per physics step in rails mode: keep the car centre on the deck ----
  const M = 0.5;   // m inside the corridor edge (the walls keep the body ~1.2 m in)
  function step() {
    if (!active) return;
    const v = vehicle(), c = v.body.GetWorldCenter(), p = R.project(c.x, c.y);
    if (!p) return;
    const k = p.k, nx = lerp(data.nx[k], data.nx[k + 1], p.u), nz = lerp(data.nz[k], data.nz[k + 1], p.u);
    let px = 0, pz = 0, ix = 0, iz = 0;
    const lo = R.at(data.left, p) + M, hi = R.at(data.right, p) - M;
    if (p.d < lo) { px += nx * (lo - p.d); pz += nz * (lo - p.d); ix = nx; iz = nz; }
    else if (p.d > hi) { px -= nx * (p.d - hi); pz -= nz * (p.d - hi); ix = -nx; iz = -nz; }
    if (k === 0 && p.u === 0 && p.a < M) { px += nz * (M - p.a); pz -= nx * (M - p.a); ix = nz; iz = -nx; }
    if (k === R.n - 2 && p.u === 1 && p.a > -M) { px -= nz * (p.a + M); pz += nx * (p.a + M); ix = -nz; iz = nx; }
    if (!px && !pz) return;
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) {
      const q = b.GetPosition();
      b.SetPosition(new Box2D.Common.Math.b2Vec2(q.x + px, q.y + pz));
      const lv = b.GetLinearVelocity(), vn = lv.x * ix + lv.y * iz;
      if (vn < 0) b.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(lv.x - vn * ix, lv.y - vn * iz));
    }
  }

  // ---- per render frame: marker fades ----
  function frame(x, z, busy) {
    if (!busy && cutLand) cutLand = null;   // R / teleport during a blink
    if (!busy && blinkEl && blinkEl.style.opacity === '1' && !cutLand) blink(0, true);
    for (const q of lights) {   // street lights off the tracks, deck lights on them (and never during a scene); distance fade
      const on = q.when === 'rails' ? active : !active && !busy;
      q.b.setFade(on ? 1 - Math.min(1, Math.max(0, (Math.hypot(x - q.x, z - q.z) - q.near) / (q.far - q.near))) : 0);
    }
    if (mmStations && window.berlinDrive?.minimap?.setMarkerGroup) { window.berlinDrive.minimap.setMarkerGroup('sbahn-stations', mmStations); mmStations = null; }
    const want = !!btn && active && !busy && BAIL.length > 0;   // the button only on the tracks, never during a scene
    if (btn && want !== btnShown) { btnShown = want; btn.style.display = want ? 'block' : 'none'; }
    for (const m of markers) {
      const show = m.when === 'always' || (m.when === 'rails' ? active : !active && !busy);
      const d = Math.hypot(x - m.x, z - m.z), f = show ? 1 - Math.min(1, Math.max(0, (d - m.near) / (m.far - m.near))) : 0;
      for (let i = 0; i < m.obj.length; i++) {
        const o = m.obj[i];
        o.visible = f > 0.01;
        if (m.max && o.material) o.material.opacity = m.max[i] * f;   // calm: no pulsing
      }
    }
  }

  const items = () => [
    ...ES.map((D) => ({ id: D.id, kind: 'sbahn-entrance', name: D.name, lat: D.lat, lon: D.lon, x: D.x, z: D.z })),
    ...STOPS.filter((q) => q.deck).map((q) => ({ id: q.D.id + '-deck', kind: 'sbahn-exit', name: q.D.name, x: q.deck.x, z: q.deck.z }))
      .concat(data.exits.filter((e) => !CUT || e.end).map((e) => ({ id: e.id, kind: 'sbahn-exit', name: e.name, lat: e.lat, lon: e.lon, x: e.x, z: e.z }))),
  ];
  const route = data.x.map((x, i) => [x, data.z[i]]);
  return {
    data, route, items, hit, start, pose, landed, setActive, step, frame, bail,
    get active() { return active; }, get ghostOff() { return ghostOff; },
    inside: R.inside, deckAt: R.deckAt, deckIn: R.deckIn, project: (x, z) => { const p = R.project(x, z); return p && { ...p }; },
    // the car's height source in rails mode (carGround's groundAt): the deck profile
    ground: (x, z) => (active ? R.deckAt(x, z) : null),
    // mood switch reload: back on the deck if the stored position is on it
    resume(x, z) { if (R.inside(x, z, 0.5)) { setActive(true); return true; } return false; },
    // test hooks: enter(s = start) puts the car on the route at s (m from the east end,
    // or a station name), heading west, rails on; enter(door id, e.g. 'sbahn-alexanderplatz')
    // = where the bear sets the car down from that door; exit(name?) = to that exit's
    // street (default: the nearest), rails off
    enter(s = ES[0].lift.s) {
      const door = typeof s === 'string' && ES.find((q) => q.id === s);
      if (door) {   // where that door's cut puts the car (the deck stop; old data: the bear's lift point)
        const q = STOPS.find((st) => st.D === door), P = q?.deck ?? door.lift;
        place(P.x, P.z, P.h); setActive(true); if (q?.deck) deckDisarmed.add(q); return true;
      }
      if (typeof s === 'string') { const e = data.exits.find((q) => q.name === s || q.id === s); s = e ? Math.max(2, e.s0 - 40) : ES[0].lift.s; }
      const p = s === ES[0].lift.s ? { x: ES[0].lift.x, z: ES[0].lift.z, h: ES[0].lift.h } : R.point(s);
      place(p.x, p.z, p.h); setActive(true); return true;
    },
    exit(name) {
      const c = vehicle().getPosition();
      const e = data.exits.find((q) => q.name === name || q.id === name)
        ?? data.exits.reduce((a, q) => (Math.hypot(q.x - c.x, q.z - c.y) < Math.hypot(a.x - c.x, a.z - c.y) ? q : a));
      place(e.street.x, e.street.z, e.street.h); setActive(false); return true;
    },
    // test hook: the Tiefgarage cut as if driven in at `kmh` (default 30)
    // test hook: the garage at `kmh` (default 30): put 4 m before the line, rolling in (the trigger
    // plays the roll-in); skip = true: straight onto the deck without it
    portal(kmh = 30, skip = false) {
      if (!PO) return false;
      const v = vehicle(), sp = kmh / 3.6;
      if (skip) { place(PO.to.x, PO.to.z, PO.to.h); rollOn(PO.to, Math.min(PO.vmax, Math.max(PO.vmin, sp)), true); return true; }
      place(PO.x - PO.ux * 4, PO.z - PO.uz * 4, PD.heading); poPrev = null;
      for (const b of [v.body, ...v.wheels.map((q) => q.body)]) b.SetLinearVelocity(new Box2D.Common.Math.b2Vec2(PO.ux * sp, PO.uz * sp));
      v.brakeLock = false; return true;
    },
    get entrance() { return { ...E }; },
    get entrances() { return ES.map((D) => ({ ...D })); },
  };
}

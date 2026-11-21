// Easter egg: drive on the roofs ("roof mode"). First route: the Bundestag band - the
// Paul-Loebe-Haus glass hall roof, the roof of the upper Spree skywalk (about 3.5 m wide)
// and the Marie-Elisabeth-Lueders-Haus, about 24 m above the street.
//
// Data: levels/<name>/roofs_deck.json + roofs_deck.bin from build_roofs.py, per route:
//   deck   int16 cm heights of the drivable roof from the L1 mesh top surface (void = off the
//          deck: the edge, light wells, courtyards, lower roof parts)
//   floor  int16 cm mesh top surface at 1 m over the whole window: where a falling car lands
//   boxes  obstacles on the roof (parapets, the walls of higher parts, drums, vents):
//          axis-aligned [x0, z0, x1, z1], static Box2D boxes active only in roof mode
//   start, lift (grey slab: street spot, slide height, roof dock, deliver pose), street (pose
//          where the car rolls off the slab after the ride down)
// Roof mode (active):
//   - height: carGround's override = the deck height (index.html), so the car rides the stored
//     roof surface, not the street height model; steps between roof parts (<= 1.4 m, hall
//     roof <-> wings) are ridden as short ramps by the ride layer's rise limit;
//   - collisions: the car's fixtures only collide with the roof boxes (filter mask, as the
//     tunnel mode does): building walls, street clutter, ball, bears, balloon below are out;
//     index.html also switches walls / clutter / bridges off and skips water, pits, no-drive
//     zones, S-Bahn doors, safe poses and camera avoidance (the camera is above everything);
//   - the edge: no rails. The car centre off the deck (on the ground, not in a hop) ->
//     index.html startSinking(kind 'roofFall'): the car goes over the edge with its speed,
//     falls onto the floor below (street, courtyard, the Spree), the Rescue Bear lifts it and (FALL_TO, owner 2026-11-21) sets it down at the roof's start; other settings:
//     back onto the roof at the last checkpoint >= 1 s before the fall (checkpoints every
//     0.5 s where the car box has 0.3 m of deck around it), facing as it drove then;
//   - getting up / down (owner 2026-11-21: "a grey platform instead"): one grey lift slab
//     (js/liftpad.js) with two stops. On the street (west entrance of the Paul-Loebe-Haus) the car
//     drives onto it -> 'roofUp': rolled to the centre, the slab rises with it, slides east over
//     the canopy and docks flush on the hall roof, the car rolls off. While the car is in roof mode
//     the slab waits at the dock; driving onto it -> 'roofDown': the same ride back, the car rolls
//     off west onto the forecourt. No bear and no text in these rides; the camera follows the car.
//     A car the lift just delivered is not taken again until it has left the slab.
//   - quiet game (owner 2026-11-21): nothing in this module writes text to the screen.
// Console: berlinDrive.roofs.enter() (= ?spot=bundestag-dach), .exit(), .items(), .stats().
// No level without roofs_deck.json does anything (createRoofs(null) is an inert stub).
import * as THREE from 'three';
import { makeLiftPad, makeLiftBeacon } from './liftpad.js';
import { fetchBin } from './site.js';   // .bin, gzipped on the published site

export async function loadRoofs(base) {
  try {
    const r = await fetch(base + 'roofs_deck.json');
    if (!r.ok) return null;
    const doc = await r.json();
    const b = await fetchBin(base + (doc.file || 'roofs_deck.bin'));
    if (!b.ok) return null;
    return { doc, buf: await b.arrayBuffer() };
  } catch { return null; }
}

const ROOF_BIT = 0x2000;          // Box2D collision category of the roof obstacles (tunnels: 0x4000)
const KINDS = ['roofFall', 'roofUp', 'roofDown'];
// after a fall the bear sets the car down: 'start' = on the roof where the lift delivers (owner 2026-11-21, final:
// back on the roof, but the way across is lost), 'checkpoint' = where it drove 1 s before the fall, 'street' = by the lift below
const FALL_TO = 'start';
const G = 16;                     // m/s2 of the fall (index.html PIT.g: reads better than 9.81 from the chase camera)
const CHECK_DT = 0.5, BACK_T = 1.0, CHECK_PAD = 0.3, OFF_STEPS = 3;
const ARRIVE = 1.2, LINE = 0.6, LIFT = 1.4, SET = 0.8, SIT = 0.5;   // s
// the bear's line is short and fixed (m): the rod tip stays LINE_L + 1.6 m above the car, so the bear is
// inside the chase camera's frame (a hover 16 m above the ROOF put it ~40 m over a car on the street:
// above the top edge of a 35 deg view looking down at 45 deg - that is why it was invisible)
const LINE_L = 10;
// the lift (s, m/s): roll to the centre, rise, slide, settle, roll off
const ROLL = 1.2, RISE_V = 5, SLIDE_V = 4, RAMP = 1.0, OFF_T = 2.5, PLATE = 0.05;
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a, b, u) => a + (b - a) * u;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// opts: { data (loadRoofs), scene, world, vehicle() -> Vehicle, place(x, z, h) (teleport),
//         edge (js/edge.js: trail restarted on enter / exit), isWater(x, z), groundAt(x, z) }
export function createRoofs({ data, scene, world, vehicle, place, edge = null, isWater = () => false, groundAt = () => 0 }) {
  const off = () => false;
  if (!data || !data.doc.routes?.length) {
    return { data: null, active: false, owns: off, heightAt: () => null, ground: () => null, deckAt: () => null, onDeck: off,
             hit: () => null, start() {}, pose() { return null; }, landed() {}, label: () => '', setActive() {}, step() {},
             frame() {}, resume: off, enter: off, exit: off, items: () => [], stats: () => ({}) };
  }
  const routes = data.doc.routes.map((r) => ({
    ...r,
    D: new Int16Array(data.buf, r.deck.off, r.deck.count),
    F: new Int16Array(data.buf, r.floor.off, r.floor.count),
  }));
  let cur = routes[0], active = false;

  // ---- grids ----
  const cellOf = (g, x, z) => [(x - g.x0) / g.cell - 0.5, (-z - g.n0) / g.cell - 0.5];
  function deckOf(R, x, z) {   // bilinear where all four cells are deck, else the nearest cell; null off the deck
    const g = R.deck, [fi, fj] = cellOf(g, x, z), i = Math.round(fi), j = Math.round(fj);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return null;
    const v = R.D[j * g.nx + i];
    if (v === g.void) return null;
    const i0 = Math.floor(fi), j0 = Math.floor(fj), u = fi - i0, w = fj - j0;
    if (i0 >= 0 && j0 >= 0 && i0 + 1 < g.nx && j0 + 1 < g.nz) {
      const k = j0 * g.nx + i0, a = R.D[k], b = R.D[k + 1], c = R.D[k + g.nx], d = R.D[k + g.nx + 1];
      if (a !== g.void && b !== g.void && c !== g.void && d !== g.void) return ((a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w) * g.unit;
    }
    return v * g.unit;
  }
  function deckAt(x, z) {        // any route
    for (const R of routes) { const y = deckOf(R, x, z); if (y !== null) return { route: R.id, y }; }
    return null;
  }
  function floorAt(x, z) {       // where a falling car lands: mesh top at 1 m (the street model outside the window)
    const g = cur.floor, i = Math.floor((x - g.x0) / g.cell), j = Math.floor((-z - g.n0) / g.cell);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return groundAt(x, z);
    return cur.F[j * g.nx + i] * g.unit;
  }
  const onDeck = (x, z) => deckOf(cur, x, z) !== null;
  // the car box (heading h, forward (sin h, -cos h)) with pad m around it all on the deck
  function boxOnDeck(x, z, h, pad) {
    const v = vehicle(), L = v.spec.bodyLength / 2 + pad, W = v.spec.bodyWidth / 2 + pad;
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    for (const a of [-L, 0, L]) for (const b of [-W, 0, W]) if (!onDeck(x + fx * a + rx * b, z + fz * a + rz * b)) return false;
    return true;
  }

  // ---- obstacle boxes: one static body per route, active in roof mode on that route ----
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  for (const R of routes) {
    R.body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
    const filt = new Box2D.Dynamics.b2FilterData(); filt.categoryBits = ROOF_BIT; filt.maskBits = 0xffff;
    for (const [x0, z0, x1, z1] of R.boxes) {
      const s = new Box2D.Collision.Shapes.b2PolygonShape();
      s.SetAsOrientedBox(Math.max(0.05, (x1 - x0) / 2), Math.max(0.05, (z1 - z0) / 2), new b2Vec2((x0 + x1) / 2, (z0 + z1) / 2), 0);
      const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = s; fd.friction = 0.35; fd.restitution = 0;   // js/vehicle.js SOLID
      fd.filter = filt;
      R.body.CreateFixture(fd);
    }
    R.body.SetActive(false);
  }
  // the car's fixtures: only the roof boxes while active (nothing from the street below)
  let maskOn = null, maskVeh = null;
  function applyMask(v, force = false) {
    if (!force && maskOn === active && maskVeh === v) return;
    maskOn = active; maskVeh = v;
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) {
      for (let f = b.GetFixtureList(); f; f = f.GetNext()) {
        const fd = f.GetFilterData(); fd.maskBits = active ? ROOF_BIT : 0xffff; f.SetFilterData(fd);
      }
      for (let c = b.GetContactList(); c; c = c.next) c.contact.FlagForFiltering();   // Box2D.js skips this in SetFilterData
    }
  }
  const checks = [];   // roof checkpoints { t, x, z, h, y }
  let clock = 0, offN = 0, keep = 0;
  function setActive(on, R = cur) {
    on = !!on;
    if (on === active && R === cur) return;
    for (const q of routes) q.body.SetActive(on && q === R);
    active = on; cur = R; offN = 0;
    if (!on) checks.length = 0;
    if (edge?.trail) edge.trail.length = 0;   // U must not glide back onto / off the roof
    const v = vehicle(); if (v) applyMask(v, true);
  }

  // ---- the lift slab: one per route; at rest on the street (street mode) or at the roof dock (roof mode) ----
  const group = new THREE.Group(); group.name = 'roofs'; scene.add(group);
  for (const R of routes) {
    const L = R.lift;
    R.pad = makeLiftPad({ length: L.len, width: L.wid, thick: L.thick ?? 0.35, fill: '#1fbf6a', accent: '#eafff2', side: 0x14803f });   // owner (2026-11-21): green deck, the grey one was hard to see
    R.pad.rotation.y = 0;   // long axis east-west, chevrons pointing east (to the building)
    group.add(R.pad);
    R.pad.add(makeLiftBeacon({ color: '#fff1d6', height: 16, radius: 2.6, opacity: 0.35 }));   // warm white beacon (S-Bahn lifts: green)
  }
  const padAt = (R, x, y, z) => R.pad.position.set(x, y, z);
  const restPad = (R) => (active && R === cur ? padAt(R, R.lift.dock.x, R.lift.dock.y + PLATE, R.lift.dock.z)
                                              : padAt(R, R.lift.x, R.lift.y0 + PLATE, R.lift.z));
  for (const R of routes) restPad(R);
  // car centre on the slab rect at (cx, cz), by `inset` m inside its rim
  const onPad = (R, cx, cz, x, z, inset) => Math.abs(x - cx) <= R.lift.len / 2 - inset && Math.abs(z - cz) <= R.lift.wid / 2 - inset;

  // ---- triggers (index.html: on the ground only, not while sinking / in a hop / turning) ----
  const disarmed = new Set();   // R: the slab (street or dock) the lift just set the car down on, until it left it
  let pending = null;
  function hit(x, z, h) {
    if (!active) {
      for (const R of routes) {
        const L = R.lift;
        if (disarmed.has(R)) { if (!onPad(R, L.x, L.z, x, z, -1)) disarmed.delete(R); continue; }
        if (onPad(R, L.x, L.z, x, z, 1.0)) { pending = R; return 'roofUp'; }
      }
      return null;
    }
    const D = cur.lift.dock;
    if (disarmed.has(cur)) { if (!onPad(cur, D.x, D.z, x, z, -1)) disarmed.delete(cur); }
    else if (onPad(cur, D.x, D.z, x, z, 1.0)) return 'roofDown';
    // the edge: centre off the deck for a few physics steps (one stray cell does not throw the car off)
    if (!onDeck(x, z)) { if (++offN >= OFF_STEPS) { offN = 0; return 'roofFall'; } } else offN = 0;
    return null;
  }

  // ---- the sequences: index.html startSinking(..., kind) -> start(sk, done); every frame
  // pose(sk) -> car pose, bear, camera focus; the sinking timer ends at sk.shift + done;
  // then respawnFromWater() (car to sk.target) + landed(kind) ----
  function start(sk, done) {
    const v = vehicle(), lv = v.body.GetLinearVelocity(), sp = Math.hypot(lv.x, lv.y), hd = sk.hd;
    for (const b of [v.body, ...v.wheels.map((w) => w.body)]) { b.SetLinearVelocity(new b2Vec2(0, 0)); b.SetAngularVelocity(0); }
    const rf = { x: sk.x, z: sk.z, y: sk.h, yaw: hd };
    if (sk.kind === 'roofFall') {
      // over the edge along the velocity (standing: the heading), at least 2.5 m out so the car
      // clears the facade, ballistic onto the floor below
      const [dx, dz] = sp > 0.5 ? [lv.x / sp, lv.y / sp] : [Math.sin(hd), -Math.cos(hd)];
      let T = 1.5, D = 2.5, fl = sk.h - 20;
      for (let k = 0; k < 4; k++) {
        D = Math.min(Math.max(Math.min(sp, 15) * T, 2.5), 14);
        fl = floorAt(sk.x + dx * D, sk.z + dz * D);
        T = Math.sqrt(2 * Math.max(0.5, sk.h - fl) / G);
      }
      const lx = sk.x + dx * D, lz = sk.z + dz * D, wet = isWater(lx, lz);
      // back on the roof: the last checkpoint >= BACK_T s before the fall, else the oldest, else the start
      // owner (2026-11-21): a fall should cost something - the bear no longer puts the car back on the
      // roof (last checkpoint) but sets it down on the street next to the lift; up again = the lift ride
      const roofStart = { x: cur.start.x, z: cur.start.z, h: cur.start.h, y: cur.start.y };
      const c = FALL_TO === 'street' ? { x: cur.street.x, z: cur.street.z, h: cur.street.h, y: cur.street.y }
        : FALL_TO === 'start' ? roofStart
        : (() => { const back = checks.filter((k) => clock - k.t >= BACK_T);
                   return back.length ? back[back.length - 1] : checks[0] ?? roofStart; })();
      keep = FALL_TO === 'checkpoint' ? Math.max(0, checks.indexOf(c) + 1) : 0;   // the checkpoints up to the target stay (a quick second fall goes there too)
      const D2 = Math.hypot(c.x - lx, c.z - lz);
      Object.assign(sk, { rf: { ...rf, dx, dz, D, T, floor: wet ? fl - 0.9 : fl, wet, lx, lz, Tc: Math.min(5, Math.max(1.5, D2 / 25)) },
        target: { x: c.x, z: c.z, h: c.h, y: c.y, t: -1 }, rest: fl });
      sk.rf.T0 = T + SIT;
      sk.rf.Tall = sk.rf.T0 + ARRIVE + LINE + LIFT + sk.rf.Tc + SET;
    } else {
      // the lift: roll to the slab centre facing the ride, rise / slide / settle (trapezoid speed
      // profile: RAMP s gentle start and stop), roll off; the slab stays where it stopped
      const up = sk.kind === 'roofUp', R = up ? (pending ?? cur) : cur, L = R.lift;
      cur = R;
      const P = up ? L.deliver : R.street, hRide = up ? Math.PI / 2 : -Math.PI / 2;
      const legs = up ? [[L.x, L.y0, L.z], [L.x, L.travel, L.z], [L.dock.x, L.travel, L.dock.z], [L.dock.x, L.dock.y, L.dock.z]]
                      : [[L.dock.x, L.dock.y, L.dock.z], [L.dock.x, L.travel, L.dock.z], [L.x, L.travel, L.z], [L.x, L.y0, L.z]];
      const segs = [];
      let t = ROLL;
      for (let k = 0; k + 1 < legs.length; k++) {
        const a = legs[k], b = legs[k + 1], d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const v = b[1] !== a[1] && b[0] === a[0] ? RISE_V : SLIDE_V, T = d / v + RAMP;
        segs.push({ a, b, t0: t, T, v: d / (T - RAMP / 2) }); t += T;
      }
      Object.assign(sk, { rf: { ...rf, lift: true, R, legs, segs, hRide, Toff: t, D: 0, T: 0, T0: 0, floor: sk.h, lx: sk.x, lz: sk.z },
        target: { x: P.x, z: P.z, h: P.h, y: P.y, t: -1, noBear: true }, rest: sk.h });
      sk.rf.Tall = t + OFF_T;
      seq = R;
    }
    sk.shift = sk.rf.Tall - done;
  }
  const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, gone: false, fx: 0, fz: 0, fy: 0, tip: null, line: 1 };
  // trapezoid speed profile over a segment of duration T with RAMP s ramps: fraction 0..1 at time t
  function trap(t, T) {
    if (t <= 0) return 0; if (t >= T) return 1;
    const r = Math.min(RAMP, T / 2), cruise = T - r, tot = cruise;            // distance in units of v (v = 1)
    const s = t < r ? t * t / (2 * r) : t < T - r ? r / 2 + (t - r) : tot - (T - t) * (T - t) / (2 * r);
    return s / tot;
  }
  function liftPose(sk) {
    const t = sk.t, b = sk.rf, R = b.R, T = sk.target, last = b.legs[b.legs.length - 1];
    let px = b.legs[0][0], py = b.legs[0][1], pz = b.legs[0][2];
    for (const g of b.segs) {
      if (t < g.t0) break;
      const u = trap(t - g.t0, g.T);
      px = lerp(g.a[0], g.b[0], u); py = lerp(g.a[1], g.b[1], u); pz = lerp(g.a[2], g.b[2], u);
    }
    padAt(R, px, py + PLATE, pz);
    let x, z, yaw, y = py + PLATE;
    if (t < ROLL) {                                   // onto the centre, turning to face the ride
      const u = ease(t / ROLL);
      x = lerp(b.x, px, u); z = lerp(b.z, pz, u); yaw = b.yaw + wrap(b.hRide - b.yaw) * u;
      y = lerp(b.y, py + PLATE, u);
    } else if (t < b.Toff) { x = px; z = pz; yaw = b.hRide; }
    else {                                            // rolls off onto the deck / the street
      const u = ease((t - b.Toff) / OFF_T);
      x = lerp(last[0], T.x, u); z = lerp(last[2], T.z, u); yaw = b.hRide + wrap(T.h - b.hRide) * u;
      y = lerp(last[1] + PLATE, T.y, ease(Math.min(1, u * 3)));
    }
    Object.assign(out, { x, y, z, yaw, pitch: 0, roll: 0, gone: false, fx: x, fz: z, fy: y, tip: null, line: 1 });
    return out;
  }
  function pose(sk) {
    if (sk.rf.lift) return liftPose(sk);
    const t = sk.t, b = sk.rf, T = sk.target;
    let x = b.lx, z = b.lz, y = b.floor, yaw = b.yaw, pitch = 0, roll = 0;
    if (t < b.T) {                                   // over the edge and down, nose first
      const u = t / b.T;
      x = b.x + b.dx * b.D * u; z = b.z + b.dz * b.D * u;
      y = Math.max(b.floor, b.y - 0.5 * G * t * t);
      pitch = -0.9 * ease(Math.min(1, 1.6 * u)); roll = 0.25 * Math.sin(Math.PI * u);
    } else if (t < b.T0) {                           // landed: sits (water: bobbing, half under)
      pitch = b.wet ? -0.35 : -0.9 * Math.max(0, 1 - (t - b.T) / 0.15);
      if (b.wet) y = b.floor + 0.1 * Math.sin(t * 5);
    }
    const tb = t - b.T0, roofY0 = y + 1.6;
    // the bear: flies in, line down, lifts the car up, carries it over, sets it down; the rod tip stays
    // LINE_L m over the car roof the whole time (in the chase camera's frame)
    const hover = roofY0 + LINE_L;
    out.tip = null; out.line = 1;
    if (tb >= 0) {
      if (b.wet) pitch = -0.35 * Math.max(0, 1 - Math.max(0, tb - ARRIVE - LINE) / 0.6);
      else pitch = 0;
      if (tb < ARRIVE) {
        const u = ease(tb / ARRIVE);
        out.tip = [lerp(x - 30, x, u), lerp(hover + 42, hover, u), lerp(z + 25, z, u)];
      } else if (tb < ARRIVE + LINE) {
        out.tip = [x, hover, z]; out.line = lerp(1, LINE_L, ease((tb - ARRIVE) / LINE));
      } else {
        const tl = tb - ARRIVE - LINE, top = Math.max(b.floor, T.y) + 5, y0 = y;
        if (tl < LIFT) y = lerp(y0, top, ease(tl / LIFT));
        else if (tl < LIFT + b.Tc) {
          const u = ease((tl - LIFT) / b.Tc);
          x = lerp(b.lx, T.x, u); z = lerp(b.lz, T.z, u);
          y = lerp(top, T.y + 0.5, u) + 4 * Math.sin(Math.PI * u);
          yaw = b.yaw + wrap(T.h - b.yaw) * u;
        } else {
          const u = ease((tl - LIFT - b.Tc) / SET);
          x = T.x; z = T.z; y = T.y + 0.5 * (1 - u); yaw = T.h;
        }
        out.tip = [x, y + 1.6 + LINE_L, z]; out.line = LINE_L;
      }
    }
    Object.assign(out, { x, y, z, yaw, pitch, roll, gone: false, fx: x, fz: z, fy: y });
    return out;
  }
  function landed(kind) {
    seq = null;
    if (kind === 'roofFall' && FALL_TO === 'street') {   // set down on the street by the lift: roof mode off
      setActive(false); checks.length = 0; disarmed.add(cur);
    } else if (kind === 'roofUp' || kind === 'roofFall') {
      setActive(true, cur);
      checks.length = kind === 'roofFall' ? Math.min(checks.length, keep) : 0;
      if (kind === 'roofUp') disarmed.add(cur);       // delivered next to the dock: not taken back down at once
    } else if (kind === 'roofDown') {
      setActive(false);
      disarmed.add(cur);
    }
    for (const R of routes) restPad(R);
  }
  // owner 2026-11-21: a quiet game, no on-screen messages: the label is empty (kept so index.html's call stays valid)
  const label = () => '';

  // ---- per physics step (after world.Step): mask, checkpoints. busy: sinking / in a hop / turning ----
  function step(busy) {
    clock += 1 / 60;
    const v = vehicle(); if (!v) return;
    applyMask(v);
    if (!active || busy) return;
    if (checks.length && clock - checks[checks.length - 1].t < CHECK_DT) return;
    const p = v.getPosition(), h = v.getHeading();
    if (!boxOnDeck(p.x, p.y, h, CHECK_PAD)) return;
    checks.push({ t: clock, x: p.x, z: p.y, h, y: deckOf(cur, p.x, p.y) });
    if (checks.length > 40) checks.shift();
  }

  // ---- per render frame: the slabs rest at the street / the dock unless a ride moves them ----
  let seq = null;
  function frame(x, z, busy) {
    if (busy && seq) return;
    seq = null;
    for (const R of routes) restPad(R);
  }

  const byId = (id) => routes.find((R) => R.id === id || R.slug === id) ?? routes[0];
  return {
    data: data.doc, routes: routes.map((R) => R.id), hit, start, pose, landed, label, setActive, step, frame, deckAt, onDeck, floorAt,
    owns: (kind) => KINDS.includes(kind),
    get active() { return active; }, get route() { return cur.id; }, get checkpoints() { return checks.map((c) => ({ ...c })); },
    // carGround (index.html): override + height-model fallback in roof mode; null off the deck
    heightAt: (x, z) => (active ? deckOf(cur, x, z) : null),
    ground: (x, z) => (active ? deckOf(cur, x, z) : null),
    // mood switch reload: back in roof mode if the stored position is on a deck
    resume(x, z) { for (const R of routes) if (deckOf(R, x, z) !== null) { setActive(true, R); return true; } return false; },
    // test hooks: enter(route id | spot slug, pose = the route's start { x, z, h }) = onto the roof, roof mode on
    // (a pose off that deck falls back to the start); exit() = the street pose next to the lift, roof mode off
    enter(id, pose = null) {
      const R = byId(id), P = pose && deckOf(R, pose.x, pose.z) !== null ? pose : R.start;
      place(P.x, P.z, P.h); setActive(true, R); return true;
    },
    exit() { const R = cur; place(R.street.x, R.street.z, R.street.h); setActive(false); disarmed.add(R); return true; },
    items: () => routes.flatMap((R) => [
      { id: R.slug, kind: 'roof-lift', name: R.name, x: R.lift.x, z: R.lift.z },
      { id: R.slug + '-dock', kind: 'roof-lift-dock', name: R.name, x: R.lift.dock.x, z: R.lift.dock.z }]),
    get pads() { return routes.map((R) => ({ route: R.id, x: R.pad.position.x, y: R.pad.position.y, z: R.pad.position.z, visible: R.pad.visible })); },
    stats: () => ({ active, route: cur.id, checkpoints: checks.length, boxes: cur.boxes.length, ...cur.stats }),
  };
}

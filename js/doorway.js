// Doorway figure and garden fountain. The figure: a small cartoon homage, a young woman with bright red hair, pale blue-grey tank top and
// light green trousers, caught mid-stride in a house door as if about to run off. Quiet: no text, no sound,
// no collider (the car drives past / through her space untouched).
//
// Data: levels/<name>/doorway.json (build_eggs.py DOORWAYS / FOUNTAINS): items
//   kind 'doorway':  { id, x, z, heading (clockwise from north, forward = (sin h, -cos h), out of the door), height (m),
//                      door { width, height, back } }
//   kind 'fountain': { id, x, z, radius (basin m), height (rim m) }: stone basin, column + bowl, a small jet
//   kind 'hint-frame': { id, x, z, heading (out of the opening), width, height, bear }: thin green outline of an
//                    entrance, shown while that bear (eggs.json id) is unfound
//   kind 'photo-group': { id, x, z, heading, width, height }: two costumed soldiers + two tourists taking a selfie
//   kind 'watcher':   { id, x, z, yAbs (window centre, world height) | y (above the street), heading (out of the wall), width, height }:
//                     a lit lone window, a man in a trench coat with binoculars; steps back when the car stops below
// No file -> nothing. Neither has a collider.
//
//   const dw = await createDoorway({ root, base, groundAt, groundY, emissiveBoost, isFound });   // from js/eggs.js
//   dw?.update(dt, car)
//
// Lit like the eggs: Lambert materials under the eggs' own hemisphere + sun (js/eggs.js root, mood values),
// a little emissive so she reads in the unlit world, more at night (emissiveBoost). Nothing sets
// userData.world (camera collision / ground probes ignore her). Idle motion only within NEAR m of the car.
import * as THREE from 'three';

const NEAR = 150;              // m: idle motion and the mesh height refresh only this close to the car
const COL = { hair: '#e3261b', top: '#aebdc9', pants: '#a9d9a0', skin: '#f2c8a6', shoe: '#2f2f33', eye: '#1b1b1b',
              door: '#2b2724', frame: '#d4cdbf', stone: '#c9c5bc', water: '#86c7bd', spray: '#e8f6f4' };

// local frame: faces -z, feet on y = 0, about 2.0 m tall at scale 1. Mid-stride: right leg forward, left back,
// arms swinging opposite, body leaning forward a little.
function makeFigure() {
  const g = new THREE.Group();
  const mat = (c, e = 0.12) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e });
  const M = { hair: mat(COL.hair, 0.22), top: mat(COL.top), pants: mat(COL.pants), skin: mat(COL.skin, 0.1),
              shoe: new THREE.MeshLambertMaterial({ color: COL.shoe }), eye: new THREE.MeshLambertMaterial({ color: COL.eye }) };
  const add = (geo, m, x, y, z, parent, sx = 1, sy = 1, sz = 1) => {
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); parent.add(o); return o;
  };
  const body = new THREE.Group(); body.name = 'body'; body.rotation.x = -0.1; body.position.y = -0.05; g.add(body);   // lean into the run (and down: swung legs are shorter)
  const legs = [];
  for (const [sx, swing] of [[1, 0.38], [-1, -0.32]]) {          // pivot at the hip; +x rotation swings the foot forward (-z)
    const leg = new THREE.Group(); leg.position.set(0.1 * sx, 0.9, 0); leg.rotation.x = swing; body.add(leg);
    add(new THREE.CapsuleGeometry(0.075, 0.62, 6, 12), M.pants, 0, -0.42, 0, leg);
    add(new THREE.BoxGeometry(0.13, 0.09, 0.27), M.shoe, 0, -0.84, -0.05, leg);
    legs.push({ leg, swing });
  }
  add(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 16), M.pants, 0, 0.92, 0, body, 1, 1, 0.75);   // hips
  add(new THREE.CylinderGeometry(0.175, 0.15, 0.52, 16), M.top, 0, 1.24, 0, body, 1, 1, 0.68);    // tank top
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.03, 0.1), M.top, 0.1 * sx, 1.505, 0, body);   // straps
  const arms = [];
  for (const [sx, swing] of [[1, -0.6], [-1, 0.65]]) {            // opposite to the legs: right arm back, left forward
    const arm = new THREE.Group(); arm.position.set(0.22 * sx, 1.45, 0); arm.rotation.set(swing, 0, 0.12 * sx); body.add(arm);
    add(new THREE.CapsuleGeometry(0.048, 0.46, 6, 10), M.skin, 0, -0.27, 0, arm);
    add(new THREE.SphereGeometry(0.06, 12, 8), M.skin, 0, -0.55, 0, arm);
    arms.push({ arm, swing });
  }
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), M.skin, 0, 1.53, 0, body);              // neck
  const head = new THREE.Group(); head.position.set(0, 1.71, 0); head.rotation.x = 0.12; body.add(head);   // chin up a bit for the high camera
  add(new THREE.SphereGeometry(0.16, 20, 14), M.skin, 0, 0, 0, head);
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.022, 8, 6), M.eye, 0.055 * sx, 0.01, -0.148, head);
  // hair: a cap over the top and back, side locks to the chin, a few short spikes (the bright red reads from far)
  const hair = new THREE.Group(); hair.name = 'hair'; head.add(hair);
  const cap = add(new THREE.SphereGeometry(0.182, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.58), M.hair, 0, 0.015, 0.012, hair);
  cap.rotation.x = 0.35;                                          // tipped back: forehead free, back of the head covered
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.22, 0.2), M.hair, 0.155 * sx, -0.05, 0.03, hair);
  add(new THREE.BoxGeometry(0.3, 0.2, 0.07), M.hair, 0, -0.06, 0.15, hair);
  const spikes = [[0, 1, -0.3], [0.5, 0.85, -0.1], [-0.5, 0.85, -0.1], [0.3, 0.7, 0.5], [-0.3, 0.7, 0.5], [0, 0.6, 0.8], [0.75, 0.45, 0.35], [-0.75, 0.45, 0.35]];
  for (const [x, y, z] of spikes) {
    const v = new THREE.Vector3(x, y, z).normalize();
    const s = add(new THREE.ConeGeometry(0.05, 0.15, 8), M.hair, v.x * 0.17, v.y * 0.17 + 0.02, v.z * 0.17 + 0.01, hair);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
  }
  g.userData = { mats: [M.hair, M.top, M.pants, M.skin], legs, arms };
  return g;
}

// plain dark door with a light frame (local: the door plane faces -z, at z = 0, bottom on y = 0)
function makeDoor(w, h) {
  const g = new THREE.Group(), f = 0.12;
  const frame = new THREE.MeshLambertMaterial({ color: COL.frame, emissive: COL.frame, emissiveIntensity: 0.08 });
  const door = new THREE.MeshLambertMaterial({ color: COL.door, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), door); panel.rotation.y = Math.PI; panel.position.set(0, h / 2, 0); g.add(panel);
  for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(f, h + f, 0.1), frame); p.position.set(sx * (w + f) / 2, (h + f) / 2, -0.03); g.add(p); }
  const top = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * f, f, 0.1), frame); top.position.set(0, h + f / 2, -0.03); g.add(top);
  return { g, mats: [frame] };
}

// ---------- garden fountain: round stone basin, slim column with a small bowl, a cheap jet (points) ----------
// local frame: centre on the ground, y up. Water drops follow fixed parabolas from the bowl into the basin,
// positions computed from the clock (no physics); ripple rings spread on the basin water.
const JET = { n: 140, up: 1.5, land: 0.95, g: 9.81 };   // drops, apex m above the bowl, landing radius m
function makeFountain(R = 1.5, H = 0.5) {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: COL.stone, emissive: COL.stone, emissiveIntensity: 0.1, side: THREE.DoubleSide });
  const water = new THREE.MeshLambertMaterial({ color: COL.water, emissive: COL.water, emissiveIntensity: 0.18, transparent: true, opacity: 0.88 });
  const r = R - 0.18, wy = H - 0.1;                                 // inner radius, water level
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(R, R + 0.05, H, 40, 1, true), stone); outer.position.y = H / 2; g.add(outer);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 40, 1, true), stone); inner.position.y = H / 2; g.add(inner);
  const rim = new THREE.Mesh(new THREE.RingGeometry(r, R, 40, 1).rotateX(-Math.PI / 2), stone); rim.position.y = H; g.add(rim);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(r, 40).rotateX(-Math.PI / 2), water); pool.position.y = wy; g.add(pool);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 1.0, 16), stone); col.position.y = wy + 0.5; g.add(col);
  const bowlY = wy + 1.05;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.14, 0.18, 24, 1, true), stone); bowl.position.y = bowlY; g.add(bowl);
  const bowlW = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24).rotateX(-Math.PI / 2), water); bowlW.position.y = bowlY + 0.06; g.add(bowlW);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16).rotateX(-Math.PI / 2), stone); bottom.position.y = bowlY - 0.09; g.add(bottom);
  // jet: each drop has an angle and a phase; flight time from the apex height and the fall to the pool
  const y0 = bowlY + 0.12, vy = Math.sqrt(2 * JET.g * JET.up), tUp = vy / JET.g, tDown = Math.sqrt(2 * (y0 + JET.up - wy) / JET.g);
  const T = tUp + tDown, vr = JET.land / T;
  const pos = new Float32Array(JET.n * 3), drops = [];
  for (let i = 0; i < JET.n; i++) drops.push({ a: (i * 2.39996) % (2 * Math.PI), ph: (i / JET.n) * T, k: 0.85 + 0.3 * ((i * 7919) % 100) / 100 });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const jet = new THREE.Points(geo, new THREE.PointsMaterial({ color: COL.spray, size: 0.16, transparent: true, opacity: 0.75, depthWrite: false }));
  jet.frustumCulled = false; g.add(jet);
  const ripples = [0, 1, 2].map((k) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    m.position.y = wy + 0.01; m.userData.ph = k / 3; g.add(m); return m;
  });
  function step(t) {
    for (let i = 0; i < JET.n; i++) {
      const d = drops[i], u = (t + d.ph) % T, rr = vr * d.k * u;
      pos[3 * i] = Math.cos(d.a) * rr; pos[3 * i + 2] = Math.sin(d.a) * rr;
      pos[3 * i + 1] = Math.max(wy, y0 + vy * u - 0.5 * JET.g * u * u);
    }
    geo.attributes.position.needsUpdate = true;
    for (const m of ripples) {
      const u = (t / 2.4 + m.userData.ph) % 1;
      m.scale.setScalar(0.25 + u * (r - 0.1)); m.material.opacity = 0.35 * (1 - u);
    }
  }
  step(0);
  return { g, step, mats: [stone, water] };
}

// ---------- photo group: two costumed "soldiers" and two tourists taking a selfie with them ----------
// Same simple style as the doorway figure (local: faces -z, feet on y = 0, ~2.0 m at scale 1). Plain olive costume,
// peaked cap, belt, boots: no weapons, insignia, flags or text. Tourists in bright casual clothes, one holds a selfie
// stick out in front, the phone at its end turned back toward the group (a tiny flash now and then).
const PG = { olive: '#5d6b3a', oliveDark: '#4b5730', boot: '#2a2420', belt: '#4a3a26', visor: '#1f2418',
             yellow: '#ffd23a', jeans: '#3f5f8f', red: '#e8333d', shorts: '#d9c7a0', pack: '#2b6cff', hat: '#f2e6c8',
             hairDark: '#3a2a20', hairBlond: '#d9b46a', hairBrown: '#6b4a2e', phone: '#16181c', stick: '#222428' };
function makePerson(o) {
  const g = new THREE.Group();
  const mats = [];
  const mat = (c, e = 0.12) => { const m = new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e }); mats.push(m); return m; };
  const M = { top: mat(o.top), sleeve: mat(o.sleeve ?? o.top), pants: mat(o.pants), skin: mat(o.skin, 0.1),
              shoe: new THREE.MeshLambertMaterial({ color: o.shoe ?? COL.shoe }), eye: new THREE.MeshLambertMaterial({ color: COL.eye }), hair: mat(o.hair) };
  const add = (geo, m, x, y, z, parent, sx = 1, sy = 1, sz = 1) => {
    const q = new THREE.Mesh(geo, m); q.position.set(x, y, z); q.scale.set(sx, sy, sz); parent.add(q); return q;
  };
  const body = new THREE.Group(); body.name = 'body'; g.add(body);
  for (const sx of [-1, 1]) {
    if (o.shorts) {   // shorts: short trouser capsule, bare shin
      add(new THREE.CapsuleGeometry(0.08, 0.26, 6, 10), M.pants, 0.1 * sx, 0.72, 0, body);
      add(new THREE.CapsuleGeometry(0.06, 0.38, 6, 10), M.skin, 0.1 * sx, 0.3, 0, body);
    } else add(new THREE.CapsuleGeometry(0.078, 0.68, 6, 12), M.pants, 0.1 * sx, 0.48, 0, body);
    add(new THREE.BoxGeometry(0.13, o.boots ? 0.16 : 0.09, 0.27), M.shoe, 0.1 * sx, o.boots ? 0.08 : 0.045, -0.04, body);
  }
  add(new THREE.CylinderGeometry(0.165, 0.165, 0.16, 16), M.pants, 0, 0.92, 0, body, 1, 1, 0.75);
  add(new THREE.CylinderGeometry(o.jacket ? 0.19 : 0.175, 0.165, 0.56, 16), M.top, 0, 1.24, 0, body, 1, 1, 0.7);
  if (o.belt) add(new THREE.CylinderGeometry(0.172, 0.172, 0.06, 16), mat(PG.belt, 0.05), 0, 1.0, 0, body, 1, 1, 0.72);
  if (o.pack) add(new THREE.BoxGeometry(0.28, 0.34, 0.14), mat(o.pack), 0, 1.25, 0.17, body);
  const arms = {};
  for (const sx of [-1, 1]) {   // arm pivot at the shoulder; pose = [rotation.x (+ = forward), rotation.z (+ = toward +x)]
    const [rx, rz] = (sx < 0 ? o.armL : o.armR) ?? [0, 0.12 * sx];
    const arm = new THREE.Group(); arm.position.set(0.23 * sx, 1.46, 0); arm.rotation.set(rx, 0, rz); body.add(arm);
    if (o.shortSleeve) {
      add(new THREE.CapsuleGeometry(0.056, 0.14, 6, 10), M.sleeve, 0, -0.1, 0, arm);
      add(new THREE.CapsuleGeometry(0.046, 0.34, 6, 10), M.skin, 0, -0.33, 0, arm);
    } else add(new THREE.CapsuleGeometry(0.055, 0.46, 6, 10), M.sleeve, 0, -0.27, 0, arm);
    add(new THREE.SphereGeometry(0.06, 12, 8), M.skin, 0, -0.56, 0, arm);
    arms[sx < 0 ? 'L' : 'R'] = arm;
  }
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), M.skin, 0, 1.53, 0, body);
  const head = new THREE.Group(); head.position.set(0, 1.71, 0); head.rotation.x = 0.1; body.add(head);
  add(new THREE.SphereGeometry(0.16, 20, 14), M.skin, 0, 0, 0, head);
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.022, 8, 6), M.eye, 0.055 * sx, 0.01, -0.148, head);
  const cap = add(new THREE.SphereGeometry(0.168, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hair, 0, 0.01, 0.01, head);
  cap.rotation.x = 0.3;
  if (o.cap) {   // peaked cap: band, wide flat top, dark visor (plain: no badge)
    const c = mat(PG.oliveDark, 0.08);
    add(new THREE.CylinderGeometry(0.172, 0.168, 0.09, 20), c, 0, 0.12, 0, head);
    add(new THREE.CylinderGeometry(0.205, 0.18, 0.06, 20), c, 0, 0.19, 0.01, head, 1, 1, 1.08);
    const v = add(new THREE.BoxGeometry(0.24, 0.02, 0.12), new THREE.MeshLambertMaterial({ color: PG.visor }), 0, 0.09, -0.17, head);
    v.rotation.x = 0.25;
  }
  if (o.sunhat) {
    const h = mat(PG.hat, 0.12);
    add(new THREE.CylinderGeometry(0.3, 0.3, 0.025, 24), h, 0, 0.1, 0, head);
    add(new THREE.CylinderGeometry(0.15, 0.17, 0.13, 20), h, 0, 0.17, 0, head);
  }
  g.userData = { mats, arms, body };
  return g;
}
function makePhotoGroup(scale) {
  const g = new THREE.Group(), people = [];
  const skins = ['#e8b894', '#f2c8a6', '#c99a74', '#8d5e3c'];
  // left to right seen from the front (local -x .. +x is the group's right .. left, we build in local x)
  const spec = [
    { x: -1.15, z: -0.18, top: PG.olive, pants: PG.olive, skin: skins[0], hair: PG.hairBrown, boots: true, shoe: PG.boot, belt: true, jacket: true, cap: true,
      armL: [0, -2.55], armR: [0.15, 0.95], wave: 'L' },                                   // soldier: waves, other arm toward the tourist
    { x: -0.4, z: 0, top: PG.yellow, pants: PG.jeans, skin: skins[1], hair: PG.hairBlond, jacket: true, pack: PG.red,
      armL: [0.1, -0.15], armR: [1.95, 0.35], selfie: true },                              // tourist in a yellow rain jacket, selfie stick
    { x: 0.4, z: 0, top: PG.red, pants: PG.shorts, skin: skins[2], hair: PG.hairDark, shortSleeve: true, shorts: true, sunhat: true,
      armL: [0.2, -0.4], armR: [2.35, 0.15], peace: true },                                // tourist in a red T-shirt, peace sign
    { x: 1.15, z: -0.18, top: PG.olive, pants: PG.olive, skin: skins[3], hair: PG.hairDark, boots: true, shoe: PG.boot, belt: true, jacket: true, cap: true,
      armL: [0.15, -0.95], armR: [1.45, 0.05], thumb: true },                              // soldier: arm toward the tourist, thumbs up
  ];
  let phone = null, flash = null;
  for (const o of spec) {
    const p = makePerson(o); p.position.set(o.x, 0, o.z); p.rotation.y = Math.atan2(o.x, 3.2) * 0.6;   // turned a little toward the phone (in front of the middle)
    g.add(p); people.push({ p, o, body: p.userData.body, arm: o.wave ? p.userData.arms[o.wave] : null });
    const skinM = new THREE.MeshLambertMaterial({ color: o.skin, emissive: o.skin, emissiveIntensity: 0.1 }); p.userData.mats.push(skinM);
    if (o.selfie) {   // stick continues the arm 1 m; the phone at its end, turned back to the group
      const arm = p.userData.arms.R;
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.0, 8), new THREE.MeshLambertMaterial({ color: PG.stick }));
      st.position.set(0, -1.06, 0); arm.add(st);
      phone = new THREE.Group(); phone.position.set(0, -1.58, 0); phone.rotation.set(-1.95, 0, 0); arm.add(phone);
      phone.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.014), new THREE.MeshLambertMaterial({ color: PG.phone })));
      flash = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      flash.position.set(0, 0.04, 0.03); flash.scale.setScalar(0.45); phone.add(flash);
    }
    if (o.peace || o.thumb) {   // two raised fingers / a thumb at the hand
      const arm = p.userData.arms.R;
      for (const dx of o.peace ? [-0.025, 0.025] : [0]) {
        const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.07, 4, 6), skinM); f.position.set(dx, -0.64, 0); f.rotation.z = dx * 6; arm.add(f);
      }
    }
  }
  g.scale.setScalar(scale);
  return { g, people, flash, mats: people.flatMap((q) => q.p.userData.mats) };
}

// ---------- watcher: a lone window high in a blank wall, a man in a trench coat with binoculars in it ----------
// local frame: the window plane is local x-y, centre at the origin, outside = -z (the group sits a few cm in front
// of the wall). Dark recess + light frame and sill, a warm room light behind him, and a flat, stylised figure in flat
// colours (self-lit, reads at a glance): beige trench coat with darker lapels, belt and turned-up collar, a charcoal
// brimmed hat, a skin-tone hint of face, binoculars held to the eyes with both hands, objective lenses facing out
// with a faint cool reflection that flares now and then. Turns a little toward the car; steps back only when the
// car stops right below the wall.
const WATCH = { near: 15, far: 15, stay: 3.0, back: 8, fade: 1.5, range: 250, turn: 0.26, gain: 0.6 };
const WCOL = { coat: '#b9a37a', coatDark: '#9c8660', belt: '#86704b', collar: '#a8915f', sleeve: '#ad976d', hat: '#45474d',
               brim: '#3b3d42', band: '#2a2b2f', skin: '#e2b48f', bino: '#25272c', binoRim: '#5d626b', lens: '#10203a', glint: '#d6e6ff' };
function flatShape(pts) { const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) sh.lineTo(p[0], p[1]); return new THREE.ShapeGeometry(sh); }
function makeWatcher(w, h, strength, depth = 0.1) {   // depth: m from the window plane back to the wall (the frame closes the gap)
  const g = new THREE.Group();
  const basic = (c, o = 1, extra = {}) => new THREE.MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthWrite: o >= 1, ...extra });
  const frameM = new THREE.MeshLambertMaterial({ color: '#d8d4cc', emissive: '#d8d4cc', emissiveIntensity: 0.2 });
  const f = 0.1;
  const box = (bw, bh, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, depth + 0.06), frameM); m.position.set(x, y, (depth - 0.06) / 2); g.add(m); };   // reaches back into the wall
  box(w + 2 * f, f, 0, h / 2 + f / 2); box(w + 2 * f, f, 0, -h / 2 - f / 2); box(f, h, -w / 2 - f / 2, 0); box(f, h, w / 2 + f / 2, 0);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.07, 0.18), frameM); sill.position.set(0, -h / 2 - f - 0.035, -0.09); g.add(sill);
  const rec = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic('#1a130d')); rec.rotation.y = Math.PI; rec.position.z = -0.01; g.add(rec);
  // warm room light: lights him from behind (a bright halo around the figure), stronger at night / moon
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const cx = c.getContext('2d'), gr = cx.createRadialGradient(32, 26, 3, 32, 32, 34);
  gr.addColorStop(0, 'rgba(255,205,140,1)'); gr.addColorStop(0.55, 'rgba(255,170,95,0.55)'); gr.addColorStop(1, 'rgba(255,150,80,0)');
  cx.fillStyle = gr; cx.fillRect(0, 0, 64, 64);
  const glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  const room = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic('#ffffff', Math.min(1, 0.5 * strength), { map: glowTex, blending: THREE.AdditiveBlending }));
  room.rotation.y = Math.PI; room.position.set(0, 0, -0.015); g.add(room);
  // the man: flat shapes in window metres (drawn for a 2.4 m high window), turned to face -z
  const man = new THREE.Group(); man.position.z = -0.025; g.add(man);
  const fig = new THREE.Group(); fig.rotation.y = Math.PI; fig.scale.setScalar(h / 2.4); man.add(fig);
  const mats = [];
  const M = (col) => { const m = basic(col, 1, { transparent: true, side: THREE.DoubleSide }); mats.push(m); return m; };
  const S = (pts, col, z) => { const m = new THREE.Mesh(flatShape(pts), M(col)); m.position.z = z; fig.add(m); return m; };
  const mirror = (pts) => pts.map(([x, y]) => [-x, y]);
  const C = (r, col, x, y, z, seg = 24) => { const m = new THREE.Mesh(new THREE.CircleGeometry(r, seg), M(col)); m.position.set(x, y, z); fig.add(m); return m; };
  // coat (upper body fills the lower half), lapels, belt, turned-up collar
  S([[-0.78, -1.2], [0.78, -1.2], [0.72, -0.45], [0.46, -0.22], [0.18, -0.12], [-0.18, -0.12], [-0.46, -0.22], [-0.72, -0.45]], WCOL.coat, 0);
  const lapel = [[-0.18, -0.12], [0.0, -0.72], [-0.34, -0.32]];
  S(lapel, WCOL.coatDark, 0.002); S(mirror(lapel), WCOL.coatDark, 0.002);
  S([[-0.74, -1.0], [0.74, -1.0], [0.74, -0.92], [-0.74, -0.92]], WCOL.belt, 0.003);
  const collar = [[-0.34, -0.26], [-0.15, 0.1], [-0.08, -0.13]];
  S(collar, WCOL.collar, 0.004); S(mirror(collar), WCOL.collar, 0.004);
  C(0.17, WCOL.skin, 0, 0.1, 0.001);                                                         // face (no features)
  // hat: charcoal brim, crown, band
  S([[-0.37, 0.25], [0.37, 0.25], [0.37, 0.31], [-0.37, 0.31]], WCOL.brim, 0.009);
  S([[-0.21, 0.31], [0.21, 0.31], [0.19, 0.53], [0.0, 0.57], [-0.19, 0.53]], WCOL.hat, 0.009);
  S([[-0.21, 0.31], [0.21, 0.31], [0.21, 0.36], [-0.21, 0.36]], WCOL.band, 0.01);
  // sleeves up from the shoulders to the glasses, hands on the barrels
  const sleeve = [[-0.6, -0.4], [-0.4, -0.52], [-0.17, 0.0], [-0.33, 0.1]];
  S(sleeve, WCOL.sleeve, 0.005); S(mirror(sleeve), WCOL.sleeve, 0.005);
  // binoculars: two barrels (0.46 m pair) with a bridge, objective lenses facing out, rims, a cool reflection
  const glints = [];
  S([[-0.06, 0.08], [0.06, 0.08], [0.06, 0.16], [-0.06, 0.16]], WCOL.bino, 0.006);
  for (const sx of [-1, 1]) {
    const bx = 0.125 * sx;
    S([[bx - 0.105, 0.0], [bx + 0.105, 0.0], [bx + 0.105, 0.24], [bx - 0.105, 0.24]], WCOL.bino, 0.007);
    C(0.088, WCOL.binoRim, bx, 0.12, 0.008);
    C(0.07, WCOL.lens, bx, 0.12, 0.009);
    C(0.075, WCOL.skin, bx + 0.07 * sx, 0.015, 0.011, 16).scale.set(0.9, 0.6, 1);           // hand on the barrel
    const gm = basic(WCOL.glint, 0.3, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const gl = new THREE.Mesh(new THREE.CircleGeometry(0.034, 12), gm); gl.position.set(bx - 0.025, 0.145, 0.012); fig.add(gl); glints.push(gm);
  }
  return { g, man, mats, glints, room, strength };
}

// ---------- hint frame: a thin green outline of an entrance, hinting at an unfound bear behind it ----------
// local frame: the opening's plane is local x-y, outside = -z, bottom centre on y = 0. Two verticals, a top bar
// and a faint ground line across the threshold; each a thin core line plus a wider, fainter glow line.
// Unlit (MeshBasic), depth-tested (buildings hide it), no depth write, no collider, no userData.world.
const HINT = { color: '#1fbf6a', line: 0.15, glow: 0.5, core: 0.55, halo: 0.16, ground: 0.6, breathe: 0.15, period: 4.0 };
function makeHintFrame(w, h, strength = 1) {
  const g = new THREE.Group(), mats = [];
  const mat = (o) => { const m = new THREE.MeshBasicMaterial({ color: HINT.color, transparent: true, opacity: o, depthWrite: false });
                       m.userData.base = o; mats.push(m); return m; };
  const core = mat(HINT.core * strength), halo = mat(HINT.halo * strength);
  const groundCore = mat(HINT.core * HINT.ground * strength), groundHalo = mat(HINT.halo * HINT.ground * strength);
  const bar = (len, t, m, x, y, vertical) => {
    const geo = vertical ? new THREE.BoxGeometry(t, len, t * 0.6) : new THREE.BoxGeometry(len, t, t * 0.6);
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, 0); o.renderOrder = 2; g.add(o);
  };
  for (const [t, m] of [[HINT.line, core], [HINT.glow, halo]]) {
    for (const sx of [-1, 1]) bar(h, t, m, sx * w / 2, h / 2, true);
    bar(w + t, t, m, 0, h, false);
  }
  for (const [t, m] of [[HINT.line, groundCore], [HINT.glow, groundHalo]]) {   // flat on the ground across the threshold
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, t), m); o.position.set(0, 0.06, -0.1); o.renderOrder = 2; g.add(o);
  }
  return { g, mats };
}

export async function createDoorway({ root, base, groundAt, groundY = groundAt, emissiveBoost = 0, isFound = () => false }) {
  let data;
  try { const r = await fetch(base + 'doorway.json'); if (!r.ok) return null; data = await r.json(); } catch { return null; }
  const items = data.items || [];
  const figs = items.filter((it) => (it.kind ?? 'doorway') === 'doorway').map((it) => {
    const grp = new THREE.Group(); grp.name = 'doorway:' + it.id;
    grp.position.set(it.x, groundAt(it.x, it.z), it.z);
    grp.rotation.y = -it.heading;                                  // local -z -> (sin h, -cos h)
    const fig = makeFigure(); fig.scale.setScalar((it.height ?? 2.0) / 2.0); grp.add(fig);
    const mats = [...fig.userData.mats];
    if (it.door) {
      const d = makeDoor(it.door.width ?? 1.4, it.door.height ?? 2.6);
      d.g.position.z = it.door.back ?? 0.4; grp.add(d.g); mats.push(...d.mats);   // behind her (+z = toward the house)
    }
    for (const m of mats) m.emissiveIntensity += 0.6 * emissiveBoost;
    root.add(grp);
    return { it, grp, fig, body: fig.getObjectByName('body'), hair: fig.getObjectByName('hair'), t: Math.random() * 10, probeT: 9 };
  });
  const founts = items.filter((it) => it.kind === 'fountain').map((it) => {
    const f = makeFountain(it.radius ?? 1.5, it.height ?? 0.5);
    f.g.name = 'fountain:' + it.id; f.g.position.set(it.x, groundAt(it.x, it.z), it.z);
    for (const m of f.mats) m.emissiveIntensity += 0.5 * emissiveBoost;
    root.add(f.g);
    return { it, ...f, t: 0, probeT: 9 };
  });
  const hints = items.filter((it) => it.kind === 'hint-frame').map((it) => {
    const f = makeHintFrame(it.width ?? 3.5, it.height ?? 3.5, 1 + 0.8 * emissiveBoost);   // night / moon: a bit stronger
    f.g.name = 'hint:' + it.id; f.g.position.set(it.x, groundAt(it.x, it.z), it.z);
    f.g.rotation.y = -it.heading;                                   // local -z -> heading (out of the opening)
    root.add(f.g);
    return { it, ...f, t: 0, probeT: 9 };
  });
  const groups = items.filter((it) => it.kind === 'photo-group').map((it) => {
    const f = makePhotoGroup((it.height ?? 2.4) / 2.0);
    f.g.name = 'photo:' + it.id; f.g.position.set(it.x, groundAt(it.x, it.z), it.z);
    f.g.rotation.y = -(it.heading ?? 0);                            // the row faces heading
    for (const m of f.mats) m.emissiveIntensity += 0.6 * emissiveBoost;
    root.add(f.g);
    return { it, ...f, t: Math.random() * 10, probeT: 9, nextShot: 3 + Math.random() * 4, flashT: 0 };
  });
  const watchers = items.filter((it) => it.kind === 'watcher').map((it) => {
    const strength = 1 + 0.9 * emissiveBoost;                       // night / moon: room light and glints a little stronger
    const off = it.out ?? 0;                                        // window plane this far in front of the wall line: the streamed
    const f = makeWatcher(it.width ?? 2.2, it.height ?? 2.4, strength, off + 0.3);   // LODs bulge out (frame reaches back into the wall)
    f.g.name = 'watcher:' + it.id; f.g.rotation.y = -it.heading;   // local -z -> out of the wall
    f.g.position.set(it.x + off * Math.sin(it.heading), it.yAbs ?? groundAt(it.x, it.z) + it.y, it.z - off * Math.cos(it.heading));   // yAbs: measured on the mesh (world height)
    root.add(f.g);
    return { it, ...f, state: 'there', a: 1, closeT: 0, awayT: 0, glintT: 8 + Math.random() * 7, glint: 0, probeT: 9, yaw: 0, ground: null };
  });
  if (!figs.length && !founts.length && !hints.length && !groups.length && !watchers.length) return null;

  function update(dt, car) {
    if (!car || !dt) return;
    for (const f of watchers) {
      const d = Math.hypot(f.it.x - car.x, f.it.z - car.z);
      if (d > WATCH.range) { f.state = 'there'; f.a = 1; continue; }   // far away: back at his post, nothing to update
      if (f.it.yAbs == null && (f.probeT += dt) > 1 && f.ground == null && d < 120) { f.probeT = 0; f.ground = groundY(f.it.x + 2 * Math.sin(f.it.heading), f.it.z - 2 * Math.cos(f.it.heading)); f.g.position.y = f.ground + f.it.y; }   // street in front of the wall, once
      // hide and return: car right below the wall (< near) for `stay` s -> he steps back (fade); back once the car was beyond `far` for `back` s
      if (f.state === 'there') { f.closeT = d < WATCH.near ? f.closeT + dt : 0; if (f.closeT > WATCH.stay) f.state = 'leaving'; }
      else if (f.state === 'gone') { f.awayT = d > WATCH.far ? f.awayT + dt : 0; if (f.awayT > WATCH.back) { f.state = 'returning'; f.awayT = 0; } }
      if (f.state === 'leaving' && (f.a -= dt / WATCH.fade) <= 0) { f.a = 0; f.state = 'gone'; }
      if (f.state === 'returning' && (f.a += dt / WATCH.fade) >= 1) { f.a = 1; f.state = 'there'; f.closeT = 0; }
      f.man.visible = f.a > 0.01;
      for (const m of f.mats) m.opacity = f.a;
      // follows the car slowly with the glasses: a few degrees of turn toward it (in the wall's frame)
      const h = f.it.heading, rx = car.x - f.it.x, rz = car.z - f.it.z;
      const side = rx * Math.cos(h) + rz * Math.sin(h), out = rx * Math.sin(h) - rz * Math.cos(h);
      const want = Math.max(-WATCH.turn, Math.min(WATCH.turn, Math.atan2(side, Math.max(out, 1)) * WATCH.gain));
      f.yaw += (want - f.yaw) * Math.min(1, 0.6 * dt); f.man.rotation.y = -f.yaw; f.man.position.x = 0.12 * f.yaw / WATCH.turn;
      // lens glint: faint, flares briefly every 8-15 s
      if ((f.glintT -= dt) <= 0) { f.glint = 0.35; f.glintT = 8 + Math.random() * 7; }
      f.glint = Math.max(0, f.glint - dt);
      const gl = (0.3 + 2.0 * f.glint) * f.strength * f.a;   // always faintly visible, flares
      for (const m of f.glints) m.opacity = Math.min(1, gl);
    }
    for (const f of groups) {
      if (Math.hypot(f.it.x - car.x, f.it.z - car.z) > NEAR) continue;
      if ((f.probeT += dt) > 1) { f.probeT = 0; f.g.position.y = groundY(f.it.x, f.it.z); }
      const t = (f.t += dt);
      f.people.forEach((q, k) => {   // slow sway / small bounce, each a little out of step; the waving arm moves a little
        q.body.rotation.z = 0.025 * Math.sin(t * 1.1 + k * 1.7);
        q.body.position.y = 0.012 * (1 + Math.sin(t * 2.0 + k));
        if (q.arm) q.arm.rotation.z = -2.55 + 0.22 * Math.sin(t * 3.2);
      });
      if (f.flashT > 0) { f.flashT -= dt; f.flash.material.opacity = f.flashT > 0 ? 1 : 0; }
      else if ((f.nextShot -= dt) <= 0) { f.flashT = 0.07; f.nextShot = 6 + Math.random() * 4; }   // the picture: a flash of two or three frames
    }
    for (const f of hints) {   // shown only while its bear is unfound (eggs.js found set: also after a reset)
      f.g.visible = !(f.it.bear && isFound(f.it.bear));
      if (!f.g.visible || Math.hypot(f.it.x - car.x, f.it.z - car.z) > NEAR) continue;
      if ((f.probeT += dt) > 1) { f.probeT = 0; f.g.position.y = groundY(f.it.x, f.it.z); }
      const k = 1 + HINT.breathe * Math.sin((f.t += dt) * 2 * Math.PI / HINT.period);   // very slow breathing
      for (const m of f.mats) m.opacity = m.userData.base * k;
    }
    for (const f of founts) {
      if (Math.hypot(f.it.x - car.x, f.it.z - car.z) > NEAR) continue;
      if ((f.probeT += dt) > 1) { f.probeT = 0; f.g.position.y = groundY(f.it.x, f.it.z); }
      f.step((f.t += dt));
    }
    for (const f of figs) {
      if (Math.hypot(f.it.x - car.x, f.it.z - car.z) > NEAR) continue;
      if ((f.probeT += dt) > 1) { f.probeT = 0; f.grp.position.y = groundY(f.it.x, f.it.z); }   // feet on the streamed mesh
      const t = (f.t += dt);
      // ready to go: a small springy bounce on the spot, limbs rocking with it, hair swaying
      const b = Math.abs(Math.sin(t * 2.4));
      f.body.position.y = -0.05 + 0.035 * b;
      f.body.rotation.x = -0.1 - 0.03 * b;
      const k = 0.08 * Math.sin(t * 2.4);
      for (const { leg, swing } of f.fig.userData.legs) leg.rotation.x = swing * (1 + k);
      for (const { arm, swing } of f.fig.userData.arms) arm.rotation.x = swing * (1 + 1.5 * k);
      f.hair.rotation.z = 0.06 * Math.sin(t * 1.3);
      f.hair.rotation.x = 0.04 * Math.sin(t * 2.4 + 0.8);
    }
  }
  return { update, items: () => items };
}

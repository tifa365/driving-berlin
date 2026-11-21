// Two decorations fixed to real buildings (levels/<name>/sights.json, build_sights.py); no colliders.
//   clock: the national debt clock over the entrance of Reinhardtstrasse 52: a black panel with red
//          seven-segment LED digits that count up (value = base + rate * seconds since `at`; small
//          row: euros per second and per inhabitant). Digits only, no words, no logo.
//   nest : a stork's nest on the roof of Charitestrasse 3 with two white storks (head turning,
//          now and then the head thrown back for a beak clatter; no sound).
// Both stay in the scene; the digits are redrawn (CLOCK_HZ) and the storks move only while the car
// is within NEAR m. Mood: body materials go through mood.gradeMaterial (as js/eggs.js does for its
// unlit materials: the grade lights them like the mesh, fog included); the LED digits are never
// graded (they glow at night), the moon mood adds a soft red halo.
//   const sights = await createSights({ scene, base, mood });   // null when sights.json is missing
//   sights.update(dt, carX, carZ);                                // every frame
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const NEAR = 200;          // m: animate / redraw only while the car is this close
const CLOCK_HZ = 8;        // digit redraws per second
const CW = 1024;           // clock canvas width (height from the panel's aspect)
const LIGHT = new THREE.Vector3(-0.4, 1, 0.5).normalize();

// parts [[geometry, colour], ...] -> one non-indexed geometry with per-vertex colours; `bake`:
// flat face shading baked in (no mood: the objects need no scene lights)
function merged(parts, bake) {
  const geos = parts.map(([g0, col]) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.computeVertexNormals();
    const p = g.attributes.position, nrm = g.attributes.normal, n = p.count, a = new Float32Array(n * 3);
    const c = new THREE.Color(col), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const k = bake ? 0.62 + 0.38 * Math.max(0, v.fromBufferAttribute(nrm, i).dot(LIGHT)) : 1;
      a.set([c.r * k, c.g * k, c.b * k], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  });
  return mergeGeometries(geos);
}

// ---------- seven-segment drawing ----------
// segments a..g of each digit (on = 1)
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', ' ': '' };
function segPath(ctx, s, x, y, w, h, t) {
  // one bar as a hexagon; x, y = top left of the digit cell, w x h digit, t bar thickness
  const sl = 0.08 * h;   // italic slant (LED clocks lean a little)
  const P = (px, py) => [x + px + sl * (1 - py / h), y + py];
  const hb = (x0, x1, yc) => [P(x0, yc), P(x0 + t / 2, yc - t / 2), P(x1 - t / 2, yc - t / 2), P(x1, yc), P(x1 - t / 2, yc + t / 2), P(x0 + t / 2, yc + t / 2)];
  const vb = (xc, y0, y1) => [P(xc, y0), P(xc + t / 2, y0 + t / 2), P(xc + t / 2, y1 - t / 2), P(xc, y1), P(xc - t / 2, y1 - t / 2), P(xc - t / 2, y0 + t / 2)];
  const g = 0.06 * t, m = h / 2;
  const poly = { a: hb(t / 2 + g, w - t / 2 - g, t / 2), g: hb(t / 2 + g, w - t / 2 - g, m), d: hb(t / 2 + g, w - t / 2 - g, h - t / 2),
                 f: vb(t / 2, t / 2 + g, m - g), b: vb(w - t / 2, t / 2 + g, m - g), e: vb(t / 2, m + g, h - t / 2 - g), c: vb(w - t / 2, m + g, h - t / 2 - g) }[s];
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
}
// a number with thousands dots, right-aligned in [x0, x1] or left-aligned at x0 (align 'left')
function drawNumber(ctx, value, digits, x0, x1, y, h, on, off, align = 'right') {
  const s = Math.max(0, Math.floor(value)).toString().padStart(digits, ' ').slice(-digits);
  const groups = Math.floor((digits - 1) / 3);
  const dotW = 0.32 * h * 0.62, pitch = align === 'right' ? (x1 - x0 - groups * dotW) / digits : 0.62 * h + 0.16 * h;
  const w = pitch * 0.8, t = Math.min(w * 0.22, h * 0.13);
  let x = x0;
  const lit = [], dark = [], dots = [];
  for (let i = 0; i < digits; i++) {
    const ch = s[i];
    for (const seg of 'abcdefg') (SEG[ch].includes(seg) ? lit : dark).push([seg, x, w]);
    x += pitch;
    const rem = digits - 1 - i;
    if (rem > 0 && rem % 3 === 0) { dots.push([x - pitch * 0.1 + dotW * 0.25, ch !== ' ']); x += dotW; }
  }
  ctx.beginPath(); for (const [seg, xx, ww] of dark) segPath(ctx, seg, xx, y, ww, h, t);
  for (const [dx, l] of dots) if (!l) ctx.rect(dx, y + h - t, t, t);
  ctx.fillStyle = off; ctx.fill();
  ctx.save(); ctx.shadowColor = 'rgba(255,40,20,0.9)'; ctx.shadowBlur = t * 0.9;
  ctx.beginPath(); for (const [seg, xx, ww] of lit) segPath(ctx, seg, xx, y, ww, h, t);
  for (const [dx, l] of dots) if (l) ctx.rect(dx, y + h - t, t, t);
  ctx.fillStyle = on; ctx.fill(); ctx.restore();
}

function makeClock(C, mat, bake, night) {
  const W = C.width, H = C.height;
  const g = new THREE.Group(); g.name = 'debtClock';
  g.position.set(C.x, C.y, C.z);
  g.rotation.y = Math.PI - C.heading;              // local +Z = facing (heading clockwise from north)
  const tilt = new THREE.Group(); tilt.rotation.x = -THREE.MathUtils.degToRad(C.tilt || 0); g.add(tilt);
  const D = 0.14, back = Math.max(0.2, Math.min(1.5, C.back ?? 0.5));
  const parts = [[new THREE.BoxGeometry(W, H, D), 0x101012],                                  // panel
                 [new THREE.BoxGeometry(W + 0.08, 0.06, D + 0.04).translate(0, H / 2, 0), 0x2a2a2e],   // thin frame top / bottom
                 [new THREE.BoxGeometry(W + 0.08, 0.06, D + 0.04).translate(0, -H / 2, 0), 0x2a2a2e]];
  for (const sx of [-0.35, 0.35]) parts.push([new THREE.BoxGeometry(0.1, 0.1, back).translate(sx * W, H * 0.3, -D / 2 - back / 2), 0x1a1a1c]);   // brackets to the facade
  const body = new THREE.Mesh(merged(parts, bake), mat); tilt.add(body);
  // digit face: canvas texture, unlit and ungraded (LEDs glow)
  const cv = document.createElement('canvas'); cv.width = CW; cv.height = Math.round(CW * H / W);
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.06, H - 0.1),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  face.position.z = D / 2 + 0.005; tilt.add(face);
  if (night) {   // soft red halo on the facade around the panel
    const hc = document.createElement('canvas'); hc.width = hc.height = 64;
    const hx = hc.getContext('2d'), gr = hx.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,40,25,0.55)'); gr.addColorStop(1, 'rgba(255,40,25,0)');
    hx.fillStyle = gr; hx.fillRect(0, 0, 64, 64);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.5, H * 3.2), new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(hc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    halo.position.z = D / 2 + 0.02; halo.renderOrder = 2; tilt.add(halo);
  }
  const N = C.numbers, t0 = Date.parse(N.at), pop = N.base / N.perCapita;
  const value = () => N.base + N.rate * (Date.now() - t0) / 1000;
  function draw() {
    const w = cv.width, h = cv.height, px = w / W;   // px per metre
    ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, w, h);
    const on = '#ff2a18', off = '#2a0806';
    const v = value();
    const mx = 0.14 * px;
    drawNumber(ctx, v, 13, mx, w - mx, 0.1 * px, 0.72 * H * px * 0.74, on, off);             // big row
    const sh = 0.24 * H * px * 0.95, sy = h - sh - 0.08 * px;
    drawNumber(ctx, N.rate, 4, 0.55 * px, 0, sy, sh, on, off, 'left');                         // euros per second
    drawNumber(ctx, v / pop, 5, 0.42 * W * px, 0, sy, sh, on, off, 'left');                    // euros per inhabitant
    tex.needsUpdate = true;
  }
  draw();
  let acc = 0;
  return { group: g, update(dt) { acc += dt; if (acc >= 1 / CLOCK_HZ) { acc = 0; draw(); } } };
}

// ---------- the stork's nest ----------
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function makeNest(R, rand) {
  const parts = [];
  const rim = new THREE.TorusGeometry(R - 0.28, 0.3, 7, 22).rotateX(Math.PI / 2).scale(1, 0.5, 1).translate(0, 0.2, 0);
  const p = rim.attributes.position;   // rough rim: jitter
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (rand() - 0.5) * 0.09, p.getY(i) + (rand() - 0.5) * 0.08, p.getZ(i) + (rand() - 0.5) * 0.09);
  parts.push([rim, 0x4a3320]);
  parts.push([new THREE.CylinderGeometry(R - 0.3, R - 0.45, 0.22, 16).translate(0, 0.12, 0), 0x3a2817]);   // bowl
  for (let k = 0; k < 34; k++) {   // twigs sticking out of the rim
    const a = (k / 34) * Math.PI * 2 + rand() * 0.2, len = 0.5 + rand() * 0.5;
    const tw = new THREE.CylinderGeometry(0.018, 0.025, len, 3).rotateZ(Math.PI / 2 + (rand() - 0.5) * 0.6)
      .rotateY(-a + (rand() - 0.5) * 1.2).translate(Math.cos(a) * (R - 0.15), 0.18 + rand() * 0.2, Math.sin(a) * (R - 0.15));
    parts.push([tw, rand() < 0.5 ? 0x5c4229 : 0x6b4f33]);
  }
  return parts;
}

// a stork 1 m tall facing +Z (scaled by the caller); neck = pivot group for the head animation
function makeStork(matOf, bake) {
  const W = 0xf4f4f0, BLK = 0x151515, RED = 0xd8361f;
  const g = new THREE.Group();
  const body = [
    [new THREE.SphereGeometry(1, 10, 7).scale(0.15, 0.14, 0.3).rotateX(-0.25).translate(0, 0.6, -0.02), W],
    [new THREE.SphereGeometry(1, 8, 6).scale(0.07, 0.11, 0.27).rotateX(-0.2).translate(0.13, 0.58, -0.09), BLK],    // wings: black flight feathers
    [new THREE.SphereGeometry(1, 8, 6).scale(0.07, 0.11, 0.27).rotateX(-0.2).translate(-0.13, 0.58, -0.09), BLK],
    [new THREE.SphereGeometry(1, 8, 6).scale(0.1, 0.08, 0.2).rotateX(-0.2).translate(0.09, 0.65, 0.03), W],         // white wing coverts
    [new THREE.SphereGeometry(1, 8, 6).scale(0.1, 0.08, 0.2).rotateX(-0.2).translate(-0.09, 0.65, 0.03), W],
    [new THREE.ConeGeometry(0.07, 0.16, 6).rotateX(-Math.PI / 2 - 0.3).translate(0, 0.62, -0.34), W],               // tail
  ];
  for (const sx of [-0.05, 0.05]) {
    body.push([new THREE.CylinderGeometry(0.014, 0.014, 0.5, 5).translate(sx, 0.25, 0), RED]);                     // legs
    body.push([new THREE.BoxGeometry(0.05, 0.015, 0.12).translate(sx, 0.008, 0.03), RED]);                          // feet
  }
  g.add(new THREE.Mesh(merged(body, bake), matOf()));
  const neck = new THREE.Group(); neck.position.set(0, 0.68, 0.2); g.add(neck);   // base of the neck
  const nk = [[new THREE.CylinderGeometry(0.04, 0.055, 0.3, 7).translate(0, 0.15, 0).rotateX(0.25), W],
              [new THREE.SphereGeometry(0.06, 8, 6).scale(1, 0.95, 1.2).translate(0, 0.3, 0.07), W]];
  neck.add(new THREE.Mesh(merged(nk, bake), matOf()));
  const beakU = new THREE.Mesh(merged([[new THREE.ConeGeometry(0.022, 0.24, 6).rotateX(Math.PI / 2).translate(0, 0.006, 0.12), RED]], bake), matOf());
  const beakL = new THREE.Mesh(merged([[new THREE.ConeGeometry(0.018, 0.22, 6).rotateX(Math.PI / 2).translate(0, -0.006, 0.11), RED]], bake), matOf());
  for (const b of [beakU, beakL]) { b.position.set(0, 0.29, 0.13); neck.add(b); }
  return { group: g, neck, beakL };
}

// ---------- Berlinale: red carpet, stanchions with ropes, crowd barriers, banner ----------
// B = sights.json `berlinale`: carpet {x, z, width, length, step, y[]} starts at the door and runs along
// heading; banner {x, y, z, heading, width, height, tilt, text, hang?} (hang: canopy edge height, cables up to it).
// Our own plain banner: the word only, white on deep red, in the bundled sign font (no festival logo).
function glowTexture(rgba0, rgba1) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, rgba0); gr.addColorStop(1, rgba1); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeBerlinale(B, matOf, bake, night, mood) {
  const C = B.carpet, hw = C.width / 2, L = C.length, h = B.heading;
  const fx = Math.sin(h), fz = -Math.cos(h);          // along the carpet (out from the door)
  const rx = -fz, rz = fx;                             // across (right of the carpet seen from the door)
  const yAt = (s) => {                                 // ground profile (1 m steps), linear
    const k = Math.max(0, Math.min(C.y.length - 1, s / C.step)), i = Math.min(C.y.length - 2, Math.floor(k));
    return C.y[i] + (C.y[i + 1] - C.y[i]) * (k - i);
  };
  const P = (s, u, dy = 0) => new THREE.Vector3(C.x + fx * s + rx * u, yAt(s) + dy, C.z + fz * s + rz * u);
  const g = new THREE.Group(); g.name = 'berlinale';

  // carpet: ONE strip with shared vertices along a perfectly straight line (sights.json: heights = a fitted straight
  // line, carpet only where the whole width is open), lifted 9 cm + polygon offset; columns -hw, -hw+.22, hw-.22, hw
  // (darker edges), a dark hem across each end
  const LIFT = 0.09;
  const strip = (s0, s1, us, cols, lift) => {
    const ns = Math.max(1, Math.ceil((s1 - s0) / 2)), pos = [], col = [], idx = [], nu = us.length;
    for (let k = 0; k <= ns; k++) for (let j = 0; j < nu; j++) {
      const p = P(s0 + (s1 - s0) * k / ns, us[j], lift); pos.push(p.x, p.y, p.z); col.push(cols[j].r, cols[j].g, cols[j].b);
    }
    for (let k = 0; k < ns; k++) for (let j = 0; j < nu - 1; j++) { const a = k * nu + j; idx.push(a, a + nu + 1, a + 1, a, a + nu, a + nu + 1); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx); return geo;
  };
  const RED = new THREE.Color(0xa3101c), DARK = new THREE.Color(0x5e0710);
  const carpetMat = matOf(); carpetMat.side = THREE.DoubleSide;
  Object.assign(carpetMat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  g.add(new THREE.Mesh(strip(0, L, [-hw, -hw + 0.22, hw - 0.22, hw], [DARK, RED, RED, DARK], LIFT), carpetMat));
  for (const [a, b] of [[0.12, 0.27], [L - 0.27, L - 0.12]]) g.add(new THREE.Mesh(strip(a, b, [-hw, hw], [DARK, DARK], LIFT + 0.008), carpetMat));

  // stanchions every ~2 m on both sides, sagging red velvet ropes between them (all merged: the mood grade
  // reads modelMatrix only, so no InstancedMesh here)
  const post = (p) => [[new THREE.CylinderGeometry(0.17, 0.2, 0.05, 12).translate(p.x, p.y + 0.025, p.z), 0xc9a646],
                       [new THREE.CylinderGeometry(0.03, 0.03, 0.95, 6).translate(p.x, p.y + 0.5, p.z), 0xe0c068],
                       [new THREE.SphereGeometry(0.065, 8, 6).translate(p.x, p.y + 1.0, p.z), 0xf0d27a]];
  const off = hw + 0.35, n = Math.max(2, Math.round((L - 1) / 2)) + 1, step = (L - 1) / (n - 1);
  const posts = [];
  const ropes = [], m4 = new THREE.Matrix4();
  for (let side = 0; side < 2; side++) {
    const u = side ? off : -off;
    for (let i = 0; i < n; i++) {
      const s = 0.5 + i * step, p = P(s, u);
      posts.push(...post(p));
      if (i < n - 1) {
        const a = P(s, u, 0.92), b = P(s + step, u, 0.92), m = a.clone().lerp(b, 0.5); m.y -= 0.22;
        ropes.push([new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, m, b), 8, 0.03, 5, false), 0x8a0c1a]);
      }
    }
  }
  g.add(new THREE.Mesh(merged(posts, bake), matOf()));
  g.add(new THREE.Mesh(merged(ropes, bake), matOf()));

  // crowd barriers (Hamburg-style grille, 2.5 x 1.1 m), a little further out at the street end
  const bar = [];
  const box = (w, hh, d, x, y, z) => [new THREE.BoxGeometry(w, hh, d).translate(x, y, z), 0x9aa1a8];
  bar.push(box(2.5, 0.05, 0.05, 0, 1.08, 0), box(2.5, 0.05, 0.05, 0, 0.22, 0), box(0.05, 1.0, 0.05, -1.22, 0.62, 0), box(0.05, 1.0, 0.05, 1.22, 0.62, 0));
  for (let k = 1; k < 16; k++) bar.push(box(0.02, 0.86, 0.02, -1.22 + k * (2.44 / 16), 0.65, 0));
  for (const x of [-0.95, 0.95]) bar.push(box(0.08, 0.04, 0.7, x, 0.02, 0), box(0.04, 0.2, 0.04, x, 0.12, 0));
  const bars = [];
  const sEnd = L - 1.3, u2 = hw + 1.9;
  for (const u of [-u2, u2]) for (const s of [sEnd - 2.6, sEnd]) bars.push([s, u, 0]);
  for (const u of [-u2 - 1.0, u2 + 1.0]) bars.push([L + 0.4, u, Math.PI / 2]);   // angled out at the very end
  const q = new THREE.Quaternion(), yAx = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const barParts = [];
  bars.forEach(([s, u, turn]) => {   // grille long side along the carpet (turn: across it)
    const p = P(Math.min(s, L), u);
    q.setFromAxisAngle(yAx, Math.PI / 2 - h + turn);
    m4.compose(p, q, one);
    for (const [geo, col] of bar) barParts.push([geo.clone().applyMatrix4(m4), col]);
  });
  g.add(new THREE.Mesh(merged(barParts, bake), matOf()));

  // banner: square to the carpet, level, on a two-post truss (canopy) - the word plus our own small standing bear
  // (a plain frontal teddy in the proportions of the game's bears, js/eggs.js), white on deep red
  const W = B.banner.width, H = B.banner.height;
  const bg = new THREE.Group(); bg.position.set(B.banner.x, B.banner.y, B.banner.z); bg.rotation.y = Math.PI - B.banner.heading;
  const tilt = new THREE.Group(); tilt.rotation.x = -THREE.MathUtils.degToRad(B.banner.tilt || 0); bg.add(tilt);
  tilt.add(new THREE.Mesh(merged([[new THREE.BoxGeometry(W, H, 0.04), 0x6a0812]], bake), matOf()));
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = Math.round(1024 * H / W);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const BG = '#9b0f1e';
  const bear = (x, cx, by, hh) => {   // frontal standing teddy, feet at by, hh tall (game bear: 2.12 units)
    const u = hh / 2.12, E = (ex, ey, rx, ry, rot = 0) => { x.moveTo(cx + ex * u + rx * u, by - ey * u); x.ellipse(cx + ex * u, by - ey * u, rx * u, ry * u, rot, 0, Math.PI * 2); };
    x.fillStyle = '#ffffff'; x.beginPath();
    for (const sx of [-1, 1]) {
      E(0.24 * sx, 0.1, 0.21, 0.11); E(0.24 * sx, 0.32, 0.19, 0.26);          // feet, stubby legs
      E(0.56 * sx, 0.84, 0.15, 0.3, sx * 0.5);                                 // arms hanging a little out
      E(0.38 * sx, 1.98, 0.17, 0.17);                                          // ears
    }
    E(0, 0.8, 0.55, 0.56); E(0, 1.62, 0.5, 0.48);                              // tummy, head
    x.fill();
    x.fillStyle = BG; x.beginPath();                                           // eyes and nose cut out
    for (const sx of [-1, 1]) E(0.2 * sx, 1.66, 0.07, 0.08);
    E(0, 1.5, 0.08, 0.06); x.fill();
  };
  const draw = (family) => {
    const x = cv.getContext('2d'), w = cv.width, hh = cv.height;
    x.fillStyle = BG; x.fillRect(0, 0, w, hh);
    x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = hh * 0.025; x.strokeRect(hh * 0.06, hh * 0.06, w - hh * 0.12, hh - hh * 0.12);
    let px = hh * 0.62;
    x.font = `700 ${px}px ${family}`;
    let tw = x.measureText(B.banner.text).width, bh = px * 0.9, bw = bh * 0.6, gap = px * 0.3;
    const maxW = w * 0.86, tot = tw + gap + bw;
    if (tot > maxW) { const f = maxW / tot; px *= f; tw *= f; bh *= f; bw *= f; gap *= f; x.font = `700 ${px}px ${family}`; }
    const x0 = (w - (tw + gap + bw)) / 2;
    bear(x, x0 + bw / 2, hh * 0.5 + px * 0.36, bh);
    x.fillStyle = '#ffffff'; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText(B.banner.text, x0 + bw + gap, hh * 0.53);
    tex.needsUpdate = true;
  };
  draw('"Arial Black", "Helvetica Neue", Arial, sans-serif');
  try {
    if (!document.getElementById('bdSignFont') && !document.getElementById('sightsFont')) {   // js/areasign.js declares it too
      const st = document.createElement('style'); st.id = 'sightsFont';
      st.textContent = '@font-face { font-family: "BerlinOrt"; src: url("assets/fonts/D-DIN-Bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }';
      document.head.appendChild(st);
    }
    document.fonts?.load('700 64px "BerlinOrt"').then((f) => { if (f && f.length) draw('"BerlinOrt", Arial, sans-serif'); }).catch(() => {});
  } catch { /* fallback font stays */ }
  const faceMat = new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  mood?.gradeMaterial?.(faceMat);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.04, H - 0.04), faceMat); face.position.z = 0.025; tilt.add(face);
  if (B.banner.truss) {   // two straight vertical posts from the ground and a top bar (dark grey)
    const yb = (B.banner.ground ?? B.banner.y - 10) - B.banner.y, top = H / 2 + 0.35, tr = [];
    for (const sx of [-1, 1]) tr.push([new THREE.BoxGeometry(0.22, top - yb, 0.22).translate(sx * (W / 2 + 0.2), (top + yb) / 2, 0), 0x2c2f33]);
    tr.push([new THREE.BoxGeometry(W + 0.62, 0.22, 0.22).translate(0, top, 0), 0x2c2f33]);
    bg.add(new THREE.Mesh(merged(tr, bake), matOf()));
  }
  g.add(bg);

  // a small gold bear statue on a low plinth beside the carpet's open end (decoration, not a findable bear)
  { const k = (B.bear?.height ?? 2) / 2.12, GOLD = 0xd2a43a, PALE = 0xe9c977, parts = [];
    const S = (r, x, y, z, sx = 1, sy = 1, sz = 1, c = GOLD) => parts.push([new THREE.SphereGeometry(r, 12, 9).scale(sx, sy, sz).translate(x, y, z), c]);
    parts.push([new THREE.BoxGeometry(1.5 / k, 0.35 / k, 1.5 / k).translate(0, -0.175 / k, 0), 0x8d9095]);   // plinth (top at 0)
    for (const sx of [-1, 1]) {
      S(0.2, 0.24 * sx, 0.13, -0.04, 1, 0.65, 1.25);
      parts.push([new THREE.CapsuleGeometry(0.19, 0.12, 4, 10).translate(0.24 * sx, 0.32, 0), GOLD]);
      parts.push([new THREE.CapsuleGeometry(0.14, 0.2, 4, 10).translate(0, -0.17, 0).rotateZ(-0.55 * sx).translate(0.47 * sx, 1.0, -0.02), GOLD]);
      S(0.17, 0.38 * sx, 1.98, 0.02);
    }
    S(0.55, 0, 0.78, 0, 1, 1.02, 0.92); S(0.38, 0, 0.74, -0.33, 1, 1.1, 0.45, PALE);
    S(0.5, 0, 1.62, 0); S(0.22, 0, 1.47, -0.39, 1.15, 0.82, 0.8, PALE);
    const geo = merged(parts, bake); geo.scale(k, k, k);
    const sb = new THREE.Mesh(geo, matOf()), side = B.bear?.side ?? 1, p = P(L - 1.2, side * (hw + 3.6));
    sb.position.set(p.x, p.y + 0.35, p.z); sb.rotation.y = -h;   // face (-Z) out along the carpet, toward the arriving car
    g.add(sb); }

  // moon: warm spotlight pools on the carpet; always: now and then a camera flash near the barriers
  if (night) {
    const spotMat = new THREE.MeshBasicMaterial({ map: glowTexture('rgba(255,214,150,0.55)', 'rgba(255,214,150,0)'), transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    for (const f of [0.18, 0.5, 0.82]) {
      const p = P(L * f, 0, 0.06), m = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), spotMat);
      m.rotation.x = -Math.PI / 2; m.position.copy(p); m.renderOrder = 2; g.add(m);
    }
  }
  const flashMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const flash = new THREE.Sprite(flashMat); flash.scale.setScalar(1.1); flash.visible = false; g.add(flash);
  let tNext = 1.5, tOff = 0, t = 0;
  return { group: g, update(dt) {
    t += dt;
    if (flash.visible && t > tOff) flash.visible = false;
    if (t > tNext) {
      const [s, u] = bars[Math.floor(Math.random() * 4)];
      flash.position.copy(P(Math.min(s, L) + (Math.random() - 0.5) * 2, u + Math.sign(u) * (0.6 + Math.random()), 1.6 + Math.random() * 0.4));
      flash.visible = true; tOff = t + 0.05; tNext = t + 1.2 + Math.random() * 3.5;
    }
  } };
}

export async function createSights({ scene, base, mood = null }) {
  const res = await fetch(base + 'sights.json').catch(() => null);
  if (!res || !res.ok) return null;
  const S = await res.json();
  const night = !!mood && /night|moon/.test(mood.name);
  const bake = !mood;                                   // no mood: shading baked into the colours
  const matOf = () => { const m = new THREE.MeshBasicMaterial({ vertexColors: true }); mood?.gradeMaterial?.(m); return m; };
  const root = new THREE.Group(); root.name = 'sights'; scene.add(root);
  const items = [];

  if (S.clock) {
    const c = makeClock(S.clock, matOf(), bake, night);
    root.add(c.group);
    items.push({ x: S.clock.x, z: S.clock.z, update: c.update });
  }
  if (S.nest) {
    const N = S.nest, rand = rnd(7);
    const g = new THREE.Group(); g.name = 'storkNest';
    g.position.set(N.x, N.y, N.z); g.rotation.y = Math.PI - N.heading;   // local +Z toward the street
    g.add(new THREE.Mesh(merged(makeNest(N.radius, rand), bake), matOf()));
    const k = N.stork || 2;
    const storks = [[-0.38, -0.1, 0.35], [0.4, 0.15, -0.6]].map(([sx, sz, ry], i) => {
      const s = makeStork(matOf, bake);
      s.group.scale.setScalar(k); s.group.position.set(sx * N.radius, 0.22, sz * N.radius); s.group.rotation.y = ry;
      g.add(s.group);
      return { ...s, t: i * 3.7, yaw: 0, yawTo: 0, next: 2 + i * 2.5, clatter: -1, nextClatter: 9 + i * 13 };
    });
    root.add(g);
    items.push({ x: N.x, z: N.z, update(dt) {
      for (const s of storks) {
        s.t += dt;
        if (s.t > s.next) { s.yawTo = (Math.random() - 0.5) * 1.8; s.next = s.t + 2.5 + Math.random() * 4; }
        s.yaw += (s.yawTo - s.yaw) * (1 - Math.exp(-1.2 * dt));           // slow head turn
        if (s.clatter < 0 && s.t > s.nextClatter) s.clatter = 0;
        let pitch = 0.05 * Math.sin(s.t * 0.7), open = 0;
        if (s.clatter >= 0) {                                              // head thrown back, beak clatters
          s.clatter += dt;
          const c = s.clatter, D = 3.0;
          const back = c < 0.5 ? c / 0.5 : c > D - 0.6 ? Math.max(0, (D - c) / 0.6) : 1;
          pitch = -2.1 * back * back * (3 - 2 * back);
          open = c > 0.4 && c < D - 0.5 ? 0.22 * (0.5 + 0.5 * Math.sin(c * 45)) : 0;
          if (c > D) { s.clatter = -1; s.nextClatter = s.t + 12 + Math.random() * 16; }
        }
        s.neck.rotation.set(pitch, s.clatter >= 0 ? s.yaw * 0.3 : s.yaw, 0, 'YXZ');
        s.beakL.rotation.x = open;
      }
    } });
  }

  if (S.berlinale) {
    const b = makeBerlinale(S.berlinale, matOf, bake, night, mood);
    root.add(b.group);
    items.push({ x: S.berlinale.x, z: S.berlinale.z, update: b.update });
  }

  return {
    root,
    update(dt, x, z) {
      for (const it of items) if (Math.hypot(it.x - x, it.z - z) < NEAR) it.update(dt);
    },
  };
}

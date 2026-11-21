// Easter eggs: a football (pitch, two goals) and the Berlin bear hunt. Quiet game: no on-screen
// messages (README Rules); a goal = star burst + counter, a found bear = the pop + counter.
//
// Data: levels/<name>/eggs.json (build_eggs.py; the single source for the game, map.html
// and the minimap): items of kind 'bear' | 'pitch' | 'goal' | 'ball' with level x/z and
// WGS84. No file -> no eggs (the counter stays hidden).
//
//   const eggs = await createEggs({ scene, world, level, base, groundAt, groundNear, isWater, isPit, mood, counterEl });
//   eggs.update(dt, { x, z, heading, kmh })   // once per frame (dt null: own clock)
//
// Physics: the ball is a dynamic Box2D circle, goals (posts + net walls) and bears are
// static bodies of their own (the obstacle switch only touches clutterBody, so they always
// work). A sensor fixture in each goal mouth detects the ball (plus a geometric fallback).
// Drawing: everything is in the main scene, unlit world meshes stay untouched (Lambert
// materials + our own two lights). Nothing here sets userData.world, so the camera
// collision (js/camcollide.js) and the car's mesh probes (js/ground.js) ignore it.
// Heights: the city mesh straight under the object (ground.js createGround probes, the same
// meshes the car rides on), else the height model.
//
// Storage: localStorage 'berlinDrive.eggs.found' = JSON array of bear ids (ids carry the
// level name: 'mitte_all.bear.03'), 'berlinDrive.eggs.hints' = 'exact' | 'area' | 'off'
// (map hints for unfound bears; default area = the fuzzed circle from eggs.json).
// Minimap: berlinDrive.minimap.setMarkers([{ id, kind, x, z, label, found, mode, radius }])
// when it exists (feature-detected, retried until the minimap has loaded).
import * as THREE from 'three';
import * as GroundMod from './ground.js';
import { createDoorway } from './doorway.js';   // doorway figure + garden fountain (levels/<name>/doorway.json), shares our lights

const FOUND_KEY = 'berlinDrive.eggs.found', HINT_KEY = 'berlinDrive.eggs.hints';
const HINT_MODES = ['exact', 'area', 'off'];
const BALL_R = 1.5;             // m: a 3 m ball (owner: "much larger"; was 0.65)
const BALL_MASS = 30;           // kg; the car is 1500 kg, so it is not knocked about
const BALL = { damping: 0.3, roll: 0.7, restitution: 0.6, stop: 0.15, hopMin: 5, g: 22 };
const GOAL = { width: 14, height: 4.6, depth: 4.6, post: 0.22 };   // grown with the ball (was 8.5 x 2.8 x 2.2); depth must exceed 2 x BALL_R
const OUT_MARGIN = 35;          // m beyond the pitch before the ball is fetched back
const BEAR_SCALE = 2.35;        // bear size: 1 = 2.2 m teddy (no pedestal), 2.35 = ~5.2 m (reads from the 60/80 camera; was 2.05 for 60/60)
const BEAR_R = 0.8;             // m at scale 1: sensor collider radius (x BEAR_SCALE)
const ROOF_BIT = 0x2000;        // js/roofs.js: Box2D category the car collides with in roof mode (roof bears' sensors)
const HIT_GAP = 0.5;            // m: found when the car outline comes this close to the collider (or touches it)
const GLOW_R = 40;              // m: unfound bear sparkles when the car is this near
const POP = { squash: 0.22, rise: 0.75, burst: 0.75, shrink: 1.5, done: 1.6, ring: 1.3 };   // s: hit -> gone

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function loadFound() {
  try { const a = JSON.parse(store.get(FOUND_KEY)); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
}

// ---------- canvas textures ----------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
// football: spherical "power diagram" of the truncated icosahedron (12 pentagon centres =
// icosahedron vertices, 20 hexagon centres = face centres, cell = argmin angle - inradius),
// painted into an equirectangular texture (SphereGeometry UVs)
function footballTexture() {
  const ico = new THREE.IcosahedronGeometry(1, 0), pos = ico.attributes.position;
  const verts = [], faces = [];
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i), b = new THREE.Vector3().fromBufferAttribute(pos, i + 1),
          c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    faces.push(a.clone().add(b).add(c).normalize());
    for (const v of [a, b, c]) if (!verts.some((u) => u.distanceToSquared(v) < 1e-6)) verts.push(v.clone().normalize());
  }
  const cells = [...verts.map((v) => [v, 0.2874, 1]), ...faces.map((v) => [v, 0.3651, 0])];   // [centre, inradius (rad), pentagon?]
  return canvasTex(1024, 512, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data, p = new THREE.Vector3();
    for (let y = 0; y < h; y++) {
      const th = (y + 0.5) / h * Math.PI;
      for (let x = 0; x < w; x++) {
        const ph = (x + 0.5) / w * 2 * Math.PI;
        p.set(-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th));   // three's SphereGeometry mapping
        let b1 = 9, b2 = 9, pent = 0;
        for (const [c, r, pe] of cells) {
          const s = Math.acos(Math.min(1, Math.max(-1, p.dot(c)))) - r;
          if (s < b1) { b2 = b1; b1 = s; pent = pe; } else if (s < b2) b2 = s;
        }
        const seam = b2 - b1 < 0.022, k = 4 * (y * w + x);
        const v = seam ? 70 : pent ? 22 : 244;
        d[k] = v; d[k + 1] = v; d[k + 2] = v; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}
// teddy colours (BEAR_COLORS) and one accessory colour per bear (eggs.json "paint" = index here)
const BEAR_COLORS = { fur: '#9a6a3f', furLight: '#c48a55', cream: '#f1dcb8', dark: '#2b1a10', cheek: '#f4a0a8', paw: '#6b4426' };
const ACCENTS = ['#ff5a5f', '#2fa7ff', '#e2001a', '#3d5afe', '#ffd23f', '#00a6c8', '#3ccf6e', '#8f5bff', '#ff6fb5',
                 '#ff8a3d', '#e8336d', '#1fbf9f', '#f4c430', '#2b6cff', '#c6ff3d', '#4b8bff', '#ff3d7f', '#7ed957'];
const ACCESSORIES = ['scarf', 'bowtie', 'hat', 'heart'];
function heart(g, x, y, s) {
  g.beginPath(); g.moveTo(x, y + s * 0.35);
  g.bezierCurveTo(x - s * 1.1, y - s * 0.4, x - s * 0.4, y - s * 1.1, x, y - s * 0.45);
  g.bezierCurveTo(x + s * 0.4, y - s * 1.1, x + s * 1.1, y - s * 0.4, x, y + s * 0.35); g.fill();
}
function star(g, x, y, r) {
  g.beginPath();
  for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5 - Math.PI / 2, q = k % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
  g.fill();
}
// paw print left where a found bear stood (subtle ground decal)
let pawTex = null;
function pawTexture() {
  return pawTex || (pawTex = canvasTex(128, 128, (g) => {
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(64, 82, 30, 25, 0, 0, 7); g.fill();
    for (const [x, y, r] of [[30, 46, 11], [52, 30, 12], [76, 30, 12], [98, 46, 11]]) { g.beginPath(); g.ellipse(x, y, r, r * 1.25, 0, 0, 7); g.fill(); }
  }));
}
const spriteTex = {};
function spriteTexture(kind) {
  if (spriteTex[kind]) return spriteTex[kind];
  return (spriteTex[kind] = canvasTex(64, 64, (g, w) => {
    if (kind === 'glow') {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,248,200,1)'); gr.addColorStop(0.35, 'rgba(255,220,120,0.55)'); gr.addColorStop(1, 'rgba(255,200,80,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
    } else if (kind === 'heart') { g.fillStyle = '#ff4f8b'; heart(g, 32, 38, 26); }
    else if (kind === 'star') { g.fillStyle = '#fff3a0'; star(g, 32, 32, 28); }
    else { g.fillStyle = '#fff'; g.fillRect(16, 24, 32, 16); }   // confetti chip (tinted per particle)
  }));
}

// ---------- Berlin bear: an original chubby teddy cub from primitives, ~2.2 m (x BEAR_SCALE) ----------
// local frame: faces -z, feet on y = 0 (no pedestal). Big round head (~45 % of the height), short round
// body, stubby limbs, wide-set small ears, big low eyes with a highlight, small nose, a gentle smile.
// Matte Lambert materials; only fur / cream / accessory get a little emissive (readable in the unlit
// world, warm at night) - the eyes never glow.
function makeBear(k) {
  const C = BEAR_COLORS, accent = ACCENTS[k % ACCENTS.length], kind = ACCESSORIES[k % ACCESSORIES.length];
  const g = new THREE.Group();
  const soft = (c, e = 0.12) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e });
  const fur = soft(C.fur), cream = soft(C.cream, 0.1), acc = soft(accent, 0.18), cheekM = soft(C.cheek, 0.08);
  const dark = new THREE.MeshLambertMaterial({ color: C.dark }), shine = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const S = (r) => new THREE.SphereGeometry(r, 32, 24);
  const add = (geo, mat, x, y, z, parent, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); parent.add(m); return m;
  };
  const body = new THREE.Group(); body.name = 'body'; g.add(body);   // everything that bobs / pops
  for (const sx of [-1, 1]) {
    add(S(0.2), fur, 0.24 * sx, 0.13, -0.04, body, 1, 0.65, 1.25);           // feet
    add(S(0.11), cream, 0.24 * sx, 0.12, -0.27, body, 1, 0.8, 0.45);         // toe pads
    add(new THREE.CapsuleGeometry(0.19, 0.12, 10, 20), fur, 0.24 * sx, 0.32, 0, body);   // stubby legs
  }
  add(S(0.55), fur, 0, 0.78, 0, body, 1, 1.02, 0.92);                         // round tummy
  add(S(0.38), cream, 0, 0.74, -0.33, body, 1, 1.1, 0.45);                    // belly patch
  // arms: left resting, right waving gently (pivot at the shoulder)
  const armL = new THREE.Group(); armL.position.set(-0.47, 1.0, -0.02); armL.rotation.z = -0.55; body.add(armL);
  add(new THREE.CapsuleGeometry(0.14, 0.2, 10, 20), fur, 0, -0.17, 0, armL);
  add(S(0.13), cream, 0, -0.33, -0.02, armL, 1, 1, 0.8);
  const armR = new THREE.Group(); armR.position.set(0.47, 1.02, -0.02); armR.rotation.z = 2.3; armR.name = 'wave'; body.add(armR);
  add(new THREE.CapsuleGeometry(0.14, 0.2, 10, 20), fur, 0, -0.17, 0, armR);
  add(S(0.13), cream, 0, -0.33, -0.02, armR, 1, 1, 0.8);
  // head, tilted up a little so the face reads from the high chase camera
  const head = new THREE.Group(); head.position.set(0, 1.62, 0); head.rotation.x = 0.3; head.name = 'head'; body.add(head);
  add(S(0.5), fur, 0, 0, 0, head);
  for (const sx of [-1, 1]) {
    add(S(0.17), fur, 0.38 * sx, 0.36, 0.02, head);                           // ears, small and wide
    add(S(0.1), cream, 0.38 * sx, 0.36, -0.1, head, 1, 1, 0.45);              // inner ears
    add(S(0.09), dark, 0.2 * sx, 0.02, -0.44, head, 1, 1.1, 0.6);             // big eyes
    add(S(0.03), shine, 0.2 * sx + 0.03, 0.07, -0.5, head);                   // highlight dot
    add(S(0.075), cheekM, 0.31 * sx, -0.13, -0.37, head, 1, 0.8, 0.35);       // rosy cheeks
  }
  add(S(0.22), cream, 0, -0.15, -0.39, head, 1.15, 0.82, 0.8);                // muzzle
  add(S(0.07), dark, 0, -0.08, -0.56, head, 1.35, 0.9, 0.9);                  // small nose
  const smile = add(new THREE.TorusGeometry(0.075, 0.014, 8, 20, Math.PI), dark, 0, -0.19, -0.575, head);
  smile.rotation.z = Math.PI;                                                 // lower half arc: a gentle smile
  // accessory in this bear's own colour
  if (kind === 'scarf') {
    add(new THREE.TorusGeometry(0.36, 0.085, 12, 32), acc, 0, 1.25, 0, body).rotation.x = Math.PI / 2 - 0.15;
    const tail = add(new THREE.BoxGeometry(0.16, 0.36, 0.06), acc, 0.2, 1.06, -0.36, body); tail.rotation.z = 0.25;
  } else if (kind === 'bowtie') {
    for (const sx of [-1, 1]) {
      const w = add(new THREE.ConeGeometry(0.11, 0.2, 16), acc, 0.1 * sx, 1.22, -0.42, body);
      w.rotation.z = sx * Math.PI / 2;
    }
    add(S(0.05), acc, 0, 1.22, -0.44, body);
  } else if (kind === 'hat') {
    const hat = new THREE.Group(); hat.position.set(0.08, 0.44, 0); hat.rotation.z = -0.18; head.add(hat);
    add(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 32), acc, 0, 0, 0, hat);
    add(new THREE.CylinderGeometry(0.19, 0.2, 0.24, 32), acc, 0, 0.13, 0, hat);
    add(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 32), cream, 0, 0.05, 0, hat);   // hat band
  } else {   // a heart on the belly
    const sh = new THREE.Shape(); sh.moveTo(0, -0.12);
    sh.bezierCurveTo(-0.2, 0.02, -0.1, 0.16, 0, 0.07); sh.bezierCurveTo(0.1, 0.16, 0.2, 0.02, 0, -0.12);
    const hg = new THREE.ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2, curveSegments: 16 });
    add(hg, acc, 0, 0.8, -0.52, body, 1.3, 1.3, 1);
  }
  g.userData.mats = [fur, cream, acc];
  g.userData.colors = [new THREE.Color(accent), new THREE.Color(accent), new THREE.Color(C.fur), new THREE.Color(C.furLight),
                       new THREE.Color(C.cream), new THREE.Color(0xffffff)];
  return g;
}

// ---------- goal: two posts, crossbar, translucent net (local: mouth on z = 0, net toward +z) ----------
function makeGoal() {
  const g = new THREE.Group(), W = GOAL.width, H = GOAL.height, D = GOAL.depth, r = GOAL.post;
  const white = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3 });
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 10), white); p.position.set(sx * W / 2, H / 2, 0); g.add(p);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, Math.hypot(D, H), 6), white);   // back stay
    b.position.set(sx * W / 2, H / 2, D / 2); b.rotation.x = -Math.atan2(D, H); g.add(b);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, W + 2 * r, 10), white);
  bar.rotation.z = Math.PI / 2; bar.position.set(0, H, 0); g.add(bar);
  const NET = 0.7;   // m per mesh: coarse, thick white cords so the net reads from the high chase camera (was 0.25, hair-thin)
  const netTex = canvasTex(64, 64, (c, w) => { c.strokeStyle = '#fff'; c.lineWidth = 9; c.strokeRect(0, 0, w, w); });
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  const netM = (rx, ry) => { const t = netTex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
    return new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }); };
  // back net slopes from the crossbar down to the ground at depth D; side nets are triangles
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, Math.hypot(D, H)), netM(W / NET, Math.hypot(D, H) / NET));
  back.position.set(0, H / 2, D / 2); back.rotation.x = -Math.atan2(D, H);   // crossbar -> ground at depth D
  g.add(back);
  for (const sx of [-1, 1]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, H, 0, 0, 0, D], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, H / NET, D / NET, 0], 2));
    const s = new THREE.Mesh(geo, netM(1, 1)); s.position.x = sx * W / 2; g.add(s);
  }
  return g;
}

// ---------- module ----------
export async function createEggs({ scene, world, level, base, groundAt, groundNear = groundAt, isWater, isPit = () => false,
                                   mood = null, counterEl = null, parent = document.body }) {
  const res = await fetch(base + 'eggs.json');
  if (!res.ok) { if (counterEl) counterEl.style.display = 'none'; return null; }
  const data = await res.json();
  const items = data.items || [];
  const LV = level.name;
  const B2 = window.Box2D, b2Vec2 = B2.Common.Math.b2Vec2;
  const night = mood && /night|moon/.test(mood.name);

  const root = new THREE.Group(); root.name = 'eggs'; scene.add(root);
  // our own light: the world is unlit (baked photogrammetry), only egg materials react
  // (a mood: the car's light values, so eggs and car match; night/moon add a soft emissive glow)
  const P = mood?.preset || null;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8890a0, Math.max(night ? 1.1 : 1.6, P?.carHemi ?? 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, P?.carSun ?? 1.4);
  const sd = mood?.uniforms?.uSunDir?.value;
  if (sd && sd.length() > 0.1) sun.position.copy(sd).normalize(); else sun.position.set(-0.5, 1, 0.3);
  root.add(hemi, sun);
  const emissiveBoost = night ? 0.45 : mood?.name === 'snow' ? 0.2 : 0;   // night: soft glow, readable

  // mesh ground under (x, z): js/ground.js probe set (same meshes as the car), refreshed ~1 Hz
  const probe = typeof GroundMod.createGround === 'function' ? GroundMod.createGround(scene) : null;
  let probeT = 9;
  const meshY = (x, z, y0, r) => { try { return probe ? probe.nearest(x, z, y0, r) : null; } catch { return null; } };
  const groundY = (x, z, near = false) => { const y0 = near ? groundNear(x, z) : groundAt(x, z); return meshY(x, z, y0, 3.5) ?? y0; };
  const doorway = await createDoorway({ root, base, groundAt, groundY, emissiveBoost, isFound: (id) => found.has(id) }).catch((e) => { console.warn('doorway:', e); return null; });

  // ---------- particles: confetti, hearts, sparkles (sprites, no depth write) ----------
  const parts = [];
  function burst(kind, x, y, z, n, opts = {}) {
    const cols = [0xff5a5f, 0x2fa7ff, 0xffd23f, 0x3ccf6e, 0x8f5bff, 0xffffff];
    for (let i = 0; i < n; i++) {
      const cl = opts.colors || cols;
      const m = new THREE.SpriteMaterial({ map: spriteTexture(kind), transparent: true, depthWrite: false,
        color: kind === 'chip' || opts.colors ? cl[i % cl.length] : 0xffffff });
      const s = new THREE.Sprite(m); const sz = opts.size ?? (kind === 'chip' ? 0.7 : 1.1); s.scale.setScalar(sz);
      const a = Math.random() * Math.PI * 2, sp = (opts.speed ?? 6) * (0.4 + Math.random() * 0.8);
      const sp0 = opts.spread ?? 0;
      s.position.set(x + (Math.random() - 0.5) * sp0, y + (Math.random() - 0.5) * sp0, z + (Math.random() - 0.5) * sp0); root.add(s);
      parts.push({ s, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: (opts.up ?? 8) * (0.6 + Math.random() * 0.6),
                   t: 0, life: (opts.life ?? 2.2) * (0.7 + Math.random() * 0.5), g: opts.g ?? 9, spin: Math.random() * 10 });
    }
  }
  function stepParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.t += dt;
      if (p.t > p.life) { root.remove(p.s); p.s.material.dispose(); parts.splice(i, 1); continue; }
      p.vy -= p.g * dt; p.vx *= 1 - 1.2 * dt; p.vz *= 1 - 1.2 * dt;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.s.material.rotation = p.spin * p.t;
      p.s.material.opacity = Math.min(1, 3 * (1 - p.t / p.life));
    }
  }

  // ---------- HUD: counter + the list it opens (no messages: README Rules) ----------
  const css = document.createElement('style');
  css.textContent = `
#eggPanel { position: absolute; top: 46px; width: 300px; max-height: 70vh; overflow-y: auto; padding: 8px 10px;
  font: 13px sans-serif; color: #ddd; background: rgba(0,0,0,0.85); border: 1px solid #666; border-radius: 5px; z-index: 1003; display: none; }
#eggPanel h3 { margin: 2px 0 6px; font-size: 14px; color: #fff; }
#eggPanel ol { margin: 0 0 8px; padding-left: 22px; }
#eggPanel li { margin: 3px 0; }
#eggPanel li.found b { color: #ffd45a; }
#eggPanel li i { color: #999; }
#eggPanel select, #eggPanel button { font: 12px sans-serif; background: #222; color: #ddd; border: 1px solid #666; border-radius: 4px; }
#eggPanel .row { margin: 6px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }`;
  document.head.appendChild(css);
  const panel = document.createElement('div'); panel.id = 'eggPanel'; parent.appendChild(panel);

  // ---------- bears ----------
  let found = loadFound();
  let hintMode = HINT_MODES.includes(store.get(HINT_KEY)) ? store.get(HINT_KEY) : 'area';
  store.set(HINT_KEY, hintMode);
  // bears: a sensor circle each (never blocks: the car drives through and the bear pops),
  // found = touched by the car (sensor contact or car outline within HIT_GAP), also in the air
  const bearBody = world.CreateBody(new B2.Dynamics.b2BodyDef());
  const BR = BEAR_R * BEAR_SCALE;
  const pawMat = (col) => { const m = new THREE.MeshBasicMaterial({ map: pawTexture(), color: col, transparent: true, opacity: 0.45, depthWrite: false,
                                                        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
                             mood?.gradeMaterial?.(m); return m; };
  const bears = items.filter((it) => it.kind === 'bear').map((it, k) => {
    const obj = makeBear(it.paint ?? k);
    obj.scale.setScalar(BEAR_SCALE);
    obj.position.set(it.x, it.roof ? it.y : groundAt(it.x, it.z), it.z);   // roof bear: on the roof deck (eggs.json y = deck height)
    obj.rotation.y = it.facing ?? 0;
    const c = new B2.Collision.Shapes.b2CircleShape(BR); c.SetLocalPosition(new b2Vec2(it.x, it.z));
    const fd = new B2.Dynamics.b2FixtureDef(); fd.shape = c; fd.isSensor = true;
    if (it.roof) fd.filter.categoryBits = ROOF_BIT;   // the car in roof mode only sees roof-category fixtures (js/roofs.js)
    const fix = bearBody.CreateFixture(fd);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture('glow'), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0 }));
    glow.scale.setScalar(3.2); glow.position.set(0, 1.1, 0); obj.add(glow);   // x BEAR_SCALE
    const paw = new THREE.Mesh(new THREE.PlaneGeometry(1.1 * BEAR_SCALE, 1.1 * BEAR_SCALE).rotateX(-Math.PI / 2), pawMat(BEAR_COLORS.paw));
    paw.rotation.y = it.facing ?? (k * 1.7); paw.position.set(it.x, obj.position.y + 0.06, it.z); paw.visible = false; paw.renderOrder = 1;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.visible = false;
    root.add(paw, ring);
    return { it, obj, glow, paw, ring, fix, yaw: obj.rotation.y, pop: -1, sparkT: 0 };
  });
  for (const b of bears) for (const m of b.obj.userData.mats) m.emissiveIntensity += 0.7 * emissiveBoost;   // warm, soft; eyes stay dark
  const bearsHere = () => bears.filter((b) => found.has(b.it.id)).length;
  // shown: unfound = statue; found = only the paw print (and the pop while it runs)
  function showBear(b, isFound) {
    b.pop = -1; b.ring.visible = false;
    if (isFound) root.remove(b.obj); else if (!b.obj.parent) root.add(b.obj);
    b.paw.visible = isFound;
    const body = b.obj.getObjectByName('body');
    b.obj.scale.setScalar(BEAR_SCALE); body.position.y = 0; body.rotation.set(0, 0, 0); body.scale.set(1, 1, 1);
  }
  for (const b of bears) showBear(b, found.has(b.it.id));
  function saveFound() { store.set(FOUND_KEY, JSON.stringify([...found])); }
  function findBear(b) {
    found.add(b.it.id); saveFound(); b.pop = 0; b.glow.material.opacity = 0; b.glow.visible = false;
    const n = bearsHere(), N = bears.length, p = b.obj.position;
    if (n === N) setTimeout(() => {   // the last bear: a bigger shower, no text
      burst('chip', p.x, p.y + 3 * BEAR_SCALE, p.z, 70, { speed: 9, up: 12, life: 3.5 });
      burst('heart', p.x, p.y + 3 * BEAR_SCALE, p.z, 20, { speed: 5, up: 9, g: 3, life: 3 });
    }, 2200);
    refreshUi(); publishMarkers();
  }
  // car outline (oriented rectangle) within HIT_GAP of the bear's collider?
  function carTouches(b, car) {
    const sp = window.berlinDrive?.vehicle?.spec, L = (sp?.bodyLength ?? 4.5) / 2, W = (sp?.bodyWidth ?? 1.8) / 2;
    const dx = b.it.x - car.x, dz = b.it.z - car.z, h = car.heading ?? 0;
    const f = dx * Math.sin(h) - dz * Math.cos(h), r = dx * Math.cos(h) + dz * Math.sin(h);
    return Math.hypot(Math.max(0, Math.abs(r) - W), Math.max(0, Math.abs(f) - L)) < BR + HIT_GAP;
  }
  function sensorTouched(b) {
    for (let e = bearBody.GetContactList(); e; e = e.next) {
      const c = e.contact;
      if (c.IsTouching() && (c.GetFixtureA() === b.fix || c.GetFixtureB() === b.fix)) return true;
    }
    return false;
  }
  // the pop: squash, stretch up with a spin, burst into the paint's confetti + stars + a few hearts,
  // shrink to nothing; a soft ring ripples out on the ground. Frame-rate independent (dt).
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  function popStep(b, dt) {
    const t0 = b.pop, t = (b.pop += dt), S = BEAR_SCALE, body = b.obj.getObjectByName('body'), p = b.obj.position;
    if (t < POP.squash) {                                  // squash (anticipation)
      const u = ease(t / POP.squash); body.scale.set(1 + 0.18 * u, 1 - 0.25 * u, 1 + 0.18 * u);
    } else if (t < POP.rise) {                             // stretch up + spin
      const u = ease((t - POP.squash) / (POP.rise - POP.squash));
      body.scale.set(1.18 - 0.3 * u, 0.75 + 0.5 * u, 1.18 - 0.3 * u);
      body.position.y = 0.9 * u; body.rotation.y = 2 * Math.PI * u;
    } else {                                               // shrink away, still turning
      const u = ease((t - POP.rise) / (POP.shrink - POP.rise)), k = 1 - u;
      body.scale.set(0.88 * k, 1.25 * k, 0.88 * k);
      body.position.y = 0.9 + 0.3 * u; body.rotation.y = 2 * Math.PI + 3 * u;
    }
    if (t0 < POP.burst && t >= POP.burst) {                // the shower, at the bear's centre
      const y = p.y + 1.3 * S, cols = b.obj.userData.colors;
      burst('chip', p.x, y, p.z, 46, { speed: 4.5, up: 6, g: 5, life: 2.2, colors: cols, spread: 1.2 * S, size: 0.6 * S });
      burst('star', p.x, y, p.z, 12, { speed: 3.5, up: 5, g: 3, life: 1.8, colors: cols, spread: S, size: 0.55 * S });
      burst('heart', p.x, y + 0.5 * S, p.z, 5, { speed: 1.8, up: 4, g: 1.5, life: 2.2, size: 0.7 * S });
    }
    if (t >= POP.squash) {                                 // ground ring ripple
      const u = Math.min(1, (t - POP.squash) / POP.ring);
      b.ring.visible = u < 1; b.ring.position.set(p.x, p.y + 0.08, p.z);
      b.ring.scale.setScalar(BR + 6 * S * ease(u)); b.ring.material.opacity = 0.55 * (1 - u);
    }
    if (t >= POP.done) {
      showBear(b, true);
      b.paw.material.opacity = 0;   // fades in (update)
    }
  }

  // ---------- football ----------
  const pitches = items.filter((it) => it.kind === 'pitch');
  const goalBody = world.CreateBody(new B2.Dynamics.b2BodyDef());
  const goals = [];
  for (const it of items.filter((x) => x.kind === 'goal')) {
    const obj = makeGoal(); obj.position.set(it.x, groundAt(it.x, it.z), it.z);
    // it.heading: direction from the goal line into the net (clockwise from north, like the car)
    const h = it.heading, dx = Math.sin(h), dz = -Math.cos(h);
    obj.rotation.y = Math.atan2(dx, dz);   // local +z -> (dx, dz)
    root.add(obj);
    const W = Math.max(it.width ?? 0, GOAL.width), D = Math.max(it.depth ?? 0, GOAL.depth);   // eggs.json still holds the old 8.5 x 2.2
    const px = -dz, pz = dx;   // across the mouth
    const at = (a, d) => new b2Vec2(it.x + px * a + dx * d, it.z + pz * a + dz * d);
    for (const s of [-1, 1]) {   // posts
      const c = new B2.Collision.Shapes.b2CircleShape(GOAL.post + 0.04); c.SetLocalPosition(at(s * W / 2, 0));
      const fd = new B2.Dynamics.b2FixtureDef(); fd.shape = c; fd.restitution = 0.5; fd.friction = 0.2; goalBody.CreateFixture(fd);
    }
    const box = (a0, d0, a1, d1, sensor) => {   // thin wall from (a0, d0) to (a1, d1) in goal coords
      const p0 = at(a0, d0), p1 = at(a1, d1), len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const s = new B2.Collision.Shapes.b2PolygonShape();
      s.SetAsOrientedBox(len / 2, sensor ? sensor : 0.08, new b2Vec2((p0.x + p1.x) / 2, (p0.y + p1.y) / 2), Math.atan2(p1.y - p0.y, p1.x - p0.x));
      const fd = new B2.Dynamics.b2FixtureDef(); fd.shape = s; fd.restitution = 0.05; fd.friction = 0.6; fd.isSensor = !!sensor;
      return goalBody.CreateFixture(fd);
    };
    box(-W / 2, 0.15, -W / 2, D, 0); box(W / 2, 0.15, W / 2, D, 0); box(-W / 2, D, W / 2, D, 0);   // side + back nets (soft)
    // goal mouth sensor: the ball touches it only once it is wholly over the line (centre depth > BALL_R)
    const s0 = 2 * BALL_R + 0.05, s1 = D - 0.1;
    const sensor = box(-W / 2 + 0.2, (s0 + s1) / 2, W / 2 - 0.2, (s0 + s1) / 2, (s1 - s0) / 2);
    goals.push({ it, obj, sensor, dx, dz, px, pz, W, D, pitch: it.pitch, yFixed: false });
  }
  const ballItems = items.filter((x) => x.kind === 'ball');
  let ballTexCache = null;
  const balls = ballItems.map((it) => {
    const pitch = pitches.find((p) => p.id === it.pitch) || null;
    const bd = new B2.Dynamics.b2BodyDef(); bd.type = B2.Dynamics.b2Body.b2_dynamicBody; bd.position.Set(it.x, it.z);
    bd.bullet = true; bd.linearDamping = BALL.damping; bd.angularDamping = 2;
    const body = world.CreateBody(bd);
    const fd = new B2.Dynamics.b2FixtureDef(); fd.shape = new B2.Collision.Shapes.b2CircleShape(BALL_R);
    fd.density = BALL_MASS / (Math.PI * BALL_R * BALL_R); fd.friction = 0.3; fd.restitution = BALL.restitution;
    body.CreateFixture(fd);
    body.SetFixedRotation(true);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 20),
      new THREE.MeshLambertMaterial({ map: ballTex(), emissive: 0xffffff, emissiveMap: ballTex(), emissiveIntensity: 0.15 + emissiveBoost * 0.6 }));
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 0.95, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    root.add(mesh, shadow);
    return { it, pitch, body, mesh, shadow, hop: 0, vy: 0, lastV: 0, outT: 0, resetT: -1, goalCd: 0, y: groundAt(it.x, it.z) };
  });
  function ballTex() { return ballTexCache || (ballTexCache = footballTexture()); }
  let goalsScored = 0;
  function resetBall(b) {
    b.body.SetPositionAndAngle(new b2Vec2(b.it.x, b.it.z), 0);
    b.body.SetLinearVelocity(new b2Vec2(0, 0)); b.body.SetAwake(true);
    b.hop = 0; b.vy = 0; b.outT = 0; b.resetT = -1; b.mesh.visible = true; b.lastV = 0;
  }
  // pitch-local coordinates: u along the long axis (goal to goal), v across
  function pitchLocal(p, x, z) {
    const ux = Math.sin(p.heading), uz = -Math.cos(p.heading);
    return [(x - p.x) * ux + (z - p.z) * uz, -(x - p.x) * uz + (z - p.z) * ux];
  }
  function inGoal(g, b) {
    for (let e = b.body.GetContactList(); e; e = e.next) {
      if (e.contact.IsTouching() && (e.contact.GetFixtureA() === g.sensor || e.contact.GetFixtureB() === g.sensor)) return true;
    }
    const p = b.body.GetPosition(), rx = p.x - g.it.x, rz = p.y - g.it.z;   // fallback: geometry
    const d = rx * g.dx + rz * g.dz, a = rx * g.px + rz * g.pz;
    return d > BALL_R * 0.9 && d < g.D && Math.abs(a) < g.W / 2 - 0.1;
  }
  function scoreGoal(g, b) {
    goalsScored++; b.goalCd = 3.2; b.resetT = 2.2;
    const p = b.mesh.position;
    burst('chip', p.x, p.y + 1, p.z, 60, { speed: 7, up: 10, life: 2.6 });
    burst('star', g.obj.position.x, g.obj.position.y + GOAL.height, g.obj.position.z, 12, { speed: 4, up: 6, g: 5 });
    refreshUi();
  }

  // ---------- pitch lines (ground-hugging strips, only where the item asks for them) ----------
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false,
                                                polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  mood?.gradeMaterial?.(lineMat);
  const lineSets = [];
  for (const p of pitches.filter((q) => q.lines)) {
    const L = p.length, Wd = p.width, ux = Math.sin(p.heading), uz = -Math.cos(p.heading);
    const P = (u, v) => [p.x + u * ux - v * uz, p.z + u * uz + v * ux];
    const polys = [];
    const rect = (u0, v0, u1, v1) => polys.push([[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]]);
    rect(-L / 2, -Wd / 2, L / 2, Wd / 2);
    polys.push([[0, -Wd / 2], [0, Wd / 2]]);
    const circ = (cu, R, a0 = 0, a1 = 2 * Math.PI) => { const q = []; for (let k = 0; k <= 40; k++) { const a = a0 + (a1 - a0) * k / 40; q.push([cu + R * Math.cos(a), R * Math.sin(a)]); } polys.push(q); };
    circ(0, Math.min(9.15, Wd / 5));
    const box = Math.min(16.5, L / 6), bw = Math.min(40.3, Wd * 0.6);
    for (const s of [-1, 1]) { rect(s * L / 2, -bw / 2, s * (L / 2 - box), bw / 2); rect(s * L / 2, -GOAL.width / 2 - 3, s * (L / 2 - box / 3), GOAL.width / 2 + 3); }
    // strips: 0.14 m wide, a vertex every <= 2 m (follows the ground)
    const pos = [], idx = [], pts = [];
    const hw = 0.14;
    for (const poly of polys) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const [u0, v0] = poly[i], [u1, v1] = poly[i + 1], len = Math.hypot(u1 - u0, v1 - v0), n = Math.max(1, Math.ceil(len / 2));
        const nu = -(v1 - v0) / len * hw, nv = (u1 - u0) / len * hw;
        for (let k = 0; k <= n; k++) {
          const u = u0 + (u1 - u0) * k / n, v = v0 + (v1 - v0) * k / n;
          const a = P(u + nu, v + nv), b = P(u - nu, v - nv), base = pos.length / 3;
          pos.push(a[0], 0, a[1], b[0], 0, b[1]); pts.push(a, b);
          if (k > 0) idx.push(base - 2, base - 1, base, base - 1, base + 1, base);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, lineMat); mesh.frustumCulled = false; mesh.renderOrder = 1; root.add(mesh);
    const set = { p, mesh, pts };
    lineSets.push(set);
    for (let k = 0; k < pts.length; k++) geo.attributes.position.setY(k, groundAt(pts[k][0], pts[k][1]) + 0.08);
  }

  // ---------- UI ----------
  function refreshUi() {
    if (!counterEl) return;
    counterEl.style.display = bears.length || balls.length ? '' : 'none';
    counterEl.textContent = (bears.length ? `\u{1F43B} ${bearsHere()}/${bears.length}` : '') + (goalsScored ? `  ⚽ ${goalsScored}` : '');
    if (panel.style.display === 'block') renderPanel();
  }
  function renderPanel() {
    const li = bears.map((b) => found.has(b.it.id) ? `<li class="found"><b>${b.it.name}</b> ✔</li>`
                                                   : `<li>??? <i>${b.it.hint || ''}</i></li>`).join('');
    panel.innerHTML = `<h3>Berliner Bären: ${bearsHere()} von ${bears.length}</h3><ol>${li}</ol>
      <div class="row hints">Hinweise auf der Karte: <select id="eggHints">${HINT_MODES.map((m) =>
        `<option value="${m}"${m === hintMode ? ' selected' : ''}>${{ exact: 'genau', area: 'Gebiet', off: 'aus' }[m]}</option>`).join('')}</select></div>
      ${balls.length ? `<div class="row">⚽ Tore in dieser Runde: ${goalsScored}</div>` : ''}
      <div class="row"><button id="eggReset">Suche zurücksetzen</button><button id="eggClose">Schließen</button></div>`;
    panel.querySelector('#eggHints').addEventListener('change', (e) => { setHints(e.target.value); e.target.blur(); });
    panel.querySelector('#eggHints').addEventListener('keydown', (e) => e.preventDefault());   // arrows drive
    panel.querySelector('#eggReset').addEventListener('click', (e) => { e.currentTarget.blur(); if (confirm('Bärensuche auf diesem Level zurücksetzen?')) reset(); });
    panel.querySelector('#eggClose').addEventListener('click', () => { panel.style.display = 'none'; });
  }
  if (counterEl) {
    counterEl.title = 'Berliner Bären (Liste, Hinweise)';
    counterEl.addEventListener('click', (e) => {
      e.currentTarget.blur();
      const open = panel.style.display !== 'block';
      panel.style.display = open ? 'block' : 'none';
      if (open) { panel.style.left = counterEl.offsetLeft + 'px'; renderPanel(); }
    });
  }
  function setHints(m) { if (!HINT_MODES.includes(m)) return; hintMode = m; store.set(HINT_KEY, m); publishMarkers(); }
  function reset() {
    for (const b of bears) found.delete(b.it.id);   // this level only
    saveFound(); for (const b of bears) showBear(b, false);
    refreshUi(); publishMarkers();
  }

  // ---------- markers for the minimap (berlinDrive.minimap.setMarkers) ----------
  function markers() {
    const out = [];
    for (const b of bears) {
      const f = found.has(b.it.id);
      if (f || hintMode === 'exact') out.push({ id: b.it.id, kind: 'bear', x: b.it.x, z: b.it.z, label: f ? b.it.name : '???', found: f, mode: f ? 'exact' : hintMode });
      else if (hintMode === 'area' && b.it.area) out.push({ id: b.it.id, kind: 'bear', x: b.it.area.x, z: b.it.area.z, radius: b.it.area.radius, label: '???', found: false, mode: 'area' });
      // off: unfound bears are left out
    }
    for (const p of pitches) out.push({ id: p.id, kind: 'pitch', x: p.x, z: p.z, label: p.name || 'Fußball', found: false, mode: 'exact' });
    return out;
  }
  let mmTry = 0;
  function publishMarkers() {
    const mm = window.berlinDrive?.minimap;
    if (mm && typeof mm.setMarkers === 'function') { try { mm.setMarkers(markers()); } catch (e) { console.warn('eggs markers:', e); } return true; }
    return false;
  }
  // the minimap loads on the side (and may land later): retry for a while
  const mmTimer = setInterval(() => { if (publishMarkers() || ++mmTry > 60) clearInterval(mmTimer); }, 1000);
  addEventListener('storage', (e) => {   // map.html in another tab changed the hint mode / reset
    if (e.key === HINT_KEY && HINT_MODES.includes(e.newValue)) { hintMode = e.newValue; publishMarkers(); refreshUi(); }
    if (e.key === FOUND_KEY) { found = loadFound(); for (const b of bears) if (b.pop < 0) showBear(b, found.has(b.it.id)); publishMarkers(); refreshUi(); }
  });
  refreshUi();

  // ---------- per frame ----------
  let last = performance.now(), clock = 0;
  const NEAR = 260;   // m: objects this near the car get their height from the mesh
  function update(dt, car) {
    const now = performance.now();
    if (dt == null) dt = Math.min(0.1, (now - last) / 1000);
    last = now; clock += dt;
    if (!car) return;
    doorway?.update(dt, car);
    // heights: re-probe objects near the car about once a second (mesh / streamed tiles)
    probeT += dt;
    if (probeT > 1) {
      probeT = 0;
      try { probe?.collect(); } catch { /* ground.js changed */ }
      for (const b of bears) if (!b.it.roof && Math.hypot(b.it.x - car.x, b.it.z - car.z) < NEAR && b.pop < 0) {   // roof bears keep the deck height
        b.obj.position.y = groundY(b.it.x, b.it.z); b.paw.position.y = b.obj.position.y + 0.06;
      }
      for (const g of goals) if (Math.hypot(g.it.x - car.x, g.it.z - car.z) < NEAR) g.obj.position.y = groundY(g.it.x, g.it.z);
      for (const s of lineSets) {
        // near the car: follow the mesh (streamed tiles load late and change their LOD)
        if (Math.hypot(s.p.x - car.x, s.p.z - car.z) > NEAR + s.p.length / 2) continue;
        const a = s.mesh.geometry.attributes.position;
        for (let k = 0; k < s.pts.length; k++) a.setY(k, groundY(s.pts[k][0], s.pts[k][1]) + 0.1);
        a.needsUpdate = true;
      }
    }
    // bears: glow when near and unfound, turn toward the car; touched -> pop; found -> paw print only
    for (const b of bears) {
      const p = b.obj.position, d = Math.hypot(p.x - car.x, p.z - car.z), isF = found.has(b.it.id);
      if (b.pop >= 0) { popStep(b, dt); continue; }
      if (isF) {   // paw print fades in after the pop
        if (b.paw.material.opacity < 0.45) b.paw.material.opacity = Math.min(0.45, b.paw.material.opacity + 0.5 * dt);
        continue;
      }
      const level = b.it.roof ? car.roof === b.it.roof : !car.under && !car.roof;   // same level as the bear: street bears not from a tunnel / roof, roof bears only from that roof in roof mode
      if (d < 30 && level && (carTouches(b, car) || sensorTouched(b))) { findBear(b); popStep(b, dt); continue; }   // car.under: in a road tunnel below (js/tunnels.js); car.roof: roof mode route (js/roofs.js)
      if (d < 60) {   // face the car (local -z is the front)
        const want = Math.atan2(-(car.x - p.x), -(car.z - p.z));
        let dy = want - b.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        b.yaw += dy * Math.min(1, 2 * dt); b.obj.rotation.y = b.yaw;
      }
      const wave = b.obj.getObjectByName('wave');
      wave.rotation.z = 2.3 + 0.18 * Math.sin(clock * 1.6 + b.it.x);   // slow, small wave
      const body = b.obj.getObjectByName('body');                      // soft idle bob + sway
      body.position.y = 0.02 * (1 + Math.sin(clock * 1.8 + b.it.z)); body.rotation.z = 0.035 * Math.sin(clock * 1.1 + b.it.x);
      const gl = d < GLOW_R ? 0.35 + 0.25 * Math.sin(clock * 4) : 0;
      b.glow.material.opacity += (gl - b.glow.material.opacity) * Math.min(1, 3 * dt);
      b.glow.visible = b.glow.material.opacity > 0.01;
      const S = BEAR_SCALE;
      if (d < GLOW_R && (b.sparkT -= dt) < 0) { b.sparkT = 0.35; burst('star', p.x + (Math.random() - 0.5) * 2 * S, p.y + (1.2 + Math.random() * 1.5) * S, p.z + (Math.random() - 0.5) * 2 * S, 1, { speed: 0.8, up: 1.5, g: 0, size: 0.45 * S, life: 1 }); }
    }
    // balls
    for (const b of balls) {
      const bp = b.body.GetPosition(), v = b.body.GetLinearVelocity(), sp = v.Length();
      // rolling resistance on top of the linear damping: comes to rest
      if (sp > 0) {
        const ns = Math.max(0, sp - BALL.roll * dt), k = ns < BALL.stop ? 0 : ns / sp;
        b.body.SetLinearVelocity(new b2Vec2(v.x * k, v.y * k));
      }
      if (sp - b.lastV > BALL.hopMin && b.hop <= 0.01) b.vy = Math.min(6, 0.35 * (sp - b.lastV));   // hit hard: a small hop
      b.lastV = sp;
      b.vy -= BALL.g * dt; b.hop += b.vy * dt;
      if (b.hop < 0) { b.hop = 0; b.vy = b.vy < -1.5 ? -b.vy * 0.45 : 0; }
      const gy = Math.hypot(bp.x - car.x, bp.y - car.z) < 30 ? groundY(bp.x, bp.y, true) : groundY(bp.x, bp.y);
      b.y += (gy - b.y) * Math.min(1, 12 * dt);
      const dx = bp.x - b.mesh.position.x, dz = bp.y - b.mesh.position.z, dist = Math.hypot(dx, dz);
      if (dist > 1e-4 && dist < 5) {   // roll: rotate about the axis perpendicular to the motion
        const ax = new THREE.Vector3(dz / dist, 0, -dx / dist);
        b.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, dist / BALL_R));
      }
      b.mesh.position.set(bp.x, b.y + BALL_R + b.hop, bp.y);
      b.shadow.position.set(bp.x + 0.25, b.y + 0.06, bp.y - 0.15);
      b.shadow.material.opacity = 0.35 / (1 + b.hop);
      // goal?
      if (b.goalCd > 0) b.goalCd -= dt;
      else for (const g of goals) if ((!g.pitch || g.pitch === b.it.pitch) && inGoal(g, b)) { scoreGoal(g, b); break; }
      // out of the pitch area by a wide margin, in water / pit: fetch it back after a moment
      let out = isWater(bp.x, bp.y) || isPit(bp.x, bp.y);
      if (!out && b.pitch) { const [u, w] = pitchLocal(b.pitch, bp.x, bp.y); out = Math.abs(u) > b.pitch.length / 2 + OUT_MARGIN || Math.abs(w) > b.pitch.width / 2 + OUT_MARGIN; }
      if (out && b.resetT < 0) { b.outT += dt; if (b.outT > 1.5) { b.resetT = 0.01; if (isWater(bp.x, bp.y)) burst('chip', bp.x, b.y + 0.5, bp.y, 10, { speed: 2, up: 4 }); } }
      else if (!out) b.outT = 0;
      if (b.resetT >= 0 && (b.resetT -= dt) < 0) {
        resetBall(b);
        const c = b.it; burst('star', c.x, groundY(c.x, c.z) + 1, c.z, 8, { speed: 2, up: 4, g: 4, size: 0.7 });
      }
    }
    stepParts(dt);
  }

  return {
    update,
    items: () => items.map((it) => ({ ...it, found: it.kind === 'bear' ? found.has(it.id) : undefined })),
    found: () => bears.filter((b) => found.has(b.it.id)).map((b) => b.it.id),
    reset,
    get ball() { const b = balls[0]; if (!b) return null; const p = b.body.GetPosition(), v = b.body.GetLinearVelocity(); return { x: p.x, z: p.y, y: b.mesh.position.y, vx: v.x, vz: v.y, hop: b.hop }; },
    get balls() { return balls.map((b) => { const p = b.body.GetPosition(); return { id: b.it.id, x: p.x, z: p.y }; }); },
    get goals() { return goalsScored; },
    get hints() { return hintMode; }, setHints,
    // tests: put the ball somewhere (x, z, vx, vz) / call it back
    placeBall(x, z, vx = 0, vz = 0, i = 0) { const b = balls[i]; if (!b) return; b.body.SetPositionAndAngle(new b2Vec2(x, z), 0); b.body.SetLinearVelocity(new b2Vec2(vx, vz)); b.body.SetAwake(true); b.goalCd = 0; },
    resetBall: (i = 0) => balls[i] && resetBall(balls[i]),
    markers, publishMarkers, root,
    // the Esc menu's bear line (js/menu.js): only the found count, "7 / 18"
    get count() { return bears.length ? `${bearsHere()} / ${bears.length}` : ''; },
  };
}

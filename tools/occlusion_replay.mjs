// Offline replay of the js/stream.js selection with / without the occlusion step
// (MITTE_STREAMING_PLAN.md "Occlusion"): node racing/tools/occlusion_replay.mjs
// Uses the occlusion core of js/stream.js verbatim; the selection (frustum + SSE + fovea,
// look-ahead cameras, ring, base) is re-implemented without hysteresis / governor / budget.
// Prints, per camera case, the tiles the streamer would load (L1/L2/L3/L4) without -> with the
// step, the GPU MB saved (RGBA8 textures, L3/L4 halved, + vertex/index arrays, as stats() counts),
// and the CPU time of one pass of verdicts. Reads local data only. ONLY=<prefix> picks cases.
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const L = R + 'levels/mitte_all/';
const src = fs.readFileSync(R + 'js/stream.js', 'utf8');
const core = src.slice(src.indexOf('// --- occlusion core'), src.indexOf('// --- end occlusion core')).replace('OCC_RAYS = 360', 'OCC_RAYS = ' + (process.env.RAYS || 360));
const makeOcclusion = new Function(core.replace('export function', 'function') + '\nreturn makeOcclusion;')();
const doc = JSON.parse(fs.readFileSync(L + 'tiles.json'));
const meta = JSON.parse(fs.readFileSync(L + 'occlusion.json'));
let raw = fs.readFileSync(L + meta.file);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const OCC_LEADS = [0.75, 1.5, 2.25, 3];
const occ = makeOcclusion(meta, buf, 1 + OCC_LEADS.length);
const lev = JSON.parse(fs.readFileSync(L + 'level.json'));
const hg = new Float32Array(fs.readFileSync(L + 'height.bin').buffer.slice(0));
const ground = (x, z) => {
  const h = lev.height, i = Math.round((x - h.x0) / h.cell), j = Math.round((-z - h.n0) / h.cell);
  return hg[Math.max(0, Math.min(h.nz - 1, j)) * h.nx + Math.max(0, Math.min(h.nx - 1, i))];
};
const TAU = 24, FOV = 35, H = 950, ASP = 16 / 9, RING_R = 120, LEADS = [1.5, 3], LEAD_TAU = [1, 1.3];
const tiles = doc.tiles.map((t, i) => ({ i, path: t[0], level: t[1], pi: t[2], c: [t[3], t[4], t[5]], r: t[6], leaf: !!t[19], ge: doc.ge[t[1]], kids: [] }));
const roots = [];
for (const t of tiles) { if (t.pi >= 0) { t.parent = tiles[t.pi]; t.parent.kids.push(t); } else roots.push(t); }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len = (a) => Math.hypot(a[0], a[1], a[2]);
for (const t of [...tiles].sort((a, b) => a.level - b.level)) {
  let c = t.c.slice(), r = t.r;
  for (const k of t.kids) {
    const d = len(sub(k.cs.c, c));
    if (d + k.cs.r <= r) continue;
    if (d + r <= k.cs.r) { c = k.cs.c.slice(); r = k.cs.r; continue; }
    const R2 = (d + r + k.cs.r) / 2, f = (R2 - r) / d;
    c = [c[0] + (k.cs.c[0] - c[0]) * f, c[1] + (k.cs.c[1] - c[1]) * f, c[2] + (k.cs.c[2] - c[2]) * f]; r = R2;
  }
  t.cs = { c, r };
}
// camera: eye, forward / right / up unit vectors
function makeCam(eye, look, fovDeg) {
  const f = sub(look, eye), fl = len(f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
  let rt = [-f[2], 0, f[0]]; const rl = len(rt); rt = rt.map((v) => v / rl);         // f x up
  const up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
  const tv = Math.tan(fovDeg * Math.PI / 360), th = tv * ASP;
  return { eye, f, rt, up, tv, th, halfDiag: Math.atan(tv * Math.hypot(1, ASP)) };
}
function visible(C, t) {
  const d = sub(t.cs.c, C.eye), r = t.cs.r;
  const zc = d[0] * C.f[0] + d[1] * C.f[1] + d[2] * C.f[2], xc = d[0] * C.rt[0] + d[1] * C.rt[1] + d[2] * C.rt[2], yc = d[0] * C.up[0] + d[1] * C.up[1] + d[2] * C.up[2];
  if (zc < 1 - r || zc > 8000 + r) return false;
  const nh = Math.hypot(1, C.th), nv = Math.hypot(1, C.tv);
  return (zc * C.th - xc) / nh >= -r && (zc * C.th + xc) / nh >= -r && (zc * C.tv - yc) / nv >= -r && (zc * C.tv + yc) / nv >= -r;
}
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function fovea(C, t, d) {
  const v = sub(t.c, C.eye), l = len(v);
  if (l <= t.r) return 1;
  const ang = Math.acos(Math.max(-1, Math.min(1, (v[0] * C.f[0] + v[1] * C.f[1] + v[2] * C.f[2]) / l))) - Math.asin(t.r / l);
  return (1 + 0.35 * ss(0.55, 1, ang / C.halfDiag)) * (1 + 0.25 * ss(600, 1500, d));
}
const K = H / (2 * Math.tan(FOV * Math.PI / 360));
function run(car, eye, look, leadsOn, useOcc) {
  const set = new Set(), drawn = new Set();
  let kept = 0, tested = 0, hiddenN = 0, ms = 0;
  const nEyes = leadsOn ? 1 + OCC_LEADS.length : 1;
  occ.setEye(0, ...eye);
  const leadEyes = [];
  if (leadsOn) OCC_LEADS.forEach((T, li) => { const e = [eye[0] + car.vx * T, eye[1], eye[2] + car.vz * T]; leadEyes.push(e); occ.setEye(1 + li, ...e); });
  const cache = new Map(), testedList = [];
  const occluded = (t) => {
    if (!useOcc || t.leaf) return false;
    if (cache.has(t)) return cache.get(t);
    const t0 = performance.now();
    const near = Math.hypot(t.cs.c[0] - car.x, t.cs.c[2] - car.z) - t.cs.r < RING_R;
    const h = !near && occ.hidden(t.i, nEyes);
    ms += performance.now() - t0; tested++; if (h) hiddenN++;
    cache.set(t, h); testedList.push(t); return h;
  };
  const C = makeCam(eye, look, FOV);
  const dist = (C, t) => Math.max(0, len(sub(t.c, C.eye)) - t.r);
  function select(t) {
    set.add(t);
    const d = dist(C, t);
    const wr = !t.leaf && t.ge * K / Math.max(d, 1e-3) > TAU * fovea(C, t, d);
    if (wr && occluded(t)) kept++;
    if (wr && !occluded(t)) { for (const c of t.kids) set.add(c); for (const c of t.kids) if (visible(C, c)) select(c); return; }
    drawn.add(t);
  }
  for (const r of roots) if (visible(C, r)) select(r);
  if (leadsOn) LEADS.forEach((T, li) => {
    const e = [eye[0] + car.vx * T, eye[1], eye[2] + car.vz * T], Cl = makeCam(e, [look[0] + car.vx * T, look[1], look[2] + car.vz * T], FOV * 1.3);
    const ahead = (t) => {
      set.add(t);
      const d = dist(Cl, t);
      if (t.leaf || t.ge * K / Math.max(d, 1e-3) <= TAU * LEAD_TAU[li] * fovea(Cl, t, d)) return;
      if (occluded(t)) return;
      for (const c of t.kids) set.add(c);
      for (const c of t.kids) if (visible(Cl, c)) ahead(c);
    };
    for (const r of roots) if (visible(Cl, r)) ahead(r);
  });
  for (const t of tiles) if (t.leaf && t.level === 1 && Math.hypot(t.c[0] - car.x, t.c[2] - car.z) - t.r < RING_R) for (let a = t; a; a = a.parent) set.add(a);
  for (const r of roots) set.add(r);
  return { set, drawn, kept, tested, hiddenN, ms, testedList, leadEyes };
}
// GPU bytes per tile as stream.js counts them (RGBA8 texture, L3/L4 halved; vertex + index arrays)
const gpuCache = new Map();
function gpu(t) {
  if (gpuCache.has(t)) return gpuCache.get(t);
  const b = fs.readFileSync(R + '../berlin_mesh_2025_wab/' + t.path);
  const off = 28 + b.readUInt32LE(12) + b.readUInt32LE(16) + b.readUInt32LE(20) + b.readUInt32LE(24);
  const jl = b.readUInt32LE(off + 12), gj = JSON.parse(b.toString('utf8', off + 20, off + 20 + jl)), bin = off + 20 + jl + 8;
  let n = 0;
  for (const a of gj.accessors) n += a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]) * (a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1);
  for (const im of gj.images || []) {
    const bv = gj.bufferViews[im.bufferView], s = bin + (bv.byteOffset || 0);
    let p = s + 2, w = 0, h = 0;
    while (p < s + bv.byteLength) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xc3) { h = b.readUInt16BE(p + 5); w = b.readUInt16BE(p + 7); break; }
      p += 2 + b.readUInt16BE(p + 2);
    }
    const sc = t.level >= 3 ? 0.25 : 1;
    n += w * h * 4 * sc;
  }
  gpuCache.set(t, n); return n;
}
function cmp(name, car, dir, height, distM, leads) {
  const g = ground(car.x, car.z);
  const eye = [car.x - Math.sin(dir) * distM, g + height, car.z + Math.cos(dir) * distM], look = [car.x, g, car.z];
  const sp = leads ? 50 / 3.6 : 0; car.vx = Math.sin(dir) * sp; car.vz = -Math.cos(dir) * sp;
  const a = run(car, eye, look, leads, false), b = run(car, eye, look, leads, true);
  const mb = (s) => [...s].reduce((x, t) => x + gpu(t), 0) / 1e6;
  const lv = (s) => [1, 2, 3, 4].map((l) => [...s].filter((t) => t.level === l).length).join('/');
  // cost: replay the occlusion pass with the eye moved a little each time (no cached horizons)
  let ms = []; const s0 = { ...occ.stats };
  for (let i = 0; i < 200; i++) { const e2 = [eye[0] + (i % 20) * 0.3, eye[1], eye[2]]; ms.push(run(car, e2, look, leads, true).ms); }
  const wk = (occ.stats.samples + 20 * occ.stats.boxes - s0.samples - 20 * s0.boxes) / 200, smp = (occ.stats.samples - s0.samples) / 200, rys = (occ.stats.rays - s0.rays) / 200;
  ms.sort((x, y) => x - y);
  // CPU time of the occlusion verdicts alone (load on this box inflates wall time)
  const nE = leads ? 1 + OCC_LEADS.length : 1, list = b.testedList.filter((t) => !(Math.hypot(t.cs.c[0] - car.x, t.cs.c[2] - car.z) - t.cs.r < RING_R));
  const c0 = process.cpuUsage();
  for (let i = 0; i < 300; i++) {
    occ.setEye(0, eye[0] + (i % 20) * 0.3, eye[1], eye[2]);
    if (leads) b.leadEyes.forEach((e, li) => occ.setEye(1 + li, e[0] + (i % 20) * 0.3, e[1], e[2]));
    for (const t of list) occ.hidden(t.i, nE);
  }
  const cu = process.cpuUsage(c0), cpuMs = (cu.user + cu.system) / 300 / 1000;
  console.log(`${name.padEnd(34)} loaded L1/L2/L3/L4 ${lv(a.set).padEnd(14)} -> ${lv(b.set).padEnd(14)} saved ${a.set.size - b.set.size} tiles, ` +
    `${(mb(a.set) - mb(b.set)).toFixed(0)} of ${mb(a.set).toFixed(0)} MB; kept ${b.kept}, tested ${b.tested}, hidden ${b.hiddenN}; ` +
    `CPU ms/pass ${cpuMs.toFixed(2)} rays ${rys.toFixed(0)} samples ${smp.toFixed(0)} work ${wk.toFixed(0)}`);
}
console.log('occluder yCap', occ.yCap);
const ONLY = process.env.ONLY; const cases0 = [
  ['Friedrichstr. (N, Franz.Str.)', { x: -490, z: 880 }, -0.11],
  ['Friedrichstr. (N, Leipziger)', { x: -447, z: 1340 }, -0.11],
  ['Unter den Linden (E)', { x: -380, z: 610 }, 1.39],
];
const cases = ONLY ? cases0.filter(c => c[0].startsWith(ONLY)) : cases0;
for (const leads of (ONLY ? [true] : [false, true])) {
  console.log(leads ? '--- moving 50 km/h (occlusion eyes 0.75 / 1.5 / 2.25 / 3 s ahead, look-ahead cameras 1.5 / 3 s)' : '--- standing (ring only, camera eye only)');
  for (const [n, car, dir] of cases) for (const [h, d] of [[60, 60], [30, 50], [8, 15]]) cmp(`${n} ${h}/${d}`, { ...car }, dir, h, d, leads);
}

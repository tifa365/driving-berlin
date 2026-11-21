// Building walls on a streamed level (levels/<name>/walls.bin + walls.json from build_walls.py:
// OSM footprints, passages / roads under buildings carved). index.html loads this after start;
// a level without walls.json gets null and nothing changes (the small level keeps level.walls).
//
// Too many walls for Box2D at once (~100k+ boxes), so only the cells around the car have
// fixtures: CELL m grid, each segment belongs to the cell of its midpoint (segments are
// <= 16 m), the 3x3 cells around the car are built, cells beyond 5x5 are destroyed
// (hysteresis). One static body per cell, always on (not the switchable clutter body);
// update(x, z, off) with off = true (S-Bahn rails mode: the car is on the viaduct deck,
// the buildings below must not collide) deactivates them.
// The data tests (inside, hits) work anywhere, with or without fixtures:
//   inside(x, z)              in a footprint (outer rings > courtyards) and not in a carved
//                              passage / road-under-building corridor; false while off
//   hits(x, z, h, halfL, halfW) does a car box (heading h, as Box2D body angle) touch a wall
//   clear(x, z) (option)       kept-clear test (bridge decks, js/bridges.js): segments with their
//                              midpoint there are dropped, inside() is false there
//   update(x, z, off)          per physics step (cheap when the cell does not change)
//   setDebug(v)                F overlay: active walls as lines (same colour as level.walls)
//   stats()                    { segments, cells, fixtures, off }

import { SOLID } from './vehicle.js';
import { fetchBin } from './site.js';   // .bin, gzipped on the published site   // wall material: no bounce, moderate scrape (shared with border, trunks, obstacles)

const CELL = 64;
const NEAR = 1, KEEP = 2;   // build cells within NEAR, destroy beyond KEEP (cells)
const OFF = 2048, key = (i, j) => (i + OFF) * 4096 + (j + OFF);

export async function createWalls({ base, world, groundAt, scene, THREE, clear = null }) {
  let meta;
  try {
    const r = await fetch(base + 'walls.json');
    if (!r.ok) return null;
    meta = await r.json();
  } catch { return null; }
  const r = await fetchBin(base + meta.file);
  if (!r.ok) throw new Error(`${base}${meta.file}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const sc = meta.scale, WH = meta.wallHalf ?? 0.3;
  const S16 = new Int16Array(buf, meta.segments.offset, meta.segments.count * 4);
  const RL = new Int32Array(buf, meta.ringLen.offset, meta.ringLen.count);
  const R16 = new Int16Array(buf, meta.rings.offset, meta.rings.count * 2);
  const C16 = new Int16Array(buf, meta.corridors.offset, meta.corridors.count * 5);
  const seg = Float32Array.from(S16, (v) => v * sc), ring = Float32Array.from(R16, (v) => v * sc), cor = Float32Array.from(C16, (v) => v * sc);
  const nSeg = seg.length / 4;

  // ---- grids: segments by midpoint, rings and corridors by bbox (+ r)
  const segCells = new Map(), ringCells = new Map(), corCells = new Map();
  const push = (m, k, v) => { let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(v); };
  let nClear = 0;
  for (let s = 0; s < nSeg; s++) {
    const mx = (seg[4 * s] + seg[4 * s + 2]) / 2, mz = (seg[4 * s + 1] + seg[4 * s + 3]) / 2;
    if (clear && clear(mx, mz)) { nClear++; continue; }   // kept clear (bridge decks: piers mapped on them)
    push(segCells, key(Math.floor(mx / CELL), Math.floor(mz / CELL)), s);
  }
  const addBox = (m, v, x0, z0, x1, z1) => {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) push(m, key(i, j), v);
  };
  const rStart = new Int32Array(RL.length), rLen = new Int32Array(RL.length), rHole = new Uint8Array(RL.length);
  const rBox = new Float32Array(RL.length * 4);
  for (let i = 0, o = 0; i < RL.length; i++) {
    const n = Math.abs(RL[i]);
    rStart[i] = o; rLen[i] = n; rHole[i] = RL[i] < 0 ? 1 : 0;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[2 * (o + k)], z = ring[2 * (o + k) + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    rBox.set([x0, z0, x1, z1], 4 * i);
    addBox(ringCells, i, x0, z0, x1, z1);
    o += n;
  }
  for (let c = 0; c < cor.length / 5; c++) {
    const [x0, z0, x1, z1, rr] = cor.subarray(5 * c, 5 * c + 5);
    addBox(corCells, c, Math.min(x0, x1) - rr, Math.min(z0, z1) - rr, Math.max(x0, x1) + rr, Math.max(z0, z1) + rr);
  }

  function inRing(i, x, z) {
    const b = 4 * i;
    if (x < rBox[b] || x > rBox[b + 2] || z < rBox[b + 1] || z > rBox[b + 3]) return false;
    let c = false;
    const o = rStart[i], n = rLen[i];
    for (let a = 0, p = n - 1; a < n; p = a++) {
      const xi = ring[2 * (o + a)], zi = ring[2 * (o + a) + 1], xj = ring[2 * (o + p)], zj = ring[2 * (o + p) + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  }
  function inCorridor(x, z) {
    const l = corCells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return false;
    for (const c of l) {
      const o = 5 * c, ax = cor[o], az = cor[o + 1], dx = cor[o + 2] - ax, dz = cor[o + 3] - az, rr = cor[o + 4];
      const L2 = dx * dx + dz * dz;
      let u = L2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + u * dx - x, ez = az + u * dz - z;
      if (ex * ex + ez * ez < rr * rr) return true;
    }
    return false;
  }
  let off = false;
  function inside(x, z) {
    if (off || (clear && clear(x, z))) return false;
    const l = ringCells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return false;
    let n = 0;
    for (const i of l) if (inRing(i, x, z)) n += rHole[i] ? -1 : 1;
    return n > 0 && !inCorridor(x, z);
  }
  // car box (forward = (sin h, -cos h), as the Box2D body) against the wall boxes
  function hits(x, z, h, halfL, halfW) {
    if (off) return false;
    const fx = Math.sin(h), fz = -Math.cos(h), lx = Math.cos(h), lz = Math.sin(h);
    const A = halfL + WH, B = halfW + WH;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const l = segCells.get(key(ci + di, cj + dj));
      if (!l) continue;
      for (const s of l) {
        const o = 4 * s;
        const ax = seg[o] - x, az = seg[o + 1] - z, bx = seg[o + 2] - x, bz = seg[o + 3] - z;
        // into the car frame (u along, v across), then Liang-Barsky against [-A, A] x [-B, B]
        const u0 = ax * fx + az * fz, v0 = ax * lx + az * lz, u1 = bx * fx + bz * fz, v1 = bx * lx + bz * lz;
        if (Math.max(u0, u1) < -A || Math.min(u0, u1) > A || Math.max(v0, v1) < -B || Math.min(v0, v1) > B) continue;
        let t0 = 0, t1 = 1;
        const du = u1 - u0, dv = v1 - v0;
        const clip = (p, q) => {
          if (Math.abs(p) < 1e-12) return q >= 0;
          const t = q / p;
          if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
          return true;
        };
        if (clip(-du, u0 + A) && clip(du, A - u0) && clip(-dv, v0 + B) && clip(dv, B - v0) && t0 <= t1) return true;
      }
    }
    return false;
  }

  // ---- fixtures near the car: one static body per cell
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  const live = new Map();   // key -> { i, j, body, segs }
  let ci0 = null, cj0 = null, debug = false, viz = null;
  function build(i, j) {
    const l = segCells.get(key(i, j)) || [];
    const body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
    for (const s of l) {
      const o = 4 * s, x0 = seg[o], z0 = seg[o + 1], x1 = seg[o + 2], z1 = seg[o + 3];
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const sh = new Box2D.Collision.Shapes.b2PolygonShape();
      sh.SetAsOrientedBox(len / 2 + WH, WH, new b2Vec2((x0 + x1) / 2, (z0 + z1) / 2), Math.atan2(dz, dx));
      const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = sh; fd.friction = SOLID.friction; fd.restitution = SOLID.restitution;
      body.CreateFixture(fd);
    }
    if (off) body.SetActive(false);
    live.set(key(i, j), { i, j, body, segs: l });
  }
  function update(x, z, nowOff = false) {
    if (!!nowOff !== off) {
      off = !!nowOff;
      for (const c of live.values()) c.body.SetActive(!off);
    }
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    if (ci === ci0 && cj === cj0) return;
    ci0 = ci; cj0 = cj;
    for (let di = -NEAR; di <= NEAR; di++) for (let dj = -NEAR; dj <= NEAR; dj++) if (!live.has(key(ci + di, cj + dj))) build(ci + di, cj + dj);
    for (const [k, c] of live) {
      if (Math.abs(c.i - ci) > KEEP || Math.abs(c.j - cj) > KEEP) { world.DestroyBody(c.body); live.delete(k); }
    }
    if (debug) drawDebug();
  }
  function drawDebug() {
    const pos = [];
    for (const c of live.values()) for (const s of c.segs) {
      const o = 4 * s, x0 = seg[o], z0 = seg[o + 1], x1 = seg[o + 2], z1 = seg[o + 3];
      pos.push(x0, groundAt(x0, z0) + 0.5, z0, x1, groundAt(x1, z1) + 0.5, z1);
    }
    if (!viz) {
      viz = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3060 }));
      viz.frustumCulled = false; scene.add(viz);
    }
    viz.geometry.dispose();
    viz.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    viz.visible = true;
  }
  function setDebug(v) {
    debug = !!v;
    if (debug) drawDebug(); else if (viz) viz.visible = false;
  }
  let fixtures = () => { let n = 0; for (const c of live.values()) n += c.segs.length; return n; };
  return {
    meta, inside, hits, update, setDebug,
    get off() { return off; },
    stats: () => ({ segments: nSeg, cleared: nClear, rings: RL.length, corridors: cor.length / 5, cells: live.size, fixtures: fixtures(), off }),
  };
}

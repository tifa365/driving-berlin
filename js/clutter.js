// Street clutter on a streamed level: tree trunks + mesh obstacles (levels/<name>/clutter.json +
// clutter.bin from build_clutter.py). Sibling of js/walls.js with the same cell scheme: CELL m
// absolute grid (cell i = floor(x / CELL)), every trunk / obstacle belongs to the cell of its
// position / outline centre, the 3x3 cells around the car get fixtures, cells beyond 5x5 are
// destroyed (hysteresis), one static body per cell. Unlike the walls these are switchable:
// update(x, z, off) with off = true (Obstacles switch off, or S-Bahn rails mode) deactivates them.
// A level without clutter.json gets null and nothing changes (the small level keeps
// level.trees / level.obstacles on index.html's clutterBody).
//   inside(x, z)    in an obstacle outline (any cell, with or without fixtures); false while off
//   update(x, z, off), setDebug(v) (F overlay: trunk rings + poles red, obstacles orange), stats()

import { fetchBin } from './site.js';   // .bin, gzipped on the published site
import { SOLID, TRUNK } from './vehicle.js';   // shared collision material: a dull stop, no bounce; trunk marker

const NEAR = 1, KEEP = 2;   // as js/walls.js
const WH = 0.3;             // 0.6 m boxes along the outline, as index.html addWall
// collider radius of a trunk at least this (m), applied at load: the Baumkataster trunks are
// 0.3 m (median) and a 0.6 m post was missed by most of the car's pointed nose (owner: "Trees are
// no blocker?"). The debug rings show this radius. clutter.bin keeps the stored one.
// The raise never brings a trunk closer than TRUNK_CLEAR m to a drivable OSM centre line (the rule
// build_clutter.py dropped trunks by: r + 0.5 m), from map.json's road lines (simplified 0.3 m);
// without map.json every trunk is raised. Classes = osm_semantic.ROAD_WIDTH, tunnels skipped.
// owner 2026-11-20: thick, car-stopping trunks blocked streets with kerb-side trees -> off (true = on again)
const TRUNK_SOLID = false;
// size guess for obstacles built before the car-height test (clutter.bin `ev` row NaN / no `ev` section):
// tall + small = overhead (crown piece, lamp head, sign) -> no collider. Rows with an `ev` passed
// build_clutter.py's car-height test (mesh surface 0.3-2 m over the street) and are kept as they are.
const OVERHEAD = { minH: 4.5, maxA: 20 };   // m above the street, m2
const TRUNK_MIN_R = 0.7, TRUNK_CLEAR = 0.5, LANE_CELL = 8;
const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

// raise trees[k + 2] to TRUNK_MIN_R, capped at (distance to the nearest drivable centre line) - TRUNK_CLEAR
async function raiseTrunks(base, trees) {
  const reach = TRUNK_MIN_R + TRUNK_CLEAR, grid = new Map();   // "i,j" -> [x0, z0, x1, z1, ...]
  try {
    const r = await fetch(base + 'map.json');
    const roads = r.ok ? (await r.json()).roads || [] : [];
    for (const [hw, , tun, p] of roads) {
      if (tun || !DRIVABLE.has(hw)) continue;
      for (let q = 0; q + 3 < p.length; q += 2) {
        const x0 = p[q], z0 = p[q + 1], x1 = p[q + 2], z1 = p[q + 3];
        for (let i = Math.floor((Math.min(x0, x1) - reach) / LANE_CELL); i <= Math.floor((Math.max(x0, x1) + reach) / LANE_CELL); i++)
          for (let j = Math.floor((Math.min(z0, z1) - reach) / LANE_CELL); j <= Math.floor((Math.max(z0, z1) + reach) / LANE_CELL); j++) {
            const k = i + ',' + j; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(x0, z0, x1, z1);
          }
      }
    }
  } catch { /* no map.json: no guard */ }
  let capped = 0;
  for (let k = 0; k < trees.length; k += 4) {
    const r0 = trees[k + 2];
    if (r0 >= TRUNK_MIN_R) continue;
    const x = trees[k], z = trees[k + 1], segs = grid.get(Math.floor(x / LANE_CELL) + ',' + Math.floor(z / LANE_CELL));
    let d = Infinity;
    if (segs) for (let s = 0; s < segs.length; s += 4) {
      const ax = segs[s], az = segs[s + 1], dx = segs[s + 2] - ax, dz = segs[s + 3] - az, l2 = dx * dx + dz * dz;
      const u = l2 > 1e-9 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      d = Math.min(d, Math.hypot(x - ax - u * dx, z - az - u * dz));
    }
    const r = Math.max(r0, Math.min(TRUNK_MIN_R, d - TRUNK_CLEAR));
    if (r < TRUNK_MIN_R) capped++;
    trees[k + 2] = r;
  }
  return capped;
}

export async function createClutter({ base, world, groundAt, scene, THREE }) {
  let meta;
  try {
    const r = await fetch(base + 'clutter.json');
    if (!r.ok) return null;
    meta = await r.json();
  } catch { return null; }
  const r = await fetchBin(base + meta.file);
  if (!r.ok) throw new Error(`${base}${meta.file}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const sec = (nm, T) => { const s = meta.sections[nm]; return new T(buf, s.offset, s.count * s.stride); };
  const cells = sec('cells', Uint32Array), trees = sec('trees', Float32Array).slice();   // own copy: radius raised
  const trunksCapped = TRUNK_SOLID ? await raiseTrunks(base, trees) : 0;
  const obst = sec('obst', Float32Array).slice(), pts = sec('pts', Float32Array);
  // owner 2026-11-21: "something in the way, nothing visible". Only what the player sees at car height
  // blocks. Rows checked by build_clutter.py (ev finite) are trusted; older rows use the size guess
  // (point count 0 = no collider).
  const ev = meta.sections.ev ? sec('ev', Float32Array) : null;
  let overhead = 0;
  for (let k = 0; k < obst.length / 4; k++) {
    if (ev && Number.isFinite(ev[2 * k])) continue;
    if (obst[4 * k + 2] >= OVERHEAD.minH && obst[4 * k + 3] <= OVERHEAD.maxA) { obst[4 * k + 1] = 0; overhead++; }
  }
  const CELL = meta.cell, I0 = Math.round(meta.x0 / CELL), J0 = Math.round(meta.z0 / CELL);
  const cellIdx = (i, j) => {   // absolute cell -> row of the index, -1 outside
    const a = i - I0, b = j - J0;
    return a < 0 || b < 0 || a >= meta.nx || b >= meta.nz ? -1 : b * meta.nx + a;
  };
  const oBox = new Float32Array(obst.length);   // per obstacle x0, z0, x1, z1
  for (let k = 0; k < obst.length / 4; k++) {
    const p0 = obst[4 * k], n = obst[4 * k + 1];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let q = p0; q < p0 + n; q++) {
      const x = pts[2 * q], z = pts[2 * q + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    oBox.set([x0, z0, x1, z1], 4 * k);
  }

  let off = false;
  function inObst(k, x, z) {
    const b = 4 * k;
    if (x < oBox[b] || x > oBox[b + 2] || z < oBox[b + 1] || z > oBox[b + 3]) return false;
    const p0 = obst[b], n = obst[b + 1];
    let c = false;
    for (let a = 0, p = n - 1; a < n; p = a++) {
      const xi = pts[2 * (p0 + a)], zi = pts[2 * (p0 + a) + 1], xj = pts[2 * (p0 + p)], zj = pts[2 * (p0 + p) + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  }
  function inside(x, z) {
    if (off) return false;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const c = cellIdx(ci + di, cj + dj);
      if (c < 0) continue;
      for (let k = cells[4 * c + 2], e = k + cells[4 * c + 3]; k < e; k++) if (inObst(k, x, z)) return true;
    }
    return false;
  }

  // ---- fixtures near the car: one static body per cell
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  const live = new Map();   // "i,j" -> { i, j, body, c, n }
  let ci0 = null, cj0 = null, debug = false, tViz = null, oViz = null;
  function build(i, j) {
    const c = cellIdx(i, j);
    if (c < 0) return;
    const body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
    let n = 0;
    for (let k = cells[4 * c], e = k + cells[4 * c + 1]; k < e; k++) {
      const sh = new Box2D.Collision.Shapes.b2CircleShape(trees[4 * k + 2]);
      sh.SetLocalPosition(new b2Vec2(trees[4 * k], trees[4 * k + 1]));
      const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = sh; fd.friction = SOLID.friction; fd.restitution = SOLID.restitution;
      if (TRUNK_SOLID) fd.userData = TRUNK;   // Vehicle.wallImpact: a front hit stops the car instead of glancing off the round trunk
      body.CreateFixture(fd); n++;
    }
    for (let k = cells[4 * c + 2], e = k + cells[4 * c + 3]; k < e; k++) {
      const p0 = obst[4 * k], np = obst[4 * k + 1];
      for (let q = p0; q + 1 < p0 + np; q++) {
        const x0 = pts[2 * q], z0 = pts[2 * q + 1], x1 = pts[2 * q + 2], z1 = pts[2 * q + 3];
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const sh = new Box2D.Collision.Shapes.b2PolygonShape();
        sh.SetAsOrientedBox(len / 2 + WH, WH, new b2Vec2((x0 + x1) / 2, (z0 + z1) / 2), Math.atan2(dz, dx));
        const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = sh; fd.friction = SOLID.friction; fd.restitution = SOLID.restitution;
        body.CreateFixture(fd); n++;
      }
    }
    if (off) body.SetActive(false);
    live.set(i + ',' + j, { i, j, body, c, n });
  }
  function update(x, z, nowOff = false) {
    if (!!nowOff !== off) {
      off = !!nowOff;
      for (const c of live.values()) c.body.SetActive(!off);
      if (debug) drawDebug();
    }
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    if (ci === ci0 && cj === cj0) return;
    ci0 = ci; cj0 = cj;
    for (let di = -NEAR; di <= NEAR; di++) for (let dj = -NEAR; dj <= NEAR; dj++) {
      if (!live.has((ci + di) + ',' + (cj + dj))) build(ci + di, cj + dj);
    }
    for (const [k, c] of live) {
      if (Math.abs(c.i - ci) > KEEP || Math.abs(c.j - cj) > KEEP) { world.DestroyBody(c.body); live.delete(k); }
    }
    if (debug) drawDebug();
  }
  function drawDebug() {
    const tl = [], ol = [];
    for (const { c } of off ? [] : live.values()) {
      for (let k = cells[4 * c], e = k + cells[4 * c + 1]; k < e; k++) {
        const x = trees[4 * k], z = trees[4 * k + 1], rr = trees[4 * k + 2], vis = trees[4 * k + 3];
        const y = groundAt(x, z) + 0.5;
        for (let s = 0; s < 12; s++) {
          const a0 = (s / 12) * 2 * Math.PI, a1 = ((s + 1) / 12) * 2 * Math.PI;
          tl.push(x + rr * Math.cos(a0), y, z + rr * Math.sin(a0), x + rr * Math.cos(a1), y, z + rr * Math.sin(a1));
        }
        tl.push(x, y, z, x, y + vis, z);   // pole up to the visible crown height
      }
      for (let k = cells[4 * c + 2], e = k + cells[4 * c + 3]; k < e; k++) {
        const p0 = obst[4 * k], np = obst[4 * k + 1], h = obst[4 * k + 2];
        for (let q = p0; q + 1 < p0 + np; q++) {
          const x0 = pts[2 * q], z0 = pts[2 * q + 1], x1 = pts[2 * q + 2], z1 = pts[2 * q + 3];
          const g0 = groundAt(x0, z0), g1 = groundAt(x1, z1);
          ol.push(x0, g0 + 0.5, z0, x1, g1 + 0.5, z1, x0, g0 + h, z0, x1, g1 + h, z1);
        }
      }
    }
    if (!tViz) {
      tViz = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3060 }));
      oViz = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8c00 }));
      tViz.frustumCulled = oViz.frustumCulled = false; scene.add(tViz, oViz);
    }
    for (const [v, l] of [[tViz, tl], [oViz, ol]]) {
      v.geometry.dispose();
      v.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(l, 3));
      v.visible = true;
    }
  }
  function setDebug(v) {
    debug = !!v;
    if (debug) drawDebug(); else if (tViz) tViz.visible = oViz.visible = false;
  }
  return {
    meta, inside, update, setDebug,
    get off() { return off; },
    stats: () => {
      let fx = 0; for (const c of live.values()) fx += c.n;
      return { trees: meta.trees, obstacles: meta.obstacles, cells: live.size, fixtures: fx, off, trunksCapped, overhead,
        carHeightChecked: meta.carHeight?.checked ?? 0 };
    },
  };
}

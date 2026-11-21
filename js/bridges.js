// Bridges over water as drivable decks (levels/<name>/bridges.json from build_bridges.py:
// OSM road / path bridges incl. footbridges, deck outline, centre line with the deck height
// from the L1 mesh, rails where the car would drop off). A level without bridges.json gets
// null and nothing changes.
//
// What index.html does with it (all guarded with `bridges?.`):
//   inDeck(x, z)          on a drivable deck outline (2D). isWater() is false there (the
//                         water mask may reach under a deck edge); walls.js drops footprint
//                         edges on decks (building=bridge_support piers mapped ON the
//                         Gustav-Heinemann-Bruecke blocked it).
//   ground(x, z, y)       deck height when (x, z) is on a deck AND y (the car's road layer)
//                         is at deck level (-2.5 .. +4 m): the carGround override, so trusses,
//                         railings and thin decks never confuse the mesh fit. A car below
//                         (quay path, the Tiergarten tunnel, in the river) gets null.
//   update(x, z, y, off)  rails: static Box2D boxes (shared SOLID material) along the deck
//                         edges with a drop outside, only for bridges within NEAR m of the car
//                         and only while the car is at deck level; bridge heads are open
//                         (build_bridges.py stops on a rail inside a head mouth, see `heads`).
//                         off = true (S-Bahn rails mode, tunnel) removes them.
//   deckAt(x, z)          { b, y } or null (any height), for tests / debug
//   items(), stats()
import { SOLID } from './vehicle.js';

const CELL = 32;            // m, lookup grid for the deck outlines
const NEAR = 40;            // m, rails exist for bridges whose outline box is this close
const BELOW = 2.5, ABOVE = 4;   // m, car layer band around the deck that counts as "on it"
const WH = 0.3;             // m, half thickness of a rail box (placed just outside the edge)
const key = (i, j) => (i + 2048) * 4096 + (j + 2048);

export async function createBridges({ base, world }) {   // world: () => the Box2D world (made later)
  let doc;
  try {
    const r = await fetch(base + 'bridges.json');
    if (!r.ok) return null;
    doc = await r.json();
  } catch { return null; }
  const list = (doc.bridges || []).filter((b) => b.drivable && b.poly && b.line);
  if (!list.length) return null;
  const cells = new Map();
  for (const b of list) {
    b.P = Float64Array.from(b.poly.flat());
    b.L = b.line;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < b.P.length; k += 2) {
      const x = b.P[k], z = b.P[k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    b.box = [x0, z0, x1, z1];
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        let l = cells.get(key(i, j)); if (!l) cells.set(key(i, j), (l = [])); l.push(b);
      }
  }
  function inPoly(b, x, z) {
    const [x0, z0, x1, z1] = b.box;
    if (x < x0 || x > x1 || z < z0 || z > z1) return false;
    const P = b.P, n = P.length / 2;
    let c = false;
    for (let a = 0, p = n - 1; a < n; p = a++) {
      const xi = P[2 * a], zi = P[2 * a + 1], xj = P[2 * p], zj = P[2 * p + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  }
  // deck height at the projection of (x, z) onto the centre line (clamped to its ends)
  function profileY(b, x, z) {
    const L = b.L;
    let best = Infinity, y = L[0][2];
    for (let k = 0; k < L.length - 1; k++) {
      const ax = L[k][0], az = L[k][1], dx = L[k + 1][0] - ax, dz = L[k + 1][1] - az, l2 = dx * dx + dz * dz;
      let u = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + u * dx - x, ez = az + u * dz - z, d = ex * ex + ez * ez;
      if (d < best) { best = d; y = L[k][2] + u * (L[k + 1][2] - L[k][2]); }
    }
    return y;
  }
  function deckAt(x, z) {
    const l = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (l) for (const b of l) if (inPoly(b, x, z)) return { b, y: profileY(b, x, z) };
    return null;
  }
  const inDeck = (x, z) => deckAt(x, z) !== null;
  function ground(x, z, y) {
    const d = deckAt(x, z);
    return d && y > d.y - BELOW && y < d.y + ABOVE ? d.y : null;
  }

  // ---- rails near the car
  const b2Vec2 = Box2D.Common.Math.b2Vec2;
  const live = new Map();   // bridge -> body
  function build(b) {
    const body = world().CreateBody(new Box2D.Dynamics.b2BodyDef());
    // outward side of each rail: away from the deck centre line
    for (const [x0, z0, x1, z1] of b.rails || []) {
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      let nx = dz / len, nz = -dx / len;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (inPoly(b, mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
      const sh = new Box2D.Collision.Shapes.b2PolygonShape();
      sh.SetAsOrientedBox(len / 2 + WH, WH, new b2Vec2(mx + nx * WH, mz + nz * WH), Math.atan2(dz, dx));
      const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = sh; fd.friction = SOLID.friction; fd.restitution = SOLID.restitution;
      body.CreateFixture(fd);
    }
    live.set(b, body);
  }
  function drop(b) { world().DestroyBody(live.get(b)); live.delete(b); }
  function update(x, z, y, off = false) {
    for (const b of list) {
      const [x0, z0, x1, z1] = b.box;
      const near = !off && x > x0 - NEAR && x < x1 + NEAR && z > z0 - NEAR && z < z1 + NEAR
        && y > profileY(b, x, z) - BELOW && y < profileY(b, x, z) + ABOVE;
      if (near && !live.has(b)) build(b);
      else if (!near && live.has(b)) drop(b);
    }
  }
  return {
    deckAt, inDeck, ground, update,
    items: () => list.map((b) => ({ name: b.name, kind: b.kind, length: b.length, width: b.width, osm: b.osm })),
    stats: () => ({ bridges: list.length, railsLive: [...live.keys()].map((b) => b.name || b.osm[0]) }),
  };
}

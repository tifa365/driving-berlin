// Camera collision for the chase camera: keeps the camera out of the city mesh and
// in sight of the car by shortening the boom (camera -> car line) when the mesh is
// in the way. No dependency: each occluder mesh gets a lazily built 2D grid of its
// triangles in world X/Z (4 m cells), a segment is walked cell by cell and tested
// against those triangles only (double-sided, front/back recorded).
//
// Occluder convention (allow-list): ONLY visible meshes with `userData.world === true`
// count - the city mesh (streamed tiles; js/stream.js sets
// it). Anything else added to the scene (props, eggs, ramps, balloon, edge glass,
// overlays) is ignored automatically; do NOT set `world` on such objects. Grids are
// built on first use and dropped with the geometry.
//
// Solids: the photogrammetric surface is closed like terrain (buildings = roof +
// facades on the street surface), so along the camera -> car segment a front-face
// hit enters solid and a back-face hit leaves it. Tree crowns, poles, signs, wires
// are part of the same surface, so each solid interval is classified:
//   - `isBuilding(x, z)` given (footprint mask, build_buildings.py): kept only if at
//     least `bldFrac` of its length lies over a building footprint (trees and street
//     furniture never move the camera; the ghost silhouette shows the car);
//   - else (no footprints loaded) the old heuristic: thinner than `thin` / tree
//     crowns (`isTree`) thinner than `treeThin` are ignored.
// The camera is put on the car side of the kept interval nearest the car, minus a margin.
//
// Over the car (bridges, the Stadtbahn viaduct, station hall roofs, arcades, gateways,
// canopies) never moves the camera - the ghost silhouette shows the car instead. Test,
// per raw interval BEFORE merging, independent of the footprint data: take the point
// `overIn` m inside the interval from its car-side end (deep enough that an eave or a
// balcony is passed and a facade behind it is found) and cast a HORIZONTAL ray at the
// car point's height (road + pivot) from the car toward the spot under it, `overPast` m
// beyond. If that ray enters no solid of >= `thin` m (a wall standing on the street;
// poles and trunks are thinner; faces the car is inside of - webbed photogrammetry under
// bridges - are ignored), the street at car height is free and the solid is over the car,
// not between camera and car: dropped. (A vertical probe does not work: the mesh under
// the Friedrichstrasse bridge has no road surface - the car point sits inside it.) Probe
// points less than `overAbove` m above the car point count as walls. Hysteresis: a spot
// found over the car stays so for overHold s (2 m cells), so entering / leaving a bridge
// cannot flip the verdict; when unsure the old rules apply. Cover: a deck found over the
// car (within coverNear m along the boom, >= coverAbove m above the car point, over a
// footprint, i.e. a bridge the mask does not know) puts the car "under cover" for
// coverHold s: every solid within coverNear of the car is ignored then too (webbed
// photogrammetry under bridges reaches down to car height in places).
import * as THREE from 'three';

const CELL = 4;                        // grid cell (m)
const _m = new THREE.Matrix4();

function buildGrid(mesh) {
  const geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index;
  mesh.updateWorldMatrix(true, false);
  const mw = mesh.matrixWorld;
  const n = pos.count;
  // world-space vertices (shared array when the mesh is already in world space)
  let P;
  if (mw.equals(_m.identity()) && pos.array instanceof Float32Array && pos.itemSize === 3 && !pos.isInterleavedBufferAttribute) P = pos.array;
  else {
    P = new Float32Array(n * 3); const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mw); P[3 * i] = v.x; P[3 * i + 1] = v.y; P[3 * i + 2] = v.z; }
  }
  const I = idx ? idx.array : null;
  const nt = idx ? idx.count / 3 | 0 : n / 3 | 0;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const nx = Math.max(1, Math.ceil((x1 - x0) / CELL)), nz = Math.max(1, Math.ceil((z1 - z0) / CELL));
  const cellRange = (t, out) => {   // cell bbox of triangle t
    let a, b, c;
    if (I) { a = I[3 * t]; b = I[3 * t + 1]; c = I[3 * t + 2]; } else { a = 3 * t; b = a + 1; c = a + 2; }
    const xa = P[3 * a], xb = P[3 * b], xc = P[3 * c], za = P[3 * a + 2], zb = P[3 * b + 2], zc = P[3 * c + 2];
    out[0] = Math.min(nx - 1, Math.floor((Math.min(xa, xb, xc) - x0) / CELL));
    out[1] = Math.min(nx - 1, Math.floor((Math.max(xa, xb, xc) - x0) / CELL));
    out[2] = Math.min(nz - 1, Math.floor((Math.min(za, zb, zc) - z0) / CELL));
    out[3] = Math.min(nz - 1, Math.floor((Math.max(za, zb, zc) - z0) / CELL));
  };
  const start = new Uint32Array(nx * nz + 1), r = [0, 0, 0, 0];
  for (let t = 0; t < nt; t++) {
    cellRange(t, r);
    for (let j = r[2]; j <= r[3]; j++) for (let i = r[0]; i <= r[1]; i++) start[j * nx + i + 1]++;
  }
  for (let k = 0; k < nx * nz; k++) start[k + 1] += start[k];
  const fill = start.slice(0, nx * nz), tris = new Uint32Array(start[nx * nz]);
  for (let t = 0; t < nt; t++) {
    cellRange(t, r);
    for (let j = r[2]; j <= r[3]; j++) for (let i = r[0]; i <= r[1]; i++) tris[fill[j * nx + i]++] = t;
  }
  return { P, I, nx, nz, x0, z0, x1, z1, y0, y1, start, tris, stamp: new Uint32Array(nt), pass: 0,
           flip: mw.determinant() < 0 };
}

// one grid per geometry, shared by the camera collision and js/ground.js (car on the mesh)
export const meshGrids = new WeakMap();
export const GRID_CELL = CELL;
export function meshGrid(mesh) {
  let g = meshGrids.get(mesh.geometry);
  if (!g) { g = buildGrid(mesh); meshGrids.set(mesh.geometry, g); }
  return g;
}

// Möller-Trumbore, double-sided. Segment o + t*d, t in [0, 1]. Pushes {t, front}.
function hitTris(g, list, from, to, o, d, out) {
  const P = g.P, I = g.I, pass = g.pass;
  for (let k = from; k < to; k++) {
    const t = list[k];
    if (g.stamp[t] === pass) continue;
    g.stamp[t] = pass;
    let a, b, c;
    if (I) { a = 3 * I[3 * t]; b = 3 * I[3 * t + 1]; c = 3 * I[3 * t + 2]; } else { a = 9 * t; b = a + 3; c = a + 6; }
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const e1x = P[b] - ax, e1y = P[b + 1] - ay, e1z = P[b + 2] - az;
    const e2x = P[c] - ax, e2y = P[c + 1] - ay, e2z = P[c + 2] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det;
    const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt < 0 || tt > 1) continue;
    // det = -d . (e1 x e2): det > 0 <=> ray against the CCW normal, a front face (three.js convention)
    out.push({ t: tt, front: (det > 0) !== g.flip });
  }
}

// all hits of segment a -> b with one mesh grid (2D DDA over the X/Z cells)
function segmentGrid(g, a, b, out) {
  const o = [a.x, a.y, a.z], d = [b.x - a.x, b.y - a.y, b.z - a.z];
  // clip the segment to the grid's box in X/Z (and reject on Y)
  let t0 = 0, t1 = 1;
  for (const [oo, dd, lo, hi] of [[o[0], d[0], g.x0, g.x1], [o[2], d[2], g.z0, g.z1], [o[1], d[1], g.y0, g.y1]]) {
    if (Math.abs(dd) < 1e-12) { if (oo < lo || oo > hi) return; continue; }
    let ta = (lo - oo) / dd, tb = (hi - oo) / dd; if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return;
  }
  g.pass = (g.pass + 1) >>> 0; if (g.pass === 0) { g.stamp.fill(0); g.pass = 1; }
  const fx = (o[0] + d[0] * t0 - g.x0) / CELL, fz = (o[2] + d[2] * t0 - g.z0) / CELL;
  let i = Math.min(g.nx - 1, Math.max(0, Math.floor(fx))), j = Math.min(g.nz - 1, Math.max(0, Math.floor(fz)));
  const di = d[0] > 0 ? 1 : -1, dj = d[2] > 0 ? 1 : -1;
  const ddx = Math.abs(CELL / d[0]), ddz = Math.abs(CELL / d[2]);   // t per cell
  let tx = d[0] !== 0 ? t0 + ((di > 0 ? i + 1 - fx : fx - i) * CELL) / Math.abs(d[0]) : Infinity;
  let tz = d[2] !== 0 ? t0 + ((dj > 0 ? j + 1 - fz : fz - j) * CELL) / Math.abs(d[2]) : Infinity;
  for (let guard = 0; guard < 10000; guard++) {
    const c = j * g.nx + i;
    hitTris(g, g.tris, g.start[c], g.start[c + 1], o, d, out);
    if (Math.min(tx, tz) > t1) break;
    if (tx < tz) { i += di; tx += ddx; if (i < 0 || i >= g.nx) break; }
    else { j += dj; tz += ddz; if (j < 0 || j >= g.nz) break; }
  }
}

export function createCamCollider(scene, opts = {}) {
  const o = {
    margin: 2.0,        // m kept between camera and the solid it backed away from
    side: 1.5,          // m, near-plane clearance around the camera (extra lines once pulled in)
    minBoom: 6,         // m, freeFrac floor (the boom itself stops at minFit)
    minFit: 14,         // m, shortest boom: the car still fits in the picture (35 deg FOV)
    keepFrac: 0.6,      // lift the rig before shortening the boom below this fraction
    maxElev: 1.45,      // rad (83 deg), steepest boom when lifted
    liftUp: 3,          // rad/s
    liftDown: 0.5,      // rad/s
    nearCar: 1.5,       // m, hits this close to the car point are ignored (road under the car)
    mergeGap: 4,        // m, solids with less free space between them are merged
    thin: 2.5,          // m, solids thinner than this along the line are ignored (poles, wires, cornices)
    treeThin: 16,       // m, tree crowns thinner than this are ignored (ghost silhouette shows the car)
    holdOut: 0.6,       // s the line must stay clear before easing back out
    outRate: 1.2,       // 1/s ease-out rate (exponential)
    isTree: null,       // (x, y, z) -> bool: point lies in a tree crown (fallback only)
    isBuilding: null,   // (x, z) -> bool: X/Z over a (buffered) building footprint; set = the gate
    bldFrac: 0.5,       // share of a solid's length over footprints for it to count as a building
    overProbe: true,    // solids over open road (bridges, roofs, arcades) never move the camera
    overIn: 4,          // m into the solid from its car-side end (along the boom): the probe point
    overAbove: 1.0,     // m, probe point at least this far above the car point (else: a wall)
    overPast: 1.5,      // m, the street must be free this far past the point under the probe
    overHold: 1.0,      // s a spot found to be over open street stays so
    coverNear: 15,      // m along the boom: a deck this close over the car puts the car "under cover" ...
    coverAbove: 3,      // m ... when it is this far above the car point (and over a footprint) ...
    coverHold: 1.5,     // s ... and for this long every solid within coverNear of the car is ignored
    overCell: 2,        // m, cell of that memory
    pivot: 2.5,         // m, car point above the road (index.html camCarPt)
    ...opts,
  };
  const grids = meshGrids;   // shared with js/ground.js
  const occluders = [];
  let frac = 1, clearFor = 0;
  const diag = [];   // solids that limited the boom in the last update() (tests: cause split)
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Q = new THREE.Vector3();
  const sphere = new THREE.Sphere(), seg = new THREE.Ray();
  const R = new THREE.Vector3(), U = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const P1 = new THREE.Vector3(), CT = new THREE.Vector3(), CB = new THREE.Vector3();   // probe point, probe ray
  let roadY = null, clock = 0, overN = 0, coverUntil = -1;
  const openMemo = new Map();   // "i,j" (overCell) -> clock until which the spot counts as over the car

  function collect() {
    occluders.length = 0;
    scene.traverseVisible((m) => { if (m.isMesh && m.userData.world) occluders.push(m); });
  }
  // all hits on segment a -> b, sorted, t in [0, 1]
  function hits(a, b) {
    const out = [], len = a.distanceTo(b);
    seg.origin.copy(a); seg.direction.subVectors(b, a).normalize();
    for (const m of occluders) {
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      sphere.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld);
      // sphere vs segment pre-cull
      const tc = Math.max(0, Math.min(len, Q.subVectors(sphere.center, a).dot(seg.direction)));
      if (seg.at(tc, Q).distanceToSquared(sphere.center) > sphere.radius * sphere.radius) continue;
      let g = grids.get(m.geometry);
      if (!g) { g = buildGrid(m); grids.set(m.geometry, g); }
      segmentGrid(g, a, b, out);
    }
    return out.sort((p, q) => p.t - q.t);
  }
  // the solid [a, b] (metres from the camera) is OVER the car: the street at car height
  // between the car and the point under it is free (horizontal probe at pivot height)
  function overCar(cam, car, L, a, b) {
    const road = roadY ?? car.y - o.pivot, len = b - a;
    P1.lerpVectors(cam, car, (b - Math.min(o.overIn, len / 2)) / L);    // probe point in the solid
    const y = road + o.pivot;
    if (P1.y < y + o.overAbove) return false;                            // at car height: a wall
    const key = Math.round(P1.x / o.overCell) + ',' + Math.round(P1.z / o.overCell);
    const m = openMemo.get(key);
    if (m !== undefined && m >= clock) return true;                      // hysteresis
    const dx = P1.x - car.x, dz = P1.z - car.z, hd = Math.hypot(dx, dz);
    if (hd < 0.5) return true;                                           // straight above the car
    const reach = hd + o.overPast + o.thin;
    CT.set(car.x, y, car.z); CB.set(car.x + dx / hd * reach, y, car.z + dz / hd * reach);
    const hs = hits(CT, CB);
    for (let i = 0; i < hs.length; i++) {
      const d = hs[i].t * reach;
      if (d > hd + o.overPast) break;
      if (!hs[i].front) continue;                       // leaving something the car is in (webbed underpass)
      const e = hs.slice(i + 1).find((h) => !h.front);  // entered a solid at car height: thick = a wall
      if (!e || (e.t * reach - d) >= o.thin) return false;
    }
    if (openMemo.size > 4096) for (const [k, v] of openMemo) if (v < clock) openMemo.delete(k);
    openMemo.set(key, clock + o.overHold);
    return true;
  }
  // share of the interval [a, b] (m from the camera) over building footprints, sampled every ~1 m
  function bldShare(cam, car, L, a, b) {
    const len = b - a, n = Math.max(3, Math.min(64, Math.ceil(len)));
    let k = 0;
    for (let i = 0; i < n; i++) { Q.lerpVectors(cam, car, (a + (i + 0.5) / n * len) / L); if (o.isBuilding(Q.x, Q.z)) k++; }
    return k / n;
  }
  // solid intervals along camera -> car (t: 0 camera .. 1 car), metres
  function solids(cam, car) {
    const L = cam.distanceTo(car), hs = hits(cam, car), res = [];
    let inside = false, t0 = 0;
    if (hs.length && !hs[0].front) inside = true;                 // camera inside a solid
    for (const h of hs) {
      if ((1 - h.t) * L < o.nearCar) break;
      if (h.front) { if (!inside) { inside = true; t0 = h.t; } }
      else if (inside) { res.push({ a: t0 * L, b: h.t * L }); inside = false; }
    }
    if (inside) res.push({ a: t0 * L, b: L, open: true });         // reaches the car: car inside something
    // over the car (decks, roofs, arcades): out before merging, so they never join a wall
    const over = [], covered = clock < coverUntil;
    if (o.overProbe) for (let i = res.length - 1; i >= 0; i--) {
      const s = res[i];
      if (s.open) continue;
      if (covered && L - s.b <= o.coverNear) { s.cover = true; over.push(res.splice(i, 1)[0]); continue; }
      if (!overCar(cam, car, L, s.a, s.b)) continue;
      over.push(res.splice(i, 1)[0]);
      // a deck over a footprint right over the car: the car is under cover (see coverHold)
      if (L - s.b <= o.coverNear && P1.y - car.y >= o.coverAbove && (!o.isBuilding || bldShare(cam, car, L, s.a, s.b) >= o.bldFrac)) coverUntil = clock + o.coverHold;
    }
    overN += over.length;
    // photogrammetry is often layered shells (attic of the Brandenburger Tor: 4 shells
    // of < 1 m with 1-3 m gaps): solids closer than mergeGap count as one
    for (let i = res.length - 1; i > 0; i--) {
      if (!res[i].open && res[i].a - res[i - 1].b < o.mergeGap) { res[i - 1].b = res[i].b; res.splice(i, 1); }
    }
    const bld = o.isBuilding;
    for (const s of res) {
      s.len = s.b - s.a;
      if (bld) {   // footprint gate: sample the interval's X/Z every ~1 m
        s.bld = bldShare(cam, car, L, s.a, s.b) >= o.bldFrac;
        s.tree = !s.bld;
        s.keep = !s.open && s.bld && s.len >= o.thin;
      } else {
        Q.lerpVectors(cam, car, (s.a + s.b) / 2 / L);
        s.tree = !!(o.isTree && o.isTree(Q.x, Q.y, Q.z));
        s.bld = !s.tree;
        s.keep = !s.open && s.len >= (s.tree ? o.treeThin : o.thin);
      }
      Q.lerpVectors(cam, car, (s.a + s.b) / 2 / L); s.x = Q.x; s.z = Q.z;   // midpoint (diagnostics)
    }
    return { L, hits: hs.length, solids: res, over };
  }
  // free boom fraction for the full camera position `cam` and car point `car`
  function freeFrac(cam, car) {
    const r = solids(cam, car);
    let lim = 1;   // camera at cam + (car - cam) * (1 - f)
    for (const s of r.solids) if (s.keep) { lim = Math.min(lim, (r.L - s.b - o.margin) / r.L); diag.push(s); }
    // do not stop inside an ignored (thin) building part either; a crown may hold the camera
    for (const s of r.solids) if (!s.keep && !s.open && (s.bld || !o.isBuilding) && r.L * (1 - lim) >= s.a && r.L * (1 - lim) < s.b)
      { lim = Math.min(lim, (r.L - s.b - o.margin) / r.L); diag.push(s); }
    return Math.max(Math.min(1, o.minBoom / r.L), lim);
  }
  // free fraction with near-plane clearance: the main line plus four lines from
  // the car to points o.side metres right/left/above/below the camera
  function freeFracWide(cam, car, wide) {
    let f = freeFrac(cam, car);
    if (!wide && f >= 1) return f;
    R.subVectors(cam, car).cross(UP);
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    R.normalize().multiplyScalar(o.side);
    U.subVectors(cam, car).cross(R).normalize().multiplyScalar(-o.side);
    for (const [a, s] of [[R, 1], [R, -1], [U, 1], [U, -1]]) f = Math.min(f, freeFrac(B.copy(cam).addScaledVector(a, s), car));
    return f;
  }
  // the rig (camera and look point) turned up about the car by `a` radians
  const rq = new THREE.Quaternion(), axis = new THREE.Vector3(), V0 = new THREE.Vector3(), Lk = new THREE.Vector3();
  function elevation(v) { return Math.atan2(v.y, Math.hypot(v.x, v.z)); }
  function lifted(cam, car, a, out) {
    if (a <= 0) return out.copy(cam);
    axis.subVectors(cam, car).cross(UP);
    if (axis.lengthSq() < 1e-9) return out.copy(cam);
    rq.setFromAxisAngle(axis.normalize(), a);
    return out.subVectors(cam, car).applyQuaternion(rq).add(car);
  }
  let lift = 0, liftTarget = 0, searchIn = 0, lowerFor = 0;
  const LIFTS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];   // rad, candidate extra elevation
  return {
    opts: o, solids, hits, collect,   // hits()/solids() use the occluder list of the last collect() (update() calls it)
    get frac() { return frac; }, get lift() { return lift; }, diag,
    get over() { return overN; },   // over-the-car solids ignored in the last update() (all lines)
    get covered() { return clock < coverUntil; },
    reset() { frac = 1; clearFor = 0; lift = liftTarget = 0; searchIn = 0; lowerFor = 0; openMemo.clear(); coverUntil = -1; },
    // cam: full camera position, look: look point, car: boom pivot at the car.
    // Moves cam and look in place (same view of the car, rig turned up by `lift`
    // and shortened by `frac`); returns frac. dt: seconds since the last call.
    // extra: more car points (nose, tail) whose lines to the camera must be free too
    update(cam, look, car, dt, extra = []) {
      collect(); diag.length = 0; overN = 0;
      clock += dt; roadY = car.y - o.pivot;
      // build one not yet needed grid per call, so first contact with a mesh does not hitch
      for (const m of occluders) if (!grids.has(m.geometry)) { grids.set(m.geometry, buildGrid(m)); break; }
      const L = cam.distanceTo(car);
      const maxLift = Math.max(0, o.maxElev - elevation(V0.subVectors(cam, car)));
      const keepLen = Math.min(L, Math.max(o.minFit, o.keepFrac * L));
      // full test (main line, near-plane lines, car ends); the lift search uses the main line only
      const fAt = (a, cheap) => {
        if (cheap) return freeFrac(lifted(cam, car, Math.min(a, maxLift), A), car);
        let f = freeFracWide(lifted(cam, car, Math.min(a, maxLift), A), car, frac < 1 || a > 0);
        for (const q of extra) f = Math.min(f, freeFrac(A, q));
        return f;
      };
      // 1) when the boom would get short, look for the lowest lift that keeps it long
      //    (a wall right behind the car: over the car, not into the wall); searched at
      //    most every 0.1 s, lowered again only after the lower pose has been free a while
      searchIn -= dt;
      if (searchIn <= 0) {
        searchIn = 0.1;
        let want = -1, best = 0, bestLen = -1;
        for (const a of LIFTS) {
          if (a > 0 && a > maxLift + 1e-6) break;
          const len = fAt(a, true) * L;
          if (len >= keepLen - 1e-3) { want = a; break; }     // lowest lift that keeps the boom long
          if (len > bestLen + 1) { bestLen = len; best = a; } // else the longest boom (+1 m: prefer low)
        }
        if (want < 0) want = best;
        if (want > liftTarget) { liftTarget = want; lowerFor = 0; }
        else if (want < liftTarget) { lowerFor += 0.1; if (lowerFor >= 2 * o.holdOut) { liftTarget = want; lowerFor = 0; } }
        else lowerFor = 0;
      }
      liftTarget = Math.min(liftTarget, maxLift);
      lift = liftTarget > lift ? Math.min(liftTarget, lift + o.liftUp * dt) : Math.max(liftTarget, lift - o.liftDown * dt);
      // 2) boom length at the current lift: pull in at once, ease out after holdOut
      const f = Math.max(Math.min(1, o.minFit / L), fAt(lift));
      if (f < frac - 1e-4) { frac = f; clearFor = 0; }
      else {
        clearFor = f >= 0.999 || f > frac + 0.02 ? clearFor + dt : 0;
        if (clearFor >= o.holdOut) frac = Math.min(f, frac + (f - frac) * Math.min(1, o.outRate * dt) + 0.02 * dt);
      }
      if (lift > 0 || frac < 1) {
        Lk.copy(look); lifted(cam, car, lift, B);        // B: lifted camera
        if (lift > 0) Lk.sub(car).applyQuaternion(rq).add(car);
        cam.lerpVectors(car, B, frac); look.lerpVectors(car, Lk, frac);
      }
      return frac;
    },
  };
}

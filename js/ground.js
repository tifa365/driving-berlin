// The car on the real mesh road. The level's height model (height.bin) is a coarse
// fallback that can be metres off the photogrammetric road (measured on the retired small level: LoD2 wall bases,
// 50 m blocks: -3.3 .. +0.9 m along Unter den Linden), so the car's height and
// attitude come from short vertical probes into the drawn city mesh instead.
//
// Meshes: every visible mesh with `userData.world` (the streamed tiles, js/stream.js),
// same set and same per-geometry X/Z triangle grid as the camera collision
// (js/camcollide.js meshGrid), so each grid is built once for both.
//
// Per wheel sample (front / back / right / left, like the old height-model
// attitude) a tracker follows the surface:
//   - probe the segment [y - down, r + step] straight under the sample, take the
//     highest surface in it: under tree crowns / bridges the road, not the canopy;
//   - r is a slope-limited copy of y (rises at most `slope` x distance driven, falls
//     at once), so a curb (<= step) is climbed but a stall, a parked car or a hoarding
//     (rising more than `step` above the road within a few metres) is not: the car
//     drives through it at road height (obstacle switch off);
//   - no acceptable surface (hole, only a roof above, tile not loaded yet): hold the
//     last road-to-height-model offset and follow the height model with it; after
//     `holdT` s on hold a larger step (`reStep`, growing with the distance held) is
//     accepted again (the held height model drifted under a long canopy);
//   - `override` (ice on frozen water) replaces the mesh where it answers;
//   - a jump of the car (teleport, respawn) or no surface found yet: (re)acquire the
//     surface nearest to height model + last offset, from acquire m below to acquireUp m
//     above it (a bridge / viaduct deck over the street is never grabbed: the car stays on
//     the height model under it). The layer's pitch / roll never exceed maxTilt.
// These trackers only give the coarse plane (start, fallback). The car rides on the ride
// layer (`ride`, berlinDrive.ride): a plane fitted to probes over the whole footprint,
// keeping only samples within objTol / holeTol of the current layer (frozen-traffic
// remnants and bumps stick out, potholes drop out), low-passed over distance driven.
import * as THREE from 'three';
import { meshGrid, GRID_CELL } from './camcollide.js';

const _box = new THREE.Box3();

export function createGround(scene) {
  const meshes = [];
  const boxes = new WeakMap();   // mesh -> world X/Z/Y box (before its grid exists)
  function collect() {
    meshes.length = 0;
    scene.traverseVisible((m) => { if (m.isMesh && m.userData.world) meshes.push(m); });
  }
  function boxOf(m) {
    let b = boxes.get(m);
    if (!b) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      m.updateWorldMatrix(true, false);
      _box.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      b = [_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z];
      boxes.set(m, b);
    }
    return b;
  }
  // visit every surface height straight under (x, z) with lo <= y <= hi
  function each(x, z, lo, hi, f) {
    for (const m of meshes) {
      const b = boxOf(m);
      if (x < b[0] || x > b[3] || z < b[2] || z > b[5] || hi < b[1] || lo > b[4]) continue;
      const g = meshGrid(m);
      const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / GRID_CELL)));
      const j = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / GRID_CELL)));
      const c = j * g.nx + i, P = g.P, I = g.I, T = g.tris;
      for (let k = g.start[c], e = g.start[c + 1]; k < e; k++) {
        const t = T[k];
        let a, bb, cc;
        if (I) { a = 3 * I[3 * t]; bb = 3 * I[3 * t + 1]; cc = 3 * I[3 * t + 2]; } else { a = 9 * t; bb = a + 3; cc = a + 6; }
        const xa = P[a], za = P[a + 2], xb = P[bb], zb = P[bb + 2], xc = P[cc], zc = P[cc + 2];
        const d = (zb - zc) * (xa - xc) + (xc - xb) * (za - zc);
        if (d > -1e-12 && d < 1e-12) continue;                      // vertical (skirt) triangle
        const l1 = ((zb - zc) * (x - xc) + (xc - xb) * (z - zc)) / d;
        if (l1 < -1e-6 || l1 > 1 + 1e-6) continue;
        const l2 = ((zc - za) * (x - xc) + (xa - xc) * (z - zc)) / d, l3 = 1 - l1 - l2;
        if (l2 < -1e-6 || l3 < -1e-6) continue;
        const y = l1 * P[a + 1] + l2 * P[bb + 1] + l3 * P[cc + 1];
        if (y >= lo && y <= hi) f(y);
      }
    }
  }
  // highest surface in [lo, hi] under (x, z), or null
  function highest(x, z, lo, hi) {
    let best = null;
    each(x, z, lo, hi, (y) => { if (best === null || y > best) best = y; });
    return best;
  }
  // surface nearest to y0 within [y0 - r, y0 + up] (up defaults to r), or null
  function nearest(x, z, y0, r, up = r) {
    let best = null;
    each(x, z, y0 - r, y0 + up, (y) => { if (best === null || Math.abs(y - y0) < Math.abs(best - y0)) best = y; });
    return best;
  }
  return { collect, each, highest, nearest, get meshes() { return meshes; } };
}

export function createCarGround({ scene, groundAt, ...opts }) {
  const o = {
    step: 0.3,       // m, steepest step climbed at once (curbs), above the slope-limited road
    slope: 0.2,      // rise per metre driven the road reference follows (ramps up to 20 %)
    down: 4,         // m probed below the current height
    holdT: 0.3,      // s on hold before a reStep is accepted
    reStep: 0.8,     // m, step accepted after a hold ...
    reStepPerM: 0.04, // ... growing by this per metre driven on hold ...
    reStepMax: 2.5,  // ... up to this
    override: null,  // (x, z) -> height or null: surface that replaces the mesh (ice)
    acquire: 6,      // m, search below height model + offset when (re)acquiring ...
    // ... and above it only this far. Where a road passes under a viaduct / station / bridge the
    // photogrammetry has only the deck on top, no street below it (Alexanderstrasse under the
    // Stadtbahn at Jannowitzbruecke: deck +6.3 m; spot starts measured under decks at +5.7 .. +8.7 m):
    // a car (re)starting there must stay on the street (height model) instead of grabbing the deck,
    // which tilted it ~40 deg on the deck's edge curtain. The height model is up to ~2.3 m below
    // real streets (Gustav-Heinemann-Bruecke approach), so 3.5 m: margin on both sides.
    // build_spots.py RIDE_UP checks spot starts against the same band.
    acquireUp: 3.5,
    // tan, steepest pitch / roll the ride layer may give the car (0.3 = 16.7 deg): above the 20 %
    // ramps the trackers follow (slope) and kerb / roof-step tilts, far below any wrong surface
    maxTilt: 0.3,
    freshDist: 3,    // m driven after a (re)start within which the first mesh fit is taken at once
    jumpDist: 6,     // m the car moves in one update -> teleport, reacquire
    ...opts,
  };
  // ride layer (berlinDrive.ride, live): a plane fitted to the road under the car's
  // footprint, ignoring what sticks out of it (frozen-traffic remnants, bumps) or
  // drops into it (holes), then low-passed over distance driven (speed and frame rate
  // independent; a slow time term lets a standing car settle).
  const ride = {
    nAlong: 5, nAcross: 3, // probe grid over the footprint ...
    padAlong: 0.6,   // m, ... reaching this far beyond the axles ...
    padAcross: 0.35, // m, ... and beyond the wheels
    objTol: 0.18,    // m, samples higher than this above the layer are objects, not road
    holeTol: 0.25,   // m, samples lower than this under the layer are holes
    trimUp: 0.06,    // m, then refit (iters times) without samples this far above ...
    trimDown: 0.1,   // m, ... or below the fit: the plane settles on the road itself
    iters: 3,
    minFrac: 0.3,    // share of road samples needed to trust the fit ...
    holdDist: 4,     // m (standing: 2 s), ... else hold the layer (slope carried on) for this far, then take all samples
    riseSlope: 0.3,  // m per m driven, fastest rise of the layer (a kerb becomes a short ramp)
    winUp: 0.6, winDown: 1.2, // m, probe window around the layer (excludes canopies, bridges above)
    lenUp: 1.5,      // m driven to follow ~63 % of a rise (kerb up, ramp start)
    lenDown: 4,      // m driven to follow ~63 % of a fall
    lenAtt: 4,       // m, low-pass of pitch / roll
    tau: 0.5,        // s, time term of all filters (standing car)
    // m, tyre bottoms above the fitted road (index.html puts the model's tyre bottoms at y = 0):
    // < 0 sinks them a little (a slight sink reads better than any float).
    // Raise it if the car sinks visibly, lower it if it still floats.
    clearance: -0.01,
    ...(opts.ride || {}),
  };
  o.ride = ride;
  const ground = createGround(scene);
  const S = [0, 1, 2, 3].map(() => ({ ok: false, ice: false, y: 0, r: 0, off: 0, x: 0, z: 0, hold: 0, holdD: 0, hit: false }));
  let off0 = 0, last = null, hintY = null;   // hintY: known road height at the next (re)start (respawn pose)
  const out = { y: 0, pitch: 0, roll: 0, hits: 0, ms: 0, fit: 0, held: 0, src: '' };
  // updates per source of the layer (berlinDrive.carGround.stats, counts since load):
  // fit = plane through the mesh footprint, wheels = wheel trackers on the mesh,
  // carry = held with its slope over objects / holes, grid = no mesh, follows the height model
  const stats = { fit: 0, wheels: 0, carry: 0, grid: 0 };
  // layer state at the car centre: y (no clearance), tp / tr = slope along / across
  const lay = { y: 0, tp: 0, tr: 0, hold: 0, ok: false, mesh: false, g: 0 };
  let snap = true;
  // m driven since the last (re)start without a mesh fit yet (-1: had one): the first fit after a
  // teleport / respawn whose mesh was not there yet (tiles streaming, acquire band) is taken at once
  let fresh = 0;
  const su = [], sv = [], sy = [];

  function track(s, x, z, dt) {
    s.hit = false;
    const v = o.override ? o.override(x, z) : null;   // e.g. flat ice on frozen water
    if (v !== null && v !== undefined) {
      Object.assign(s, { ok: true, ice: true, y: v, r: v, off: 0, hold: 0, holdD: 0, hit: true, x, z });
      return;
    }
    if (s.ice) { s.ice = false; s.ok = false; }           // off the ice: find the mesh again
    const g = groundAt(x, z);
    if (s.ok) {
      const ds = Math.hypot(x - s.x, z - s.z);
      // on hold the accepted step grows with the distance held (the height model may
      // have drifted from the road), slowly enough that stalls / parked cars stay out
      const lim = s.hold >= o.holdT ? Math.max(s.y, s.r) + Math.min(o.reStepMax, o.reStep + o.reStepPerM * s.holdD)
        : s.r + o.step;
      const h = ground.highest(x, z, Math.min(s.y, s.r) - o.down, lim);
      if (h !== null) {
        s.r = h <= s.r || s.hold >= o.holdT ? h : Math.min(h, s.r + o.slope * ds + 0.002);
        s.y = h; s.off = s.r - g; s.hold = 0; s.holdD = 0; s.hit = true;
      } else {                                   // hold: the road's offset to the height model
        s.y = s.r = g + s.off; s.hold += dt; s.holdD += ds;
      }
    } else {
      const h = ground.nearest(x, z, g + off0, o.acquire, o.acquireUp);
      if (h !== null) { s.ok = true; s.y = s.r = h; s.off = h - g; s.hold = 0; s.holdD = 0; s.hit = true; }
      else s.y = s.r = g + off0;
    }
    s.x = x; s.z = z;
  }

  // least-squares plane y = a + b u + c v through the samples with keep(i); null if degenerate
  function fitPlane(keep) {
    let n = 0, U = 0, V = 0, Y = 0, UU = 0, VV = 0, UV = 0, UY = 0, VY = 0;
    for (let i = 0; i < sy.length; i++) {
      if (!keep(i)) continue;
      const u = su[i], v = sv[i], y = sy[i];
      n++; U += u; V += v; Y += y; UU += u * u; VV += v * v; UV += u * v; UY += u * y; VY += v * y;
    }
    if (n < 3) return null;
    // normal equations [n U V; U UU UV; V UV VV] [a b c] = [Y UY VY], Cramer
    const det = n * (UU * VV - UV * UV) - U * (U * VV - UV * V) + V * (U * UV - UU * V);
    if (Math.abs(det) < 1e-9) return n ? { a: Y / n, b: 0, c: 0, n } : null;
    const a = (Y * (UU * VV - UV * UV) - U * (UY * VV - UV * VY) + V * (UY * UV - UU * VY)) / det;
    const b = (n * (UY * VV - VY * UV) - Y * (U * VV - UV * V) + V * (U * VY - UY * V)) / det;
    const c = (n * (UU * VY - UV * UY) - U * (U * VY - UY * V) + Y * (U * UV - UU * V)) / det;
    return { a, b, c, n };
  }

  return {
    opts: o, ride, ground, samples: S, out, layer: lay, stats,
    // a teleport / respawn knows nothing about the new place: no offset carried over from the old one
    // y: the road height there when known (a respawn at a recorded safe pose): (re)acquire around it
    reset(y = null) { for (const s of S) s.ok = false; last = null; snap = true; off0 = 0; fresh = 0; hintY = Number.isFinite(y) ? y : null; },
    // car centre (x, z), heading h (three: forward = (sin h, -cos h)), half wheel base L,
    // half tread W, dt s. Returns { y, pitch (nose up), roll (right side up), hits }.
    update(x, z, h, L, W, dt) {
      const t0 = performance.now();
      let ds = 0;
      if (last) {
        ds = Math.hypot(x - last[0], z - last[1]);
        if (ds > o.jumpDist) { for (const s of S) s.ok = false; snap = true; ds = 0; off0 = 0; fresh = 0; }
      }
      last = [x, z];
      if (hintY !== null) { off0 = hintY - groundAt(x, z); hintY = null; }
      ground.collect();
      const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
      track(S[0], x + fx * L, z + fz * L, dt); track(S[1], x - fx * L, z - fz * L, dt);
      track(S[2], x + rx * W, z + rz * W, dt); track(S[3], x - rx * W, z - rz * W, dt);
      let n = 0, so = 0;
      for (const s of S) if (s.ok && !s.ice) { n++; so += s.off; }
      if (n) off0 = so / n;
      // wheel trackers: the coarse plane (fallback without mesh, and the (re)start)
      const ty = (S[0].y + S[1].y + S[2].y + S[3].y) / 4, ttp = (S[0].y - S[1].y) / (2 * L), ttr = (S[2].y - S[3].y) / (2 * W);
      const hit = S.some((s) => s.hit), gc = groundAt(x, z);
      // (re)start: teleport or first update -> the trackers' plane; the mesh appeared
      // under a layer that had none (tile loaded late) -> probe around the trackers
      if (snap || !lay.ok) Object.assign(lay, { y: ty, tp: ttp, tr: ttr, hold: 0, ok: true, g: gc });
      const re = !snap && !lay.mesh && hit;
      const P = re ? { y: ty, tp: ttp, tr: ttr } : lay;   // window / road test around this plane
      // footprint samples within a window around the current layer
      su.length = sv.length = sy.length = 0;
      const A = L + ride.padAlong, C = W + ride.padAcross, na = Math.max(2, ride.nAlong | 0), nc = Math.max(2, ride.nAcross | 0);
      for (let i = 0; i < na; i++) {
        const u = -A + (2 * A * i) / (na - 1);
        for (let j = 0; j < nc; j++) {
          const v = -C + (2 * C * j) / (nc - 1);
          const px = x + fx * u + rx * v, pz = z + fz * u + rz * v, pred = P.y + P.tp * u + P.tr * v;
          const ice = o.override ? o.override(px, pz) : null;
          const y = ice !== null && ice !== undefined ? ice : ground.highest(px, pz, pred - ride.winDown, pred + ride.winUp);
          if (y !== null) { su.push(u); sv.push(v); sy.push(y); }
        }
      }
      let fit = null, held = false;
      if ((snap || re) && sy.length) {   // start on the middle of what is there, level
        const m = [...sy].sort((p, q) => p - q);
        Object.assign(P, { y: m[m.length >> 1], tp: 0, tr: 0 });
      }
      lay.mesh = sy.length > 0 || hit;
      if (sy.length) {
        const res = (i) => sy[i] - (P.y + P.tp * su[i] + P.tr * sv[i]);
        const road = (i) => { const e = res(i); return e <= ride.objTol && e >= -ride.holeTol; };
        let k = 0;
        for (let i = 0; i < sy.length; i++) k += road(i);
        if (k >= ride.minFrac * na * nc) {
          fit = fitPlane(road);
          // trim: drop what sticks out above the last fit and refit -> the road floor
          for (let it = 0; it < ride.iters && fit; it++) {
            const f1 = fit, near = (i) => { if (!road(i)) return false; const e = sy[i] - (f1.a + f1.b * su[i] + f1.c * sv[i]); return e <= ride.trimUp && e >= -ride.trimDown; };
            const f2 = fitPlane(near);
            if (!f2 || f2.n < Math.max(3, ride.minFrac * na * nc) || f2.n === f1.n) break;
            fit = f2;
          }
          lay.hold = 0;
        } else if (lay.hold < ride.holdDist) {     // mostly objects / holes: carry the layer on
          lay.hold += ds + dt * 2; held = true;
        } else fit = fitPlane(() => true)           // held long enough: the surface really changed
          // too few samples in the window (a finer tile replaced a coarse one > winDown lower: measured
          // 1.3 m at Hackescher Markt, the car stayed on the coarse height): the wheel trackers' plane
          ?? (hit ? { a: ty, b: ttp, c: ttr, n: 0 } : null);
      } else if (hit) fit = { a: ty, b: ttp, c: ttr, n: 0 };  // footprint empty, wheels on mesh
      else held = true;                             // no mesh (canopy, tile not loaded): carry on
      if (held) lay.y += lay.mesh ? lay.tp * ds : gc - lay.g;   // with the slope / the height model
      lay.g = gc;
      if (fresh >= 0) fresh += ds;
      const first = fit && (fit.n > 0 || hit) && fresh >= 0 && fresh < o.freshDist;   // first mesh fit after a (re)start
      if (fit && (fit.n > 0 || hit)) fresh = -1;
      if (fit) {
        if (snap || first) Object.assign(lay, { y: fit.a, tp: fit.b, tr: fit.c });
        else {
          const e = fit.a - lay.y, ka = 1 - Math.exp(-(ds / ride.lenAtt + dt / ride.tau));
          lay.y += Math.min(ride.riseSlope * ds + 0.05 * dt, e * (1 - Math.exp(-(ds / (e > 0 ? ride.lenUp : ride.lenDown) + dt / ride.tau))));
          lay.tp += (fit.b - lay.tp) * ka; lay.tr += (fit.c - lay.tr) * ka;
        }
      }
      // no road tilts a car more than maxTilt: a steeper plane is a wrong surface under some wheels
      const mt = o.maxTilt;
      lay.tp = Math.max(-mt, Math.min(mt, lay.tp)); lay.tr = Math.max(-mt, Math.min(mt, lay.tr));
      snap = false;
      out.y = lay.y + ride.clearance; out.pitch = Math.atan(lay.tp); out.roll = Math.atan(lay.tr);
      out.hits = S.reduce((k, s) => k + s.hit, 0); out.fit = fit ? fit.n : 0; out.held = held;
      out.src = fit ? (fit.n ? 'fit' : 'wheels') : lay.mesh ? 'carry' : 'grid'; stats[out.src]++;
      out.ms = performance.now() - t0;
      return out;
    },
  };
}

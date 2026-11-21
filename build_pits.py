#!/usr/bin/env python3
"""Pits on a streamed level (build_stream.py): construction pits the car falls into.

Same detector as the small level (build_level.pit_layer), run on windows of the
L1 mesh (levels/<name>/tiles.json -> ../berlin_mesh_2025_wab/) instead of one
full-level raster (a 1 m grid over 4.4 x 4.1 km would be ~18 MB per layer):

  road model  : the level's height.bin (4 m), resampled to pit_layer's 2 m lattice
  buildings   : OSM footprints of walls.bin (build_walls.py, what the game collides
                with), rasterised at 0.5 m; without walls.bin: none
  water       : the level's water.bin

  --at LON LAT [--half M]  one window around a point (default 130 m half size)
  --scan                   the whole level in --chunk m chunks (75 m overlap): each
                           chunk is scanned, then every pit found gets its own
                           window (pit bbox + 40 m), overlapping windows merged

Output (levels/<name>/): pit.bin (uint8 masks of all windows, concatenated),
pit_floor.bin (float32 floor grids, concatenated), level.json["pit"] with
`windows` [{x0, n0, nx, nz, off, floor: {i0, j0, nx, nz, off}}] (off = element
offset into the file), `pits` (outline, floor, depth, area, lon/lat) and
`footprints` (OSM footprints of walls.bin covering a pit by more than half:
their walls would keep the car out - listed and warned about, not opened; none
on mitte_all so far). Re-runnable; --at merges into the
existing windows (a window overlapping the new one is replaced).

  python3 build_pits.py --name mitte_all --at 13.38218 52.51484
  nice -n 19 python3 build_pits.py --name mitte_all --scan
"""
import argparse, io, json, os, sys, tempfile, time, contextlib
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import merge_tiles as MT                 # noqa: E402
from merge_hybrid import geo_to_ecef     # noqa: E402
from build_level import raster_top, pit_layer, MASK_CELL, H_CELL, PIT_MIN   # noqa: E402

S4 = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)   # (E, N, U) -> (E, U, -N)
NOTE = ("windows: per window a uint8 mask (1 = pit; 1 m cells, row j = north n0 + j*cell, "
        "column i = east x0 + i*cell) at element offset `off` of pit.bin, and a float32 "
        "pit-floor grid (NaN off the pit) for cells i0..i0+nx-1, j0..j0+nz-1 of that window "
        "at element offset floor.off of pit_floor.bin; pits: outline [x, z], floor height, "
        "depth below the road model (m), area (m2), centre x/z and lon/lat; footprints: OSM "
        "building rings [[x, z], ...] of walls.bin that cover a pit by more than half (their "
        "walls block the way in: warning only); detector: build_level.pit_layer on the L1 mesh")


class Level:
    def __init__(self, name, mesh_src):
        self.dir = os.path.join(HERE, "levels", name)
        self.L = json.load(open(os.path.join(self.dir, "level.json")))
        o = self.L["origin"]
        self.lat0, self.lon0 = o["lat"], o["lon"]
        self.origin = geo_to_ecef(self.lat0, self.lon0, 0.0)
        self.R = MT.enu_basis(self.lat0, self.lon0)
        P = S4.copy(); P[:3, :3] = S4[:3, :3] @ self.R; P[:3, 3] = -(S4[:3, :3] @ self.R @ self.origin)
        self.Pinv, self.ZUPinv = np.linalg.inv(P), np.linalg.inv(MT.ZUP)
        doc = json.load(open(os.path.join(self.dir, "tiles.json")))
        self.tiles = doc["tiles"]
        self.l1 = [r for r in doc["tiles"] if r[1] == 1]
        self.mesh_src = mesh_src
        H = self.L["height"]
        self.H = H
        self.height = np.fromfile(os.path.join(self.dir, H["file"]), np.float32).reshape(H["nz"], H["nx"])
        W = self.L["water"]
        self.W = W
        self.water = np.fromfile(os.path.join(self.dir, W["file"]), np.uint8).reshape(W["nz"], W["nx"])
        self.rings = self._rings()

    def to_en(self, lon, lat):
        v = self.R @ (geo_to_ecef(lat, lon, 0.0) - self.origin)
        return v[0], v[1]

    def _rings(self):
        """walls.bin rings as (outer: bool, ring N x 2 in (E, N)) + corridors"""
        jp = os.path.join(self.dir, "walls.json")
        if not os.path.exists(jp):
            print("  (no walls.json: no building footprints)")
            return [], np.zeros((0, 5))
        m = json.load(open(jp))
        buf = open(os.path.join(self.dir, m["file"]), "rb").read()
        sc = m["scale"]
        RL = np.frombuffer(buf, np.int32, m["ringLen"]["count"], m["ringLen"]["offset"])
        R16 = np.frombuffer(buf, np.int16, m["rings"]["count"] * 2, m["rings"]["offset"]).reshape(-1, 2) * sc
        C16 = np.frombuffer(buf, np.int16, m["corridors"]["count"] * 5, m["corridors"]["offset"]).reshape(-1, 5) * sc
        out, o = [], 0
        for n in RL:
            r = R16[o:o + abs(n)].astype(np.float64); o += abs(n)
            out.append((n > 0, np.c_[r[:, 0], -r[:, 1]]))        # (x, z) -> (E, N)
        return out, C16

    # ---------- inputs on a window (E/N rectangle) ----------
    def prims(self, ext, margin=10.0, rows=None):
        sel = [r for r in (self.l1 if rows is None else rows)
               if r[3] + r[6] >= ext[0] - margin and r[3] - r[6] <= ext[2] + margin
               and -r[5] + r[6] >= ext[1] - margin and -r[5] - r[6] <= ext[3] + margin]
        prims = []
        for r in sel:
            M = np.eye(4); M[:3] = np.asarray(r[7:19], float).reshape(3, 4)
            T = self.Pinv @ M @ self.ZUPinv
            try:
                prims += MT.tile_primitives(os.path.join(self.mesh_src, r[0]), T, self.origin, self.R)
            except Exception as e:
                print(f"  ! {r[0]}: {e}", file=sys.stderr)
        return prims, len(sel)

    def height_on(self, ext, hx, hy):
        """road model on pit_layer's lattice (points ext + k * H_CELL), bilinear like gridAt"""
        H = self.H
        e = ext[0] + np.arange(hx) * H_CELL; n = ext[1] + np.arange(hy) * H_CELL
        fi = np.clip((e - H["x0"]) / H["cell"], 0, H["nx"] - 1); fj = np.clip((n - H["n0"]) / H["cell"], 0, H["nz"] - 1)
        J, I = np.meshgrid(fj, fi, indexing="ij")
        return ndimage.map_coordinates(self.height.astype(np.float64), [J, I], order=1, mode="nearest").astype(np.float32)

    def water_on(self, ext, mx, my):
        W = self.W
        e = ext[0] + (np.arange(mx) + 0.5) * MASK_CELL; n = ext[1] + (np.arange(my) + 0.5) * MASK_CELL
        i = np.floor((e - W["x0"]) / W["cell"]).astype(int); j = np.floor((n - W["n0"]) / W["cell"]).astype(int)
        ok = (i >= 0)[None] & (i < W["nx"])[None] & (j >= 0)[:, None] & (j < W["nz"])[:, None]
        return ok & (self.water[np.clip(j, 0, W["nz"] - 1)[:, None], np.clip(i, 0, W["nx"] - 1)[None]] == 1)

    def mask_on(self, ext, mx, my):
        """OSM footprints (outer rings minus courtyards minus carved corridors), 0.5 m, row 0 = south"""
        rings, cor = self.rings
        outer = Image.new("L", (mx, my), 0); hole = Image.new("L", (mx, my), 0)
        do, dh = ImageDraw.Draw(outer), ImageDraw.Draw(hole)
        px = lambda r: [((e - ext[0]) / MASK_CELL - 0.5, (n - ext[1]) / MASK_CELL - 0.5) for e, n in r]
        for is_outer, r in rings:
            if r[:, 0].max() < ext[0] or r[:, 0].min() > ext[2] or r[:, 1].max() < ext[1] or r[:, 1].min() > ext[3]:
                continue
            if len(r) >= 3:
                (do if is_outer else dh).polygon(px(r), fill=1)
        for x0, z0, x1, z1, rr in cor:
            if max(x0, x1) + rr < ext[0] or min(x0, x1) - rr > ext[2] or max(-z0, -z1) + rr < ext[1] or min(-z0, -z1) - rr > ext[3]:
                continue
            dh.line(px([(x0, -z0), (x1, -z1)]), fill=1, width=max(1, int(round(2 * rr / MASK_CELL))))
        return np.array(outer, bool) & ~np.array(hole, bool)

    def footprints_over(self, pit_cells):
        """outer rings covering pit cells (list of (E, N) 1 m cell centres) by > 50 % of the ring area"""
        out = []
        if not len(pit_cells):
            return out
        pmin, pmax = pit_cells.min(0) - 1, pit_cells.max(0) + 1
        S = set(map(tuple, np.floor(pit_cells).astype(int)))
        for is_outer, r in self.rings[0]:
            if not is_outer or r[:, 0].max() < pmin[0] or r[:, 0].min() > pmax[0] or r[:, 1].max() < pmin[1] or r[:, 1].min() > pmax[1]:
                continue
            lo = np.floor(r.min(0)).astype(int); hi = np.ceil(r.max(0)).astype(int)
            w, h = hi - lo + 1
            img = Image.new("L", (int(w), int(h)), 0)
            ImageDraw.Draw(img).polygon([(e - lo[0] - 0.5, n - lo[1] - 0.5) for e, n in r], fill=1)
            jj, ii = np.nonzero(np.array(img, bool))
            if not len(jj):
                continue
            inside = sum((i + lo[0], j + lo[1]) in S for i, j in zip(ii, jj))
            if inside > 0.5 * len(jj):
                out.append([[round(float(e), 2), round(float(-n), 2)] for e, n in r])
                print(f"  ! OSM footprint over a pit ({inside} of {len(jj)} m2 in the pit): its walls block the way in")
        return out

    # ---------- one window through pit_layer ----------
    def run(self, ext, quiet=False):
        ext = (np.floor(ext[0]), np.floor(ext[1]), np.ceil(ext[2]), np.ceil(ext[3]))
        mx = int(np.ceil((ext[2] - ext[0]) / MASK_CELL)) & ~1; my = int(np.ceil((ext[3] - ext[1]) / MASK_CELL)) & ~1
        t0 = time.time()
        prims, nt = self.prims(ext)
        if not prims:
            return None, ext
        top = raster_top(prims, ext[0], ext[1], 2 * mx, 2 * my, MASK_CELL / 2, colour=False)[0]
        del prims
        hx = int(np.ceil((ext[2] - ext[0]) / H_CELL)) + 1; hy = int(np.ceil((ext[3] - ext[1]) / H_CELL)) + 1
        height = self.height_on(ext, hx, hy)
        mask, water = self.mask_on(ext, mx, my), self.water_on(ext, mx, my)
        with tempfile.TemporaryDirectory() as td:
            with contextlib.redirect_stdout(io.StringIO()) if quiet else contextlib.nullcontext():
                res = pit_layer(top, mask, water, height, [], ext, self.to_en, (self.lon0, self.lat0), td)
            if res is not None:
                res["mask"] = np.fromfile(os.path.join(td, "pit.bin"), np.uint8).reshape(res["nz"], res["nx"])
                F = res["floor"]
                res["floorGrid"] = np.fromfile(os.path.join(td, "pit_floor.bin"), np.float32).reshape(F["nz"], F["nx"])
        if not quiet:
            print(f"  window x {ext[0]:.0f}..{ext[2]:.0f} z {-ext[3]:.0f}..{-ext[1]:.0f}: {nt} L1 tiles "
                  f"({time.time()-t0:.0f} s)")
        return res, ext


def coarse_scan(lv, lod=2, cell=2.0, min_area=120.0, min_depth=2.5):
    """Phase 1 of --scan: the whole level from one coarse LOD (L2: ~600 tiles, minutes
    instead of hours on L1) at `cell` m against the road model. Returns candidate
    depressions [{E0, N0, E1, N1, x, z, a, depth, maxDepth}] (bbox in E/N); water
    (dilated 6 m) is never a candidate. No rim / reachability test here: that is
    pit_layer's job on L1 in phase 2."""
    ex = lv.L["extent"]
    E0, N0 = ex["minX"], -ex["maxZ"]
    nx, ny = int((ex["maxX"] - E0) // cell), int((-ex["minZ"] - N0) // cell)
    top = np.full((ny, nx), np.nan, np.float32)
    rows = [r for r in lv.tiles if r[1] == lod]
    t0 = time.time()
    for k in range(0, len(rows), 25):
        prims, _ = lv.prims((E0, N0, E0 + nx * cell, N0 + ny * cell), rows=rows[k:k + 25])
        if prims:
            np.fmax(top, raster_top(prims, E0, N0, nx, ny, cell, colour=False)[0], out=top)
        del prims
        print(f"  L{lod} tiles {min(k + 25, len(rows))}/{len(rows)} ({time.time()-t0:.0f} s)", flush=True)
    H = lv.H
    e = E0 + (np.arange(nx) + 0.5) * cell; n = N0 + (np.arange(ny) + 0.5) * cell
    J, I = np.meshgrid((n - H["n0"]) / H["cell"], (e - H["x0"]) / H["cell"], indexing="ij")
    road = ndimage.map_coordinates(lv.height.astype(np.float64), [J, I], order=1, mode="nearest")
    dep = road - top
    wat = ndimage.binary_dilation(lv.water_on((E0, N0), nx * int(cell / MASK_CELL), ny * int(cell / MASK_CELL))
                                  .reshape(ny, int(cell / MASK_CELL), nx, int(cell / MASK_CELL)).any(axis=(1, 3)),
                                  iterations=int(round(6 / cell)))
    cand = np.isfinite(dep) & (np.nan_to_num(dep) > PIT_MIN) & ~wat
    cand = ndimage.binary_opening(cand)                 # single cells / 2 m gutters out
    lab, _ = ndimage.label(cand, structure=np.ones((3, 3)))
    out = []
    for k, s in enumerate(ndimage.find_objects(lab)):
        m = lab[s] == k + 1
        a = m.sum() * cell * cell
        dd = dep[s][m]
        if a < min_area or np.median(dd) < min_depth:
            continue
        jj, ii = np.nonzero(m)
        out.append({"E0": E0 + s[1].start * cell, "N0": N0 + s[0].start * cell,
                    "E1": E0 + s[1].stop * cell, "N1": N0 + s[0].stop * cell,
                    "x": round(float(E0 + (ii.mean() + s[1].start + 0.5) * cell), 1),
                    "z": round(float(-(N0 + (jj.mean() + s[0].start + 0.5) * cell)), 1),
                    "a": round(float(a)), "depth": round(float(np.median(dd)), 1),
                    "maxDepth": round(float(dd.max()), 1)})
    print(f"  coarse L{lod}: {len(out)} depression(s) >= {min_area:g} m2, median >= {min_depth:g} m "
          f"({time.time()-t0:.0f} s)")
    return out


def context(lv, x, z, poly):
    """what else is at a pit (level frame): distances to the level's tunnels, S-Bahn
    viaduct, bridges and water, so a ramp / trough / quay is not taken for a pit"""
    P = np.asarray(poly or [[x, z]], float)
    def dmin(Q):
        Q = np.asarray(Q, float).reshape(-1, 2)
        if not len(Q):
            return 1e9
        return float(np.sqrt(((P[:, None, :] - Q[None, :, :]) ** 2).sum(-1)).min())
    d, f = {}, os.path.join(lv.dir, "tunnels.json")
    if os.path.exists(f):
        T = json.load(open(f))
        d["tunnel"] = min([dmin(np.c_[e["x"], e["z"]]) for t in T["tubes"] for e in t["edges"]] + [1e9])
    f = os.path.join(lv.dir, "sbahn.json")
    if os.path.exists(f):
        S = json.load(open(f))
        d["sbahn"] = dmin(np.c_[S["x"], S["z"]]) - 10.0          # ~ deck half width
    f = os.path.join(lv.dir, "bridges.json")
    if os.path.exists(f):
        B = json.load(open(f))
        d["bridge"] = min([dmin(b["poly"]) for b in B["bridges"] if b.get("poly")] + [1e9])
    W = lv.W
    i0, j0 = int((x - 80 - W["x0"]) // W["cell"]), int((-z - 80 - W["n0"]) // W["cell"])
    sub = lv.water[max(0, j0):max(0, j0 + 160), max(0, i0):max(0, i0 + 160)]
    jj, ii = np.nonzero(sub)
    d["water"] = dmin(np.c_[W["x0"] + (ii + max(0, i0) + 0.5) * W["cell"], -(W["n0"] + (jj + max(0, j0) + 0.5) * W["cell"])]) if len(jj) else 1e9
    return {k: round(v, 1) for k, v in d.items() if v < 200}


def osm_sites(lv, path):
    """OSM construction polygons (osmium export ... -f geojsonseq) -> [(name, ring x/z)]"""
    out = []
    if not path or not os.path.exists(path):
        print(f"  (no OSM construction file {path}: candidates are not tagged)") if path else None
        return out
    for line in open(path):
        g = json.loads(line.strip("\x1e"))
        geo, p = g["geometry"], g["properties"]
        ring = geo["coordinates"][0][0] if geo["type"] == "MultiPolygon" else geo["coordinates"][0]
        xz = []
        for lon, lat in ring:
            e, n = lv.to_en(lon, lat)
            xz.append((e, -n))
        out.append((p.get("name") or p.get("@id") or "construction", np.array(xz)))
    return out


def in_ring(x, z, r):
    """point in polygon (even-odd)"""
    xs, zs = r[:, 0], r[:, 1]
    c = ((zs > z) != (np.roll(zs, 1) > z)) & (x < (np.roll(xs, 1) - xs) * (z - zs) / (np.roll(zs, 1) - zs + 1e-12) + xs)
    return bool(c.sum() % 2)


def crop(res):
    """window result -> compact window (mask cropped to the pit cells + 2 m)"""
    m = res["mask"]
    jj, ii = np.nonzero(m)
    j0, j1, i0, i1 = max(0, jj.min() - 2), min(m.shape[0], jj.max() + 3), max(0, ii.min() - 2), min(m.shape[1], ii.max() + 3)
    F = res["floor"]
    fl = np.full((j1 - j0, i1 - i0), np.nan, np.float32)
    # floor grid (cells F.i0.., F.j0.. of the window) into the cropped frame
    a0, a1 = max(j0, F["j0"]), min(j1, F["j0"] + F["nz"]); b0, b1 = max(i0, F["i0"]), min(i1, F["i0"] + F["nx"])
    fl[a0 - j0:a1 - j0, b0 - i0:b1 - i0] = res["floorGrid"][a0 - F["j0"]:a1 - F["j0"], b0 - F["i0"]:b1 - F["i0"]]
    return {"x0": float(res["x0"] + i0), "n0": float(res["n0"] + j0), "nx": int(i1 - i0), "nz": int(j1 - j0),
            "cell": 1.0, "mask": m[j0:j1, i0:i1].copy(), "floorGrid": fl, "pits": res["pits"]}


def scan(lv, a):
    """--scan / --scan-full -> levels/<name>/pit_scan[_full].json (review list, the pit
    layer is not touched). --scan: coarse depressions (L2) -> pit_layer on L1 around
    each. --scan-full: pit_layer on L1 over the whole level in --chunk m chunks (75 m
    overlap). Resumable: every finished window goes to <out>.partial (deleted at the
    end); a re-run with the same arguments skips those windows."""
    full = a.scan_full
    known = (lv.L.get("pit") or {}).get("pits", [])
    sites = osm_sites(lv, a.osm_construction)
    out = os.path.join(lv.dir, "pit_scan_full.json" if full else "pit_scan.json")
    part = out + ".partial"
    done = json.load(open(part)) if os.path.exists(part) else {"cands": None, "hits": {}}
    if full:
        ex = lv.L["extent"]
        E0, E1, N0, N1 = ex["minX"], ex["maxX"], -ex["maxZ"], -ex["minZ"]
        cands = [{"E0": float(e), "N0": float(n), "E1": float(min(e + a.chunk, E1)), "N1": float(min(n + a.chunk, N1)), "chunk": 1}
                 for n in np.arange(N0, N1, a.chunk - 75.0) for e in np.arange(E0, E1, a.chunk - 75.0)]
    else:
        cands = done["cands"] or coarse_scan(lv, lod=a.lod)
    done["cands"] = cands
    t0, n0 = time.time(), len(done["hits"])
    for k, c in enumerate(cands):
        if str(k) in done["hits"]:
            continue
        m = 0 if full else 40
        res, _ = lv.run((c["E0"] - m, c["N0"] - m, c["E1"] + m, c["N1"] + m), quiet=True)
        hits = [p for p in (res or {}).get("pits", [])
                if full or (c["E0"] - 5 <= p["x"] <= c["E1"] + 5 and c["N0"] - 5 <= -p["z"] <= c["N1"] + 5)]
        done["hits"][str(k)] = hits
        with open(part + ".tmp", "w") as f:
            json.dump(done, f, separators=(",", ":"))
        os.replace(part + ".tmp", part)
        nd = len(done["hits"]) - n0
        eta = (time.time() - t0) / nd * (len(cands) - len(done["hits"]))
        print(f"  {'chunk' if full else 'candidate'} {k+1}/{len(cands)} E {c['E0']:.0f}..{c['E1']:.0f} "
              f"N {c['N0']:.0f}..{c['N1']:.0f}: {len(hits)} pit(s)  [{len(done['hits'])}/{len(cands)} done, "
              f"{time.time()-t0:.0f} s, ~{eta/60:.0f} min left]", flush=True)
    found = []
    for k, c in enumerate(cands):
        c["l1"] = len(done["hits"][str(k)])
        for p in done["hits"][str(k)]:
            dup = [q for q in found if np.hypot(p["x"] - q["x"], p["z"] - q["z"]) < 15]
            if dup and dup[0]["a"] >= p["a"]:
                continue             # chunk overlap: keep the larger (uncut) outline
            for q in dup:
                found.remove(q)
            xs = [q[0] for q in p["p"]]; zs = [q[1] for q in p["p"]]
            q = {k_: p[k_] for k_ in ("lat", "lon", "x", "z", "a", "depth", "maxDepth", "floor")}
            q["size"] = [round(max(xs) - min(xs)), round(max(zs) - min(zs))]
            q["known"] = any(np.hypot(p["x"] - r["x"], p["z"] - r["z"]) < 5 for r in known)
            q["osm"] = [n for n, r in sites if in_ring(p["x"], p["z"], r)
                        or any(in_ring(u, v, r) for u, v in p["p"][::max(1, len(p["p"]) // 12)])]
            q["near"] = context(lv, p["x"], p["z"], p["p"])
            q["p"] = p["p"]
            found.append(q)
    with open(out, "w") as f:
        json.dump({"note": "build_pits.py " + ("--scan-full: pit_layer on L1 over the whole level"
                   if full else "--scan: pit_layer on L1 around coarse L" + str(a.lod) + " depressions") +
                   "; NOT in the game until added with --at LON LAT after review. near = metres to "
                   "tunnel / S-Bahn deck / bridge / water (< 200 m only); osm = OSM construction sites; "
                   "known = already in the game",
                   "windows": cands, "pits": found}, f, separators=(",", ":"))
    os.remove(part)
    print(f"{len(found)} pit(s) from {len(cands)} window(s) -> {out} ({time.time()-t0:.0f} s)")
    for q in sorted(found, key=lambda q: -q["a"]):
        print(f"  lat {q['lat']:.5f} lon {q['lon']:.5f}  x {q['x']:7.1f} z {q['z']:7.1f}  {q['a']:5d} m2 "
              f"{q['size'][0]}x{q['size'][1]} m  depth {q['depth']} (max {q['maxDepth']})"
              f"{'  [in game]' if q['known'] else ''}  osm={q['osm']}  near={q['near']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--at", type=float, nargs=2, metavar=("LON", "LAT"))
    g.add_argument("--scan", action="store_true", help="fast: coarse L2 pass, L1 only on candidates; "
                   "writes levels/<name>/pit_scan.json, does NOT change the pit layer")
    g.add_argument("--scan-full", action="store_true", help="exhaustive L1 scan in --chunk m chunks (hours); "
                   "writes levels/<name>/pit_scan_full.json, does NOT change the pit layer")
    ap.add_argument("--osm-construction", help="--scan: OSM construction polygons (geojsonseq) to tag candidates")
    ap.add_argument("--lod", type=int, default=2, help="--scan: coarse LOD")
    ap.add_argument("--half", type=float, default=130.0, help="--at: window half size, m")
    ap.add_argument("--chunk", type=float, default=400.0, help="--scan: chunk size, m")
    a = ap.parse_args()
    lv = Level(a.name, a.mesh_src)
    out = lv.dir
    print(f"level {a.name}: {len(lv.l1)} L1 tiles, {len(lv.rings[0])} footprint rings")

    jp = os.path.join(out, "level.json")
    old = json.load(open(jp)).get("pit") if a.at else None
    wins = []                     # cropped windows
    if old and "windows" in old:  # keep the windows of earlier --at runs
        pm = np.fromfile(os.path.join(out, old["file"]), np.uint8)
        pf = np.fromfile(os.path.join(out, old["floor"]["file"]), np.float32)
        for w in old["windows"]:
            F = w["floor"]
            wins.append({"x0": w["x0"], "n0": w["n0"], "nx": w["nx"], "nz": w["nz"], "cell": 1.0,
                         "mask": pm[w["off"]:w["off"] + w["nx"] * w["nz"]].reshape(w["nz"], w["nx"]),
                         "floorGrid": pf[F["off"]:F["off"] + F["nx"] * F["nz"]].reshape(F["nz"], F["nx"]),
                         "pits": [p for p in old["pits"] if w["x0"] <= p["x"] < w["x0"] + w["nx"]
                                  and w["n0"] <= -p["z"] < w["n0"] + w["nz"]]})

    def add(res):
        c = crop(res)
        E0, N0, E1, N1 = c["x0"], c["n0"], c["x0"] + c["nx"], c["n0"] + c["nz"]
        wins[:] = [w for w in wins if w["x0"] >= E1 or w["x0"] + w["nx"] <= E0 or w["n0"] >= N1 or w["n0"] + w["nz"] <= N0]
        wins.append(c)

    t0 = time.time()
    if a.scan or a.scan_full:
        scan(lv, a)
        return
    if a.at:
        e, n = lv.to_en(*a.at)
        print(f"window around lon {a.at[0]} lat {a.at[1]} = x {e:.1f} z {-n:.1f}")
        res, _ = lv.run((e - a.half, n - a.half, e + a.half, n + a.half))
        if res is None:
            print("no pit there")
        else:
            add(res)
    # ---------- write ----------
    pits, W, mparts, fparts, mo, fo = [], [], [], [], 0, 0
    for w in sorted(wins, key=lambda w: (w["n0"], w["x0"])):
        fl = w["floorGrid"]
        W.append({"x0": w["x0"], "n0": w["n0"], "nx": w["nx"], "nz": w["nz"], "cell": 1.0, "off": mo,
                  "floor": {"i0": 0, "j0": 0, "nx": w["nx"], "nz": w["nz"], "off": fo}})
        mparts.append(w["mask"].astype(np.uint8).ravel()); fparts.append(fl.astype(np.float32).ravel())
        mo += w["mask"].size; fo += fl.size
        pits += w["pits"]
    if not W:
        print("no pits -> nothing written")
        return
    np.concatenate(mparts).tofile(os.path.join(out, "pit.bin"))
    np.concatenate(fparts).tofile(os.path.join(out, "pit_floor.bin"))
    cells = []
    for w in W:
        m = np.concatenate(mparts)[w["off"]:w["off"] + w["nx"] * w["nz"]].reshape(w["nz"], w["nx"])
        jj, ii = np.nonzero(m)
        cells.append(np.c_[w["x0"] + ii + 0.5, w["n0"] + jj + 0.5])
    foot = lv.footprints_over(np.vstack(cells))
    L = json.load(open(jp))
    L["pit"] = {"file": "pit.bin", "floor": {"file": "pit_floor.bin"}, "windows": W, "pits": pits,
                "footprints": foot, "openWalls": [], "note": NOTE}
    tmp = jp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(L, f, separators=(",", ":"))
    os.replace(tmp, jp)
    print(f"{len(pits)} pit(s) in {len(W)} window(s): pit.bin {mo} B, pit_floor.bin {4*fo} B, "
          f"{len(foot)} footprint(s) over a pit -> {jp} ({time.time()-t0:.0f} s)")
    for p in pits:
        xs = [q[0] for q in p["p"]]; zs = [q[1] for q in p["p"]]
        print(f"  lat {p['lat']:.5f} lon {p['lon']:.5f}  x {p['x']} z {p['z']}  {p['a']} m2 "
              f"({max(xs)-min(xs):.0f} x {max(zs)-min(zs):.0f} m E x N), depth {p['depth']} m "
              f"(max {p['maxDepth']}), floor {p['floor']} m")


if __name__ == "__main__":
    main()

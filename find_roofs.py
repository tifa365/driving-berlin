#!/usr/bin/env python3
"""Roof routes: where in a streamed level could a car drive on roofs, and how far?

Offline check only (the answer is ROOF_ROUTES.md); nothing in the level is changed
except the optional review file levels/<name>/roofs.json.

Stages (cached in --work, default a scratch folder):
  raster   whole level, coarse LOD (L2) top surface at 1 m      -> top_L2.npy (~20-40 min)
  osm      OSM bridges / skywalks / parking decks / building tags in the level
           (osmium on the local extract, no network)            -> osm.json
  analyse  drivable roof cells -> roof areas -> link graph -> ranked candidates
                                                               -> cands.json
  refine   top --top candidates again from L1 at 0.5 m, with texture colour:
           same analysis, plus crops (height-shaded | texture)  -> refined.json, crops/
  (--all   runs raster, osm, analyse, refine)

Definitions (all limits are arguments):
  street      the level's road model height.bin (4 m, smooth street level)
  roof cell   top surface >= --min-rel (6 m) above the street
  flat cell   plane fit over a 3 x 3 cell window: slope <= --max-slope (10 deg) and the
              fit residual <= --rough (0.15 m); clutter (vents, lift housings, parapets,
              panels) fails this and becomes an obstacle
  flush link  neighbouring cells joined when |dz| <= --step (0.3 m)
  drop link   0.3 m < dz <= --drop (1.5 m) between two areas: one-way drop
  car fits    the drivable set eroded by --half-width (1.5 m: car 1.7 m + margin);
              what survives is where the car centre may be
  route       longest geodesic line through the car-centre set of one area (two BFS
              sweeps), i.e. the longest drive without leaving the roof
  buildings   OSM outer rings of walls.bin the area overlaps by >= 20 m2

  nice -n 19 python3 find_roofs.py --name mitte_all --all
"""
import argparse, json, math, os, subprocess, sys, time
from collections import deque
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
from build_pits import Level, in_ring            # noqa: E402
from build_level import raster_top              # noqa: E402

OSM_PBF = os.environ.get("OSM_PBF")   # local OSM extract (.osm.pbf): --pbf or env OSM_PBF
def need_pbf(p):
    if not p:
        sys.exit("no OSM extract: pass --pbf <berlin-latest.osm.pbf> or set OSM_PBF "
                 "(e.g. from download.geofabrik.de/europe/germany/berlin.html)")
    return p


# ---------------------------------------------------------------- raster
def grid(lv, cell):
    ex = lv.L["extent"]
    E0, N0 = ex["minX"], -ex["maxZ"]
    nx, ny = int((ex["maxX"] - E0) // cell), int((-ex["minZ"] - N0) // cell)
    return E0, N0, nx, ny


def stage_raster(lv, a):
    out = os.path.join(a.work, f"top_L{a.lod}.npy")
    if os.path.exists(out):
        print(f"  have {out}"); return
    cell = a.cell
    E0, N0, nx, ny = grid(lv, cell)
    top = np.full((ny, nx), np.nan, np.float32)
    rows = [r for r in lv.tiles if r[1] == a.lod]
    t0 = time.time()
    for k, r in enumerate(rows):
        # one tile at a time, rastered on its own window of the level grid
        i0 = max(0, int((r[3] - r[6] - E0) // cell)); i1 = min(nx, int((r[3] + r[6] - E0) // cell) + 1)
        j0 = max(0, int((-r[5] - r[6] - N0) // cell)); j1 = min(ny, int((-r[5] + r[6] - N0) // cell) + 1)
        if i1 <= i0 or j1 <= j0:
            continue
        prims, _ = lv.prims((E0, N0, E0 + nx * cell, N0 + ny * cell), rows=[r])
        if prims:
            sub = raster_top(prims, E0 + i0 * cell, N0 + j0 * cell, i1 - i0, j1 - j0, cell, colour=False)[0]
            np.fmax(top[j0:j1, i0:i1], sub, out=top[j0:j1, i0:i1])
        del prims
        if k % 25 == 24 or k == len(rows) - 1:
            print(f"  L{a.lod} tiles {k + 1}/{len(rows)} ({time.time()-t0:.0f} s)", flush=True)
    np.save(out, top)
    print(f"  -> {out} ({time.time()-t0:.0f} s)")


def road_on(lv, E0, N0, nx, ny, cell):
    H = lv.H
    e = E0 + (np.arange(nx) + 0.5) * cell; n = N0 + (np.arange(ny) + 0.5) * cell
    J, I = np.meshgrid((n - H["n0"]) / H["cell"], (e - H["x0"]) / H["cell"], indexing="ij")
    return ndimage.map_coordinates(lv.height.astype(np.float64), [J, I], order=1, mode="nearest").astype(np.float32)


# ---------------------------------------------------------------- osm
def _ll2xz(lv, coords):
    """lon/lat list -> level x/z (vectorised geo_to_ecef, WGS84)"""
    c = np.asarray(coords, float)
    A, E2 = 6378137.0, 6.69437999014e-3
    la, lo = np.radians(c[:, 1]), np.radians(c[:, 0])
    N = A / np.sqrt(1 - E2 * np.sin(la) ** 2)
    X = np.c_[N * np.cos(la) * np.cos(lo), N * np.cos(la) * np.sin(lo), N * (1 - E2) * np.sin(la)]
    v = (X - lv.origin) @ lv.R.T
    return np.c_[v[:, 0], -v[:, 1]]


def _num(v):
    try:
        return float(str(v).split(";")[0].replace(",", ".").replace("m", "").strip())
    except Exception:
        return None


def stage_osm(lv, a):
    """local extract -> osm.json: buildings (ring, name/address/levels/height/roof),
    skywalk / bridge / parking-deck candidates, named places (for naming roofs)"""
    out = os.path.join(a.work, "osm.json")
    if os.path.exists(out):
        print(f"  have {out}"); return
    b = lv.L.get("bbox") or [13.364, 52.504, 13.429, 52.541]
    pbf, gj = os.path.join(a.work, "mitte.osm.pbf"), os.path.join(a.work, "all.geojsonseq")
    if not os.path.exists(gj):
        subprocess.run(["osmium", "extract", "-b", ",".join(map(str, b)), "--overwrite", "-o", pbf, need_pbf(a.osm)], check=True)
        subprocess.run(["osmium", "export", "--overwrite", "-f", "geojsonseq", "-a", "type,id", "-o", gj, pbf], check=True)
    known = set()
    f = os.path.join(lv.dir, "bridges.json")
    if os.path.exists(f):
        for br in json.load(open(f))["bridges"]:
            known |= set(br.get("osm") or [])
    bld, links, decks, places = [], [], [], []
    seen = set()
    for line in open(gj):
        g = json.loads(line.strip("\x1e")); p = g["properties"]; geo = g["geometry"]
        oid = f"{p.get('@type')}/{p.get('@id')}"
        t = geo["type"]
        if (oid, t) in seen:          # osmium emits closed ways as line AND area: keep one of each
            continue
        seen.add((oid, t))
        if t == "Polygon":
            ring = geo["coordinates"][0]
        elif t == "MultiPolygon":
            ring = max((pp[0] for pp in geo["coordinates"]), key=len)
        elif t == "LineString":
            ring = geo["coordinates"]
        else:
            ring = [geo["coordinates"]]
        tags = {k: v for k, v in p.items() if not k.startswith("@")}
        name = p.get("name") or ((p.get("addr:street", "") + " " + p.get("addr:housenumber", "")).strip() or None)
        rec = None
        kind = None
        if p.get("building") == "bridge" or p.get("building:part") == "bridge" or p.get("man_made") == "bridge":
            kind = "building-bridge" if (p.get("building") or p.get("building:part")) else "man_made=bridge"
        elif "highway" in p and p.get("bridge") not in (None, "no") and p["highway"] not in ("street_lamp",):
            kind = "highway-bridge"
        elif p.get("highway") in ("footway", "corridor", "steps", "service", "path") and _num(p.get("layer")) and _num(p.get("layer")) > 0:
            kind = "raised-way"
        if kind and t != "Point" and (oid, "LineString" if t != "LineString" else "Polygon") not in seen:
            xz = _ll2xz(lv, ring)
            L = float(np.hypot(*np.diff(xz, axis=0).T).sum()) if len(xz) > 1 else 0.0
            links.append({"osm": oid, "kind": kind, "known": oid in known, "name": name, "len": round(L, 1),
                          "xz": np.round(xz, 1).tolist(), "lonlat": [round(float(np.mean([c[0] for c in ring])), 6), round(float(np.mean([c[1] for c in ring])), 6)],
                          "tags": {k: tags[k] for k in tags if k in ("highway", "bridge", "building", "layer", "level", "min_height", "height",
                                                                       "building:levels", "width", "covered", "indoor", "man_made", "access", "motor_vehicle")}})
        if (p.get("amenity") == "parking" and p.get("parking") in ("rooftop", "multi-storey")) or p.get("building") == "parking" \
                or p.get("parking") in ("rooftop", "multi-storey"):
            xz = _ll2xz(lv, ring)
            decks.append({"osm": oid, "name": p.get("name"), "parking": p.get("parking"), "building": p.get("building"),
                          "levels": p.get("building:levels"), "layer": p.get("layer"), "xz": np.round(xz, 1).tolist()})
        if p.get("building") and t in ("Polygon", "MultiPolygon"):
            xz = _ll2xz(lv, ring)
            bld.append({"osm": oid, "name": p.get("name"), "addr": (p.get("addr:street", "") + " " + p.get("addr:housenumber", "")).strip() or None,
                        "b": p.get("building"), "lv": _num(p.get("building:levels")), "h": _num(p.get("height")),
                        "minh": _num(p.get("min_height")), "roof": p.get("roof:shape"), "xz": np.round(xz, 1).tolist()})
        elif p.get("name") and t in ("Polygon", "MultiPolygon") and any(k in p for k in ("amenity", "tourism", "historic", "shop", "office", "leisure", "landuse", "place")):
            xz = _ll2xz(lv, ring)
            places.append({"osm": oid, "name": p["name"], "xz": np.round(xz, 1).tolist()})
    json.dump({"buildings": bld, "links": links, "decks": decks, "places": places}, open(out, "w"))
    print(f"  {len(bld)} buildings, {len(links)} bridge-like ways ({sum(not l['known'] for l in links)} not in bridges.json), "
          f"{len(decks)} parking decks, {len(places)} named places -> {out}")


# ---------------------------------------------------------------- analysis core
def surface_fit(top, cell):
    """3 x 3 plane fit per cell -> (slope deg, rms residual m); NaN-safe (NaN -> not flat)"""
    z = np.nan_to_num(top, nan=-1e4).astype(np.float64)
    k = np.ones((3, 3)) / 9.0
    gx = ndimage.correlate(z, np.array([[-1, 0, 1]] * 3) / 6.0, mode="nearest") / cell     # sum(x z) / sum(x^2)
    gy = ndimage.correlate(z, np.array([[-1, 0, 1]] * 3).T / 6.0, mode="nearest") / cell
    m = ndimage.correlate(z, k, mode="nearest"); m2 = ndimage.correlate(z * z, k, mode="nearest")
    var = m2 - m * m - (2.0 / 3.0) * ((gx * cell) ** 2 + (gy * cell) ** 2)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    bad = ndimage.maximum_filter(~np.isfinite(top), 3)
    slope[bad] = 90.0
    return slope.astype(np.float32), np.sqrt(np.maximum(var, 0)).astype(np.float32)


def drivable(top, rel, cell, a):
    """flat, smooth, no step to a flat neighbour > a.step -> bool"""
    slope, rough = surface_fit(top, cell)
    flat = (slope <= a.max_slope) & (rough <= a.rough) & np.isfinite(top)
    z = np.nan_to_num(top, nan=-1e4)
    cut = np.zeros_like(flat)
    for dj, di in ((0, 1), (1, 0)):
        a1 = (slice(0, z.shape[0] - dj), slice(0, z.shape[1] - di)); a2 = (slice(dj, None), slice(di, None))
        st = flat[a1] & flat[a2] & (np.abs(z[a1] - z[a2]) > a.step)
        cut[a1] |= st; cut[a2] |= st
    return flat & ~cut, slope


def geodesic(mask, cell):
    """longest geodesic line (m) through a boolean mask (8-connected, two Dijkstra sweeps)
    -> (length, path cells (j, i) of the end points)"""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra
    jj, ii = np.nonzero(mask)
    n = len(jj)
    if n < 2:
        return 0.0, None
    idx = -np.ones(mask.shape, np.int64); idx[jj, ii] = np.arange(n)
    rows, cols, w = [], [], []
    H, W = mask.shape
    for dj, di, d in ((0, 1, 1.0), (1, 0, 1.0), (1, 1, 1.4142), (1, -1, 1.4142)):
        j2, i2 = jj + dj, ii + di
        ok = (j2 < H) & (i2 >= 0) & (i2 < W)
        ok[ok] = mask[j2[ok], i2[ok]]
        rows.append(idx[jj[ok], ii[ok]]); cols.append(idx[j2[ok], i2[ok]]); w.append(np.full(ok.sum(), d * cell))
    G = coo_matrix((np.concatenate(w), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr()
    d0 = dijkstra(G, directed=False, indices=0)
    d0[~np.isfinite(d0)] = -1
    s = int(np.argmax(d0))
    d1, pred = dijkstra(G, directed=False, indices=s, return_predecessors=True)
    d1[~np.isfinite(d1)] = -1
    t = int(np.argmax(d1))
    path = [t]
    while pred[path[-1]] >= 0:
        path.append(int(pred[path[-1]]))
    return float(d1[t]), np.c_[jj[path], ii[path]]


def footprint_ids(osm, E0, N0, nx, ny, cell):
    """OSM building polygons -> int32 index raster (0 = none, k + 1 = osm buildings[k]); larger first so
    small parts drawn on top keep their own id"""
    img = Image.new("I", (nx, ny), 0); d = ImageDraw.Draw(img)
    B = osm["buildings"]
    order = sorted(range(len(B)), key=lambda k: -len(B[k]["xz"]))
    for k in order:
        r = np.asarray(B[k]["xz"])
        u = (r[:, 0] - E0) / cell - 0.5; v = (-r[:, 1] - N0) / cell - 0.5
        if u.max() < 0 or v.max() < 0 or u.min() > nx or v.min() > ny or len(r) < 3:
            continue
        d.polygon(list(zip(u, v)), fill=k + 1)
    return np.array(img, np.int32)


def analyse_grid(top, road, cell, a, fid=None):
    """the whole roof analysis on one raster (row 0 = south). Returns dict of rasters + areas + links."""
    rel = top - road
    drive, slope = drivable(top, rel, cell, a)
    elev = drive & (rel >= a.min_rel_low)
    # car centre set: >= half width from anything not drivable-elevated
    dist = ndimage.distance_transform_edt(elev) * cell
    C = elev & (dist >= a.half_width)
    lab, n = ndimage.label(C, structure=np.ones((3, 3)))
    # street access: the same car-centre set without the height limit
    Cg = drive & (ndimage.distance_transform_edt(drive) * cell >= a.half_width)
    labg, _ = ndimage.label(Cg, structure=np.ones((3, 3)))
    ground = labg[(rel < 1.5) & Cg]
    ground_lab = set(np.unique(ground).tolist()) - {0}
    areas = []
    objs = ndimage.find_objects(lab)
    for k, sl in enumerate(objs):
        m = lab[sl] == k + 1
        A = m.sum() * cell * cell
        r = rel[sl][m]
        if A < a.min_area or np.percentile(r, 50) < a.min_rel:
            continue
        g = labg[sl][m]
        acc = bool(set(np.unique(g).tolist()) & ground_lab)
        rec = {"id": k + 1, "a": float(A), "rel": float(np.median(r)), "relMin": float(r.min()), "relMax": float(r.max()),
               "z": float(np.median(top[sl][m])), "sl": sl, "ramp": acc,
               "slope": float(np.percentile(slope[sl][m], 90))}
        if fid is not None:
            f = fid[sl][m]
            u, c = np.unique(f[f > 0], return_counts=True)
            keep = c * cell * cell >= 20.0
            rec["bld"] = [int(x) - 1 for x in u[keep][np.argsort(-c[keep])]]
            rec["offFoot"] = float((f == 0).sum() * cell * cell)
        areas.append(rec)
    return {"rel": rel, "drive": drive, "elev": elev, "C": C, "lab": lab, "areas": areas, "edt": dist.astype(np.float32)}


def links_between(res, top, cell, a):
    """contacts between car-centre areas within a.gap m of each other: flush / drop / parapet"""
    lab, C, areas = res["lab"], res["C"], res["areas"]
    keep = np.zeros(lab.max() + 1, bool)
    for r in areas:
        keep[r["id"]] = True
    L = np.where(keep[lab], lab, 0)
    d, (nj, ni) = ndimage.distance_transform_edt(L == 0, return_indices=True)
    near = L[nj, ni]
    near[d * cell > a.gap] = 0
    hnear = top[nj, ni]
    out = {}
    H, W = L.shape
    for dj, di in ((0, 1), (1, 0)):
        a1 = (slice(0, H - dj), slice(0, W - di)); a2 = (slice(dj, None), slice(di, None))
        p, q = near[a1], near[a2]
        m = (p > 0) & (q > 0) & (p != q)
        if not m.any():
            continue
        P, Q = p[m], q[m]
        # top surface along the straight line between the two nearest car-centre cells
        pj, pi_ = nj[a1][m], ni[a1][m]; qj, qi = nj[a2][m], ni[a2][m]
        t = np.linspace(0, 1, 13)[:, None]
        sj = np.rint(pj + (qj - pj) * t).astype(int); si = np.rint(pi_ + (qi - pi_) * t).astype(int)
        prof = top[sj, si]                                           # 13 x K
        hp, hq = top[pj, pi_], top[qj, qi]
        pmax, pmin = np.nanmax(prof, 0), np.nanmin(np.where(np.isfinite(prof), prof, -1e4), 0)
        jj, ii = np.nonzero(m)
        for x, y, h1, h2, mx_, mn_, j, i in zip(P, Q, hp, hq, pmax, pmin, jj, ii):
            key = (min(x, y), max(x, y))
            hi_, lo_ = (h1, h2) if x == key[0] else (h2, h1)
            out.setdefault(key, []).append((hi_, lo_, mx_, mn_, j, i))
    links = []
    for (x, y), v in out.items():
        v = np.array(v)
        if len(v) * cell < a.half_width * 2:            # contact narrower than the car
            continue
        dz = float(np.median(v[:, 0] - v[:, 1]))
        hmax = np.maximum(v[:, 0], v[:, 1]); hmin = np.minimum(v[:, 0], v[:, 1])
        wall = float(np.median(v[:, 2] - hmax))         # >0: something raised between (parapet)
        hole = float(np.median(hmin - v[:, 3]))         # >0: gap / void between
        if hole > 1.0:
            kind = "gap"
        elif wall > a.step:
            kind = "parapet"
        elif abs(dz) <= a.step:
            kind = "flush"
        elif abs(dz) <= a.drop:
            kind = "drop"
        else:
            kind = "cliff"
        links.append({"a": int(x), "b": int(y), "kind": kind, "dz": round(dz, 2), "wall": round(wall, 2),
                      "w": round(len(v) * cell, 1), "j": int(np.median(v[:, 4])), "i": int(np.median(v[:, 5]))})
    return links


# ---------------------------------------------------------------- analyse (whole level, coarse)
def known_mask(lv, E0, N0, nx, ny, cell):
    """cells of things the game already drives on: bridges.json decks, S-Bahn viaduct (+-10 m)"""
    img = Image.new("L", (nx, ny), 0); d = ImageDraw.Draw(img)
    px = lambda xz: [((x - E0) / cell - 0.5, (-z - N0) / cell - 0.5) for x, z in xz]
    f = os.path.join(lv.dir, "bridges.json")
    if os.path.exists(f):
        for b in json.load(open(f))["bridges"]:
            if b.get("poly") and len(b["poly"]) >= 3:
                d.polygon(px(b["poly"]), fill=1)
    f = os.path.join(lv.dir, "sbahn.json")
    if os.path.exists(f):
        S = json.load(open(f))
        d.line(px(list(zip(S["x"], S["z"]))), fill=1, width=int(round(22 / cell)))
    return np.array(img, bool)


def name_of(osm, bids, x, z):
    B = osm["buildings"]
    for k in bids:
        if B[k].get("name"):
            return B[k]["name"]
    for pl in osm["places"]:
        r = np.asarray(pl["xz"])
        if len(r) >= 3 and r[:, 0].min() <= x <= r[:, 0].max() and r[:, 1].min() <= z <= r[:, 1].max() and in_ring(x, z, r):
            return pl["name"]
    for k in bids:
        if B[k].get("addr"):
            return B[k]["addr"]
    return None


def networks(res, links, top, cell, a, osm, lonlat, known=None, E0=0.0, N0=0.0, cutoff=40.0):
    """union areas over flush + drop links -> ranked route records"""
    areas = {r["id"]: r for r in res["areas"]}
    par = {k: k for k in areas}
    def f(k):
        while par[k] != k:
            par[k] = par[par[k]]; k = par[k]
        return k
    for l in links:
        if l["kind"] in ("flush", "drop") and l["a"] in par and l["b"] in par:
            par[f(l["a"])] = f(l["b"])
    groups = {}
    for k in areas:
        groups.setdefault(f(k), []).append(k)
    lab, C = res["lab"], res["C"]
    out = []
    for g, mem in groups.items():
        A = [areas[k] for k in mem]
        sl = tuple(slice(min(r["sl"][d].start for r in A), max(r["sl"][d].stop for r in A)) for d in (0, 1))
        # quick bbox prefilter: diagonal under the cutoff -> no long route possible
        diag = math.hypot(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) * cell
        if diag < cutoff:
            continue
        pad = int(a.gap / cell) + 1
        sl = (slice(max(0, sl[0].start - pad), sl[0].stop + pad), slice(max(0, sl[1].start - pad), sl[1].stop + pad))
        M = np.isin(lab[sl], mem)
        if len(mem) > 1:     # bridge the link contacts: halo cells between two members
            Mh = ndimage.binary_dilation(M, iterations=pad) & ~M
            M2 = M | (Mh & ndimage.binary_closing(M, iterations=pad))
        else:
            M2 = M
        L, ends = geodesic(M2, cell)
        if L < cutoff:
            continue
        ls = [l for l in links if l["a"] in mem and l["b"] in mem and l["kind"] in ("flush", "drop")]
        bids = []
        for r in A:
            for b in r.get("bld", []):
                if b not in bids:
                    bids.append(b)
        jj, ii = np.nonzero(M)
        cj, ci = sl[0].start + jj.mean(), sl[1].start + ii.mean()
        e, n = E0 + (ci + 0.5) * cell, N0 + (cj + 0.5) * cell
        x, z = e, -n
        kn = float(known[sl][M].mean()) if known is not None else 0.0
        # narrowest point of the route (bottleneck): the widest corridor 2 t that still joins both route ends,
        # t = distance to the nearest non-drivable cell; link contacts count as wide (their width is in links[].w)
        wmin = 0.0
        if ends is not None:
            ed = ndimage.distance_transform_edt(res["elev"][sl] | (M2 & ~M)) * cell * M2
            # anchors: the widest point within 15 m of each route end (the ends themselves sit in corners)
            r_ = int(15 / cell)
            anc = []
            for (je, ie) in (ends[0], ends[-1]):
                w_ = ed[max(0, je - r_):je + r_ + 1, max(0, ie - r_):ie + r_ + 1]
                aj, ai = np.unravel_index(np.argmax(w_), w_.shape)
                anc.append((max(0, je - r_) + aj, max(0, ie - r_) + ai))
            (j0, i0), (j1, i1) = anc
            for t in np.arange(a.half_width, 40.0, 0.5 * cell):
                lb, _ = ndimage.label(ed >= t, structure=np.ones((3, 3)))
                if lb[j0, i0] == 0 or lb[j0, i0] != lb[j1, i1]:
                    break
                wmin = 2 * t
        ln, la = lonlat(e, n)
        rec = {"x": round(x, 1), "z": round(z, 1), "lon": round(ln, 6), "lat": round(la, 6),
               "route": round(L, 1), "area": round(sum(r["a"] for r in A)), "parts": len(mem),
               "rel": round(float(np.median([r["rel"] for r in A])), 1), "relMax": round(max(r["relMax"] for r in A), 1),
               "relMin": round(min(r["relMin"] for r in A), 1),
               "buildings": len(bids), "bids": bids[:20], "ramp": any(r["ramp"] for r in A),
               "offFoot": round(sum(r.get("offFoot", 0) for r in A)),
               "links": [{k: l[k] for k in ("kind", "dz", "w", "wall")} for l in ls],
               "minWidth": round(wmin, 1) if wmin else None, "maxStep": round(max([abs(l["dz"]) for l in ls] + [0.0]), 2),
               "slope90": round(max(r["slope"] for r in A), 1), "known": round(kn, 2),
               "E0": round(E0 + sl[1].start * cell, 1), "N0": round(N0 + sl[0].start * cell, 1),
               "E1": round(E0 + sl[1].stop * cell, 1), "N1": round(N0 + sl[0].stop * cell, 1),
               "name": name_of(osm, bids, x, z)}
        if ends is not None:
            rec["ends"] = [[round(E0 + (sl[1].start + ends[k, 1] + 0.5) * cell, 1), round(-(N0 + (sl[0].start + ends[k, 0] + 0.5) * cell), 1)]
                           for k in (0, -1)]
            rec["_path"] = ends + np.array([sl[0].start, sl[1].start])     # route cells (j, i) of this raster
        rec["_mem"] = mem
        out.append(rec)
    for r in out:
        # long routes first, more buildings linked count up to 7, already-drivable things (bridges, S-Bahn) down
        r["score"] = round(r["route"] * (1 + 0.35 * max(0, min(r["buildings"], 7) - 1)) * (0.3 if r["known"] > 0.3 else 1.0), 1)
    out.sort(key=lambda r: -r["score"])
    return out


def lonlat_fn(lv):
    """level E/N -> lon/lat (inverse of the ENU basis, spherical-enough at level scale)"""
    def f(e, n):
        X = lv.origin + lv.R.T @ np.array([e, n, 0.0])
        lon = math.degrees(math.atan2(X[1], X[0]))
        p = math.hypot(X[0], X[1]); A, E2 = 6378137.0, 6.69437999014e-3
        lat = math.atan2(X[2], p * (1 - E2))
        for _ in range(5):
            N = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
            h = p / math.cos(lat) - N
            lat = math.atan2(X[2], p * (1 - E2 * N / (N + h)))
        return lon, math.degrees(lat)
    return f


def stage_analyse(lv, a):
    t0 = time.time()
    top = np.load(os.path.join(a.work, f"top_L{a.lod}.npy"))
    cell = a.cell
    E0, N0, nx, ny = grid(lv, cell)
    road = road_on(lv, E0, N0, nx, ny, cell)
    osm = json.load(open(os.path.join(a.work, "osm.json")))
    fid = footprint_ids(osm, E0, N0, nx, ny, cell)
    res = analyse_grid(top, road, cell, a, fid)
    print(f"  drivable {res['drive'].sum()/1e6:.2f} km2, elevated (>= {a.min_rel_low:g} m) {res['elev'].sum()/1e6:.3f} km2, "
          f"car-centre areas >= {a.min_area:g} m2 & median >= {a.min_rel:g} m: {len(res['areas'])} ({time.time()-t0:.0f} s)", flush=True)
    links = links_between(res, top, cell, a)
    from collections import Counter
    print(f"  links {dict(Counter(l['kind'] for l in links))} ({time.time()-t0:.0f} s)", flush=True)
    known = known_mask(lv, E0, N0, nx, ny, cell)
    nets = networks(res, links, top, cell, a, osm, lonlat_fn(lv), known, E0, N0)
    nets = [{kk: v for kk, v in r.items() if not kk.startswith("_")} for r in nets]
    json.dump({"limits": {k: getattr(a, k) for k in ("min_rel", "min_rel_low", "max_slope", "rough", "step", "drop", "half_width", "min_area", "gap")},
               "lod": a.lod, "cell": cell, "routes": nets}, open(os.path.join(a.work, "cands.json"), "w"), indent=0)
    np.save(os.path.join(a.work, "rel_L2.npy"), np.where(res["elev"], res["rel"], np.nan).astype(np.float16))
    print(f"  {len(nets)} routes >= 40 m ({time.time()-t0:.0f} s)")
    for r in nets[:40]:
        print(f"  {r['score']:7.0f} route {r['route']:5.0f} m  area {r['area']:6d}  bld {r['buildings']:2d} parts {r['parts']:2d} "
              f"rel {r['rel']:5.1f} ramp {int(r['ramp'])} known {r['known']:.2f} off {r['offFoot']:5d} x {r['x']:7.0f} z {r['z']:7.0f}  {r['name']}")


# ---------------------------------------------------------------- refine (candidates, L1)
def shade(top, rel, cell):
    """hillshade x height colour (grey below 3 m, then blue -> yellow -> red up to 40 m) -> uint8 RGB"""
    z = np.nan_to_num(top, nan=np.nanmin(top) if np.isfinite(top).any() else 0)
    gy, gx = np.gradient(z, cell)
    hs = np.clip(0.55 + 0.45 * (-gx * 0.6 + gy * 0.6 + 1) / np.sqrt(gx * gx + gy * gy + 1) - 0.45, 0.15, 1.0)
    t = np.clip(np.nan_to_num(rel, nan=0) / 40.0, 0, 1)
    stops = np.array([[40, 70, 160], [60, 170, 200], [240, 220, 90], [220, 60, 40]], float)
    x = t * 3; k = np.minimum(x.astype(int), 2); f = (x - k)[..., None]
    col = stops[k] * (1 - f) + stops[k + 1] * f
    col[np.nan_to_num(rel, nan=0) < 3] = 150
    return np.clip(col * hs[..., None], 0, 255).astype(np.uint8)


def crop_image(top, rel, rgb, cell, M, path, links_px, out, title, px=320):
    px = int(os.environ.get("ROOF_CROP_PX", px))
    """two panels (height-shaded | texture), route area outlined, route line red, links marked"""
    A = shade(top, rel, cell)
    B = rgb.copy() if rgb is not None else A.copy()
    edge = M & ~ndimage.binary_erosion(M)
    for im in (A, B):
        im[edge] = (255, 0, 255)
    ims = []
    for im in (A, B):
        I = Image.fromarray(im[::-1])               # north up
        sc = px / max(I.size)
        I = I.resize((max(1, int(I.size[0] * sc)), max(1, int(I.size[1] * sc))), Image.LANCZOS)
        d = ImageDraw.Draw(I)
        H = im.shape[0]
        if path is not None and len(path) > 1:
            d.line([((i + 0.5) * sc, (H - j - 0.5) * sc) for j, i in path], fill=(255, 30, 30), width=2)
        for (j, i, kind) in links_px:
            c = {"flush": (0, 255, 0), "drop": (255, 160, 0), "parapet": (0, 200, 255)}.get(kind, (255, 255, 255))
            d.ellipse([i * sc - 4, (H - j) * sc - 4, i * sc + 4, (H - j) * sc + 4], outline=c, width=2)
        ims.append(I)
    W = sum(i.size[0] for i in ims) + 6; Hh = max(i.size[1] for i in ims) + 16
    C = Image.new("RGB", (W, Hh), (20, 20, 20)); x = 0
    for i in ims:
        C.paste(i, (x, 16)); x += i.size[0] + 6
    ImageDraw.Draw(C).text((4, 2), title[:90], fill=(255, 255, 255))
    C.save(out, quality=72)


def stage_refine(lv, a):
    cand = json.load(open(a.cands or os.path.join(a.work, "cands.json")))["routes"]
    for c in cand:                     # hand-made spots: name + x/z window only
        c.setdefault("E0", min(c["xr"])); c.setdefault("E1", max(c["xr"]))
        c.setdefault("N0", -max(c["zr"])); c.setdefault("N1", -min(c["zr"]))
        c.setdefault("x", (c["E0"] + c["E1"]) / 2); c.setdefault("z", -(c["N0"] + c["N1"]) / 2)
        for kk in ("route", "area", "buildings", "rel"):
            c.setdefault(kk, 0)
        if "lon" not in c:
            c["lon"], c["lat"] = lonlat_fn(lv)(c["x"], -c["z"])
    if a.only:
        cand = [cand[k] for k in a.only]
    else:
        cand = cand[:a.top]
    osm = json.load(open(os.path.join(a.work, "osm.json")))
    cdir = os.path.join(a.work, "crops"); os.makedirs(cdir, exist_ok=True)
    outp = os.path.join(a.work, "refined_spots.json" if a.cands else "refined.json")
    done = json.load(open(outp)) if os.path.exists(outp) else {}
    cell = a.fine_cell
    lonlat = lonlat_fn(lv)
    for k, c in enumerate(cand):
        key = f"{c['x']:.0f}_{c['z']:.0f}"
        if key in done:
            continue
        t0 = time.time()
        m = 25.0
        E0, N0 = math.floor(c["E0"] - m), math.floor(c["N0"] - m)
        nx, ny = int(math.ceil((c["E1"] + m - E0) / cell)), int(math.ceil((c["N1"] + m - N0) / cell))
        prims, nt = lv.prims((E0, N0, E0 + nx * cell, N0 + ny * cell))
        top, rgb = raster_top(prims, E0, N0, nx, ny, cell, colour=True)
        del prims
        road = road_on(lv, E0, N0, nx, ny, cell)
        fid = footprint_ids(osm, E0, N0, nx, ny, cell)
        res = analyse_grid(top, road, cell, a, fid)
        links = links_between(res, top, cell, a)
        known = known_mask(lv, E0, N0, nx, ny, cell)
        nets = networks(res, links, top, cell, a, osm, lonlat, known, E0, N0, cutoff=20.0)
        # the fine network(s) inside the coarse candidate's footprint: the one nearest its centre with the longest route
        best = None
        for r in nets:
            dd = math.hypot(r["x"] - c["x"], r["z"] - c["z"])
            if dd < max(30.0, 0.5 * math.hypot(c["E1"] - c["E0"], c["N1"] - c["N0"])) or c.get("spot"):
                if best is None or r["score"] > best["score"]:
                    best = r
        clean = lambda r: {kk: v for kk, v in r.items() if not kk.startswith("_")} if r else None
        rec = {"coarse": {kk: c[kk] for kk in ("route", "area", "buildings", "rel", "name", "x", "z", "lon", "lat")}, "fine": clean(best),
               "fineAll": [{kk: r[kk] for kk in ("route", "area", "buildings", "rel", "x", "z", "name")} for r in nets[:5]],
               "tiles": nt, "window": [E0, N0, nx, ny, cell]}
        title = f"#{k+1} {c.get('name') or ''}  coarse {c['route']:.0f} m"
        if best is not None:
            mem = best["_mem"]
            M = np.isin(res["lab"], mem)
            path = best.get("_path")
            lp = [(l["j"], l["i"], l["kind"]) for l in links if l["a"] in mem and l["b"] in mem]
            title += f" | L1 {best['route']:.0f} m, {best['buildings']} bld, {best['rel']:.0f} m up"
            crop_image(top, res["rel"], rgb, cell, M, path, lp, os.path.join(cdir, f"{'s' if a.cands else ''}{k+1:02d}_{key}.jpg"), title)
        else:
            crop_image(top, res["rel"], rgb, cell, np.zeros_like(res["C"]), None, [], os.path.join(cdir, f"{'s' if a.cands else ''}{k+1:02d}_{key}.jpg"), title + " | L1: none")
        rec["crop"] = f"{'s' if a.cands else ''}{k+1:02d}_{key}.jpg"
        done[key] = rec
        json.dump(done, open(outp, "w"), indent=0)
        b = best or {}
        print(f"  #{k+1} {c.get('name')}: coarse {c['route']:.0f} m -> L1 {b.get('route', 0):.0f} m, {b.get('buildings', 0)} bld, "
              f"area {b.get('area', 0)}, w {b.get('minWidth', 0)}, ramp {b.get('ramp')} ({nt} tiles, {time.time()-t0:.0f} s)", flush=True)


# ---------------------------------------------------------------- hidden bridges (OSM ways vs the coarse raster)
def stage_bridges(lv, a):
    """OSM bridge-like ways not in bridges.json (skywalks = building=bridge, raised footways, footway /
    service bridges off the water) sampled on the coarse top raster: deck (or skywalk roof) height above
    the street, flat width across the way (cells within a.step of the centre line height), water below"""
    top = np.load(os.path.join(a.work, f"top_L{a.lod}.npy"))
    cell = a.cell
    E0, N0, nx, ny = grid(lv, cell)
    road = road_on(lv, E0, N0, nx, ny, cell)
    osm = json.load(open(os.path.join(a.work, "osm.json")))
    W = lv.W
    out = []
    for l in osm["links"]:
        t = l["tags"]
        if l["known"] or l["len"] < 12:
            continue
        hw = t.get("highway")
        if l["kind"] == "highway-bridge" and hw not in ("footway", "path", "service", "cycleway", "corridor", "pedestrian", "track", "steps"):
            continue
        if hw == "steps":
            continue
        xz = np.asarray(l["xz"], float)
        if l["kind"] in ("building-bridge", "man_made=bridge") and len(xz) >= 4:
            # area: use the long axis (PCA) through the polygon as the centre line
            c = xz.mean(0); u, sv, vt = np.linalg.svd(xz - c); d = vt[0]
            pr = (xz - c) @ d
            line = np.array([c + pr.min() * d, c + pr.max() * d])
            wpoly = float(2 * np.abs((xz - c) @ vt[1]).max())
        else:
            line, wpoly = xz, None
        seg = np.diff(line, axis=0); L = np.hypot(*seg.T)
        pts, dirs = [], []
        for p0, sg, ln in zip(line[:-1], seg, L):
            if ln < 1e-6:
                continue
            for f in np.arange(0.1, 0.9001, max(0.05, 2.0 / ln)):
                pts.append(p0 + f * sg); dirs.append(sg / ln)
        if not pts:
            continue
        pts, dirs = np.array(pts), np.array(dirs)
        def at(P):
            i = ((P[:, 0] - E0) / cell).astype(int); j = ((-P[:, 1] - N0) / cell).astype(int)
            ok = (i >= 0) & (i < nx) & (j >= 0) & (j < ny)
            v = np.full(len(P), np.nan); v[ok] = top[j[ok], i[ok]]
            r = np.full(len(P), np.nan); r[ok] = road[j[ok], i[ok]]
            return v, r
        h, r = at(pts)
        widths = []
        nrm = np.c_[-dirs[:, 1], dirs[:, 0]]
        offs = np.arange(-12, 12.01, cell)
        for p, n_, hc in zip(pts, nrm, h):
            if not np.isfinite(hc):
                continue
            prof, _ = at(p[None] + offs[:, None] * n_[None])
            ok = np.abs(prof - hc) <= a.step
            c0 = len(offs) // 2; lo = hi = c0
            while lo - 1 >= 0 and ok[lo - 1]: lo -= 1
            while hi + 1 < len(ok) and ok[hi + 1]: hi += 1
            widths.append((hi - lo + 1) * cell)
        rel = h - r
        wi = ((pts[:, 0] - W["x0"]) / W["cell"]).astype(int); wj = ((-pts[:, 1] - W["n0"]) / W["cell"]).astype(int)
        okw = (wi >= 0) & (wi < W["nx"]) & (wj >= 0) & (wj < W["nz"])
        water = bool(lv.water[wj[okw], wi[okw]].any()) if okw.any() else False
        ln_, la_ = l["lonlat"]
        out.append({"osm": l["osm"], "kind": l["kind"], "name": l["name"], "tags": t, "len": l["len"],
                    "x": round(float(pts[:, 0].mean()), 1), "z": round(float(pts[:, 1].mean()), 1), "lon": ln_, "lat": la_,
                    "rel": round(float(np.nanmedian(rel)), 1) if np.isfinite(rel).any() else None,
                    "relMin": round(float(np.nanmin(rel)), 1) if np.isfinite(rel).any() else None,
                    "flatW": round(float(np.median(widths)), 1) if widths else None,
                    "flatWmin": round(float(np.percentile(widths, 10)), 1) if widths else None,
                    "polyW": round(wpoly, 1) if wpoly else None, "water": water})
    out.sort(key=lambda b: -(b["len"] * (b["rel"] or 0 > 3)))
    json.dump(out, open(os.path.join(a.work, "bridges_hidden.json"), "w"), indent=0)
    print(f"  {len(out)} OSM bridge-like ways not in bridges.json")
    for b in out:
        if (b["rel"] or 0) >= 3:
            print(f"  {b['kind'][:14]:14s} {b['osm']:16s} {str(b['name'] or '')[:26]:26s} {b['tags'].get('highway') or b['tags'].get('building') or '':9s} "
                  f"len {b['len']:5.0f} rel {b['rel']:5.1f} flatW {b['flatW']:4.1f} (p10 {b['flatWmin']:4.1f}) polyW {b['polyW']} "
                  f"water {int(b['water'])} x {b['x']:.0f} z {b['z']:.0f} {b['lat']:.5f},{b['lon']:.5f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True)
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--work", default=os.environ.get("ROOF_WORK", "/tmp/roofs"))
    ap.add_argument("stages", nargs="*", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--lod", type=int, default=2)
    ap.add_argument("--cell", type=float, default=1.0)
    ap.add_argument("--osm", "--pbf", dest="osm", default=OSM_PBF)
    ap.add_argument("--min-rel", type=float, default=6.0, help="roof: median height above the street, m")
    ap.add_argument("--min-rel-low", type=float, default=3.0, help="cells below this count as street level")
    ap.add_argument("--max-slope", type=float, default=10.0, help="deg")
    ap.add_argument("--rough", type=float, default=0.15, help="3x3 plane-fit rms residual, m")
    ap.add_argument("--step", type=float, default=0.3, help="flush step, m")
    ap.add_argument("--drop", type=float, default=1.5, help="one-way drop, m")
    ap.add_argument("--half-width", type=float, default=1.5, help="car half width + margin, m")
    ap.add_argument("--min-area", type=float, default=150.0, help="car-centre area, m2")
    ap.add_argument("--gap", type=float, default=3.0, help="link search distance between areas, m")
    ap.add_argument("--top", type=int, default=30, help="refine: candidates")
    ap.add_argument("--only", type=int, nargs="*", help="refine: these candidate ranks (0-based)")
    ap.add_argument("--cands", help="refine: hand-made spots file {routes: [{name, xr: [x0, x1], zr: [z0, z1], spot: 1}]}")
    ap.add_argument("--fine-cell", type=float, default=0.5, help="refine: L1 raster cell, m")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    lv = Level(a.name, a.mesh_src)
    st = ["raster", "osm", "analyse", "refine"] if a.all else a.stages
    for s in st:
        print(f"== {s}", flush=True)
        globals()["stage_" + s](lv, a)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bridges over water as drivable decks -> levels/<name>/bridges.json (js/bridges.js).

Every OSM road / path bridge over water in the level (`highway=*` + `bridge=*`, all
classes incl. footway / cycleway / path / steps; `man_made=bridge` outline areas give the
true deck shape). Railway-only bridges are skipped (the S-Bahn egg has the viaduct).
  - deck polygon: the `man_made=bridge` area that holds the highway way(s), else the way
    buffered by width / 2 (`width` tag, else a guess per class);
  - centre line with a deck height profile (1 m stations) from the L1 mesh top surface
    (build_level.raster_top on a narrow window around the bridge): 30th percentile across
    the deck core (railings, lamp posts, truss / arch members above the deck drop out),
    median + gaussian along;
  - rails: deck edges where the car would drop off (closed water outside, or the mesh
    outside >= 2 m below the deck); bridge heads (road at deck height outside) stay open.
    Head edges (outward normal along the centre line's end tangent) test RAW water only:
    the 20 m closing fills narrow land between two arms (the Bode-Museum forecourt closed
    both Monbijou bridges' museum heads, 2026-11-21).
  - checks (the build stops on 1, warns on 2):
      1. never a rail across a head mouth: |across| < hw, -HEAD_IN..+HEAD_OUT m along the end
         tangent of either centre line end, hw = max(path width, HEAD_MIN) / 2 + 1 m (kept
         inside the deck sides), so a car can always drive off the way it came;
      2. at least one head reaches drivable ground (no raw water, no drop, no step 2-4 m
         beyond the end); `heads` in the json records [x, z, ground, open width] per end.
Over water = the centre line crosses the level's water mask closed by 20 m (water.bin has
the bridges carved out already).

  nice -n 19 python3 build_bridges.py --name mitte_all       (~2-4 min, one process)
Reads local disk only: levels/<name>/osm_water.json (the cached OSM water + bridge
query of build_level.osm_water), water.bin, tiles.json, the L1 mesh.
"""
import argparse, json, math, os, sys, time
from collections import OrderedDict
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from matplotlib.path import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_sbahn import frame, tiles_near, prims_of, REPO   # noqa: E402
from build_level import raster_top                          # noqa: E402

CELL = 0.5            # m, mesh top raster
CLOSE_R = 20          # m (water.bin cells), closing radius of the water mask (bridge gaps)
MIN_W = 2.2           # m, narrowest deck a car fits on
DROP = 2.0            # m, outside this far below the deck -> rail
HEAD_MIN = 4.0        # m, narrowest head mouth (path width below this is widened)
HEAD_IN, HEAD_OUT = 6.0, 3.0   # m, head mouth along the end tangent (inside / outside the end point)
HEAD_STEP = 1.5       # m, ground beyond a head this far above the deck: "step" (stairs up)
SKIP_HW = {"corridor", "construction", "proposed", "elevator", "platform", "bus_stop", "raceway"}
WIDTH = {"motorway": 16, "trunk": 16, "primary": 16, "secondary": 14, "tertiary": 12,
         "residential": 10, "unclassified": 9, "living_street": 8, "service": 5, "pedestrian": 6,
         "track": 4, "footway": 3.5, "path": 3, "bridleway": 3, "cycleway": 3, "steps": 3}
RANK = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified",
        "living_street", "service", "pedestrian", "track", "cycleway", "footway", "path", "bridleway", "steps"]


def num(v):
    try:
        return float(str(v).split()[0].replace(",", "."))
    except (ValueError, IndexError):
        return None


def length(P):
    return float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0.0


def resample(P, step):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    s = np.linspace(0, d[-1], max(2, int(round(d[-1] / step)) + 1))
    return np.c_[np.interp(s, d, P[:, 0]), np.interp(s, d, P[:, 1])]


def strip_ring(P, half):
    """polyline buffered by `half` (mitred offsets, square ends) -> closed ring"""
    T = np.gradient(P, axis=0)
    T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
    N = np.c_[-T[:, 1], T[:, 0]]
    L, R = P + N * half, P - N * half
    return np.vstack([L, R[::-1]])


def robust(prof):
    """deck profile (NaN = no mesh) -> smooth, gap-free profile and the number of stations
    replaced. A deck is a gentle curve: stations far off a trimmed quadratic fit are roofs
    over it (a footbridge through a building), lamp posts, or holes down to the water ->
    the fit stands in there. The first pass ignores the top 40 % (roofs)."""
    s = np.arange(len(prof), dtype=float)
    fin = np.isfinite(prof)
    ok = fin & (prof <= np.nanpercentile(prof, 60) + 1.0)
    fit = np.full(len(prof), np.nanmedian(prof))
    for tol in (3.0, 1.5, 0.8, 0.5):
        if ok.sum() < 3:
            break
        deg = 2 if ok.sum() >= 12 and len(prof) >= 15 else 1 if ok.sum() >= 3 else 0
        fit = np.polyval(np.polyfit(s[ok], prof[ok], deg), s)
        ok = fin & (np.abs(prof - fit) < tol)
    out = np.where(ok, prof, fit)
    return out, int((~ok).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    a = ap.parse_args()
    lv = os.path.join(HERE, "levels", a.name)
    level = json.load(open(os.path.join(lv, "level.json")))
    to_xz = frame(level)
    WT = level["water"]
    water = np.fromfile(os.path.join(lv, WT["file"]), np.uint8).reshape(WT["nz"], WT["nx"]).astype(bool)
    tiles = json.load(open(os.path.join(lv, "tiles.json")))
    osm = json.load(open(os.path.join(lv, "osm_water.json")))
    t0 = time.time()

    def wcell(x, z):
        i = np.floor((np.asarray(x) - WT["x0"]) / WT["cell"]).astype(int)
        j = np.floor((-np.asarray(z) - WT["n0"]) / WT["cell"]).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < WT["nx"]) & (j < WT["nz"])
        return np.clip(i, 0, WT["nx"] - 1), np.clip(j, 0, WT["nz"] - 1), ok

    yy, xx = np.mgrid[-CLOSE_R:CLOSE_R + 1, -CLOSE_R:CLOSE_R + 1]
    disk = xx * xx + yy * yy <= CLOSE_R * CLOSE_R

    def closed_water(pts, pad=40):
        """water mask closed by CLOSE_R m in a window around pts -> f(x, z) bool array"""
        i, j, _ = wcell(pts[:, 0], pts[:, 1])
        i0, i1 = max(0, i.min() - pad - CLOSE_R), min(WT["nx"], i.max() + pad + CLOSE_R + 1)
        j0, j1 = max(0, j.min() - pad - CLOSE_R), min(WT["nz"], j.max() + pad + CLOSE_R + 1)
        win = np.pad(water[j0:j1, i0:i1], CLOSE_R)
        cw = ndimage.binary_closing(win, disk)[CLOSE_R:-CLOSE_R, CLOSE_R:-CLOSE_R]

        def f(x, z):
            ii, jj, ok = wcell(x, z)
            ii, jj = ii - i0, jj - j0
            inw = ok & (ii >= 0) & (jj >= 0) & (ii < cw.shape[1]) & (jj < cw.shape[0])
            return inw & cw[np.clip(jj, 0, cw.shape[0] - 1), np.clip(ii, 0, cw.shape[1] - 1)]
        return f

    # ---- OSM: highway bridge ways + man_made=bridge areas ----
    ways, areas = [], []
    for el in osm.get("elements", []):
        t, g = el.get("tags", {}), el.get("geometry")
        if el.get("type") != "way" or not g:
            continue
        P = np.array([to_xz(p["lon"], p["lat"]) for p in g])
        if t.get("man_made") == "bridge" and len(P) > 3:
            areas.append({"id": el["id"], "tags": t, "P": P, "path": Path(P), "ways": []})
        elif "highway" in t and t.get("bridge", "no") != "no" and t["highway"] not in SKIP_HW:
            ways.append({"id": el["id"], "tags": t, "P": P})
    print(f"osm: {len(ways)} highway bridge ways, {len(areas)} man_made=bridge areas")

    for w in ways:   # into the area that holds most of it
        S = resample(w["P"], 1.0)
        best, bf = None, 0.0
        for ar in areas:
            f = ar["path"].contains_points(S, radius=-2.0).mean()   # matplotlib: either sign grows by orientation
            f = max(f, ar["path"].contains_points(S, radius=2.0).mean())
            if f > bf:
                best, bf = ar, f
        w["area"] = best if bf >= 0.5 else None
        if w["area"]:
            best["ways"].append(w)

    cands = []
    for ar in areas:
        if not ar["ways"]:
            continue    # railway / unmapped (no highway on it): not a road
        cands.append({"area": ar, "ways": ar["ways"]})
    for w in ways:
        if not w["area"]:
            cands.append({"area": None, "ways": [w]})

    tile_cache = OrderedDict()

    def prims(row):
        if row[0] not in tile_cache:
            tile_cache[row[0]] = prims_of(row, a.mesh_src)
            if len(tile_cache) > 24:
                tile_cache.popitem(last=False)
        else:
            tile_cache.move_to_end(row[0])
        return tile_cache[row[0]]

    out, skipped, dead_end = [], [], []
    for c in cands:
        ws, ar = c["ways"], c["area"]
        kinds = sorted({w["tags"]["highway"] for w in ws}, key=lambda k: RANK.index(k) if k in RANK else 99)
        main_w = max(ws, key=lambda w: (-(RANK.index(w["tags"]["highway"]) if w["tags"]["highway"] in RANK else 99), length(w["P"])))
        names = [n for n in ([ar["tags"].get("name")] if ar else []) + [w["tags"].get("name") for w in ws] if n]
        name = names[0] if names else None
        ids = ([f"way/{ar['id']}"] if ar else []) + [f"way/{w['id']}" for w in ws]
        # centre line: free way = the way; area = its principal axis spanning the outline
        if ar:
            Q = ar["P"][:-1] if np.allclose(ar["P"][0], ar["P"][-1]) else ar["P"]
            c0 = Q.mean(0)
            _, _, vt = np.linalg.svd(Q - c0)
            ax = vt[0]
            pr = (Q - c0) @ ax
            line = np.array([c0 + ax * pr.min(), c0 + ax * pr.max()])
            ring = Q
            span = pr.max() - pr.min()
            across = (Q - c0) @ np.array([-ax[1], ax[0]])
            area_m2 = 0.5 * abs(np.dot(Q[:, 0], np.roll(Q[:, 1], 1)) - np.dot(Q[:, 1], np.roll(Q[:, 0], 1)))
            width = area_m2 / max(span, 1.0)
            wtag = None
        else:
            line = main_w["P"]
            wtag = num(main_w["tags"].get("width"))
            width = wtag or WIDTH.get(main_w["tags"]["highway"], 4.0)
            ring = None
        line = resample(line, 1.0)
        L = length(line)
        cw = closed_water(line)
        wet = cw(line[:, 0], line[:, 1])
        rec = {"name": name, "kind": kinds[0], "kinds": kinds, "osm": ids, "length": round(L, 1),
               "width": round(float(width), 1), "water": round(float(wet.sum()), 0)}
        if wet.sum() < 5:
            continue    # not over water
        if ring is None:
            ring = strip_ring(line, width / 2)
        if width < MIN_W:
            rec.update(drivable=False, why=f"too narrow ({width:.1f} m < {MIN_W} m)")
            skipped.append(rec); out.append(rec); continue
        # ---- mesh top in a narrow window ----
        pts = np.vstack([ring, line])
        x0, x1 = pts[:, 0].min() - 5, pts[:, 0].max() + 5
        n0, n1 = -pts[:, 1].max() - 5, -pts[:, 1].min() + 5
        nx, ny = int((x1 - x0) / CELL) + 1, int((n1 - n0) / CELL) + 1
        top = np.full((ny, nx), -np.inf, np.float32)
        for r in tiles_near(tiles, pts, 10):
            tt, _ = raster_top(prims(r), x0, n0, nx, ny, CELL, colour=False)
            np.fmax(top, np.where(np.isfinite(tt), tt, -np.inf), out=top)
        top[~np.isfinite(top)] = np.nan
        GX = x0 + (np.arange(nx) + 0.5) * CELL
        GZ = -(n0 + (np.arange(ny) + 0.5) * CELL)
        gx, gz = np.meshgrid(GX, GZ)
        inside = Path(np.vstack([ring, ring[:1]])).contains_points(np.c_[gx.ravel(), gz.ravel()]).reshape(gx.shape)

        def top_at(x, z):
            i = np.clip(((np.asarray(x) - x0) / CELL).astype(int), 0, nx - 1)
            j = np.clip(((-np.asarray(z) - n0) / CELL).astype(int), 0, ny - 1)
            return top[j, i]

        # stations: along s, across v of every inside cell against the centre line segments
        T = np.gradient(line, axis=0); T /= np.maximum(np.hypot(*T.T), 1e-9)[:, None]
        cells = np.c_[gx[inside], gz[inside]]
        ctop = top[inside]
        kd = cKDTree(line)
        k = kd.query(cells)[1] if len(cells) else np.zeros(0, int)
        v = np.abs(((cells - line[k]) * np.c_[-T[k, 1], T[k, 0]]).sum(1))
        core = max(0.8, min(width / 2 - 0.8, 4.0))
        prof = np.full(len(line), np.nan)
        for s in range(len(line)):
            sel = (k == s) & (v <= core) & np.isfinite(ctop)
            if sel.sum() >= 2:
                prof[s] = np.percentile(ctop[sel], 30)
        cov = float(np.isfinite(prof).mean())
        if cov < 0.5:
            rec.update(drivable=False, why=f"no deck in the mesh ({cov*100:.0f} % of the stations)")
            out.append(rec); skipped.append(rec); continue
        prof, nout = robust(prof)
        prof = ndimage.median_filter(prof, 7, mode="nearest")
        prof = ndimage.gaussian_filter1d(prof, 1.5, mode="nearest")
        # water surface under it (mesh over raw water cells near the line) -> deck really there?
        wi, wj, wok = wcell(gx, gz)
        wmask = wok & water[wj, wi] & np.isfinite(top)
        wy = float(np.nanpercentile(top[wmask], 20)) if wmask.sum() > 20 else None   # boats, trees, quay edges: low end
        slope = float(np.abs(np.diff(prof)).max()) if len(prof) > 1 else 0.0
        rec.update(deck=[round(float(prof.min()), 2), round(float(prof.max()), 2)], replaced=nout,
                   waterY=round(wy, 2) if wy is not None else None, maxSlope=round(slope, 3), coverage=round(cov, 2))
        if wy is not None and np.median(prof[wet]) < wy + 1.0:
            rec.update(drivable=False, why=f"no deck in the mesh (profile {np.median(prof[wet]):.1f} m ~ water {wy:.1f} m)")
            out.append(rec); skipped.append(rec); continue
        # ---- heads: where the centre line enters / leaves the deck ----
        # end point E, outward tangent t, mouth half width hw (path width, >= HEAD_MIN, + 1 m,
        # but inside the deck sides), ground beyond the head (raw water / drop / step / ok)
        wway = max([num(w["tags"].get("width")) or WIDTH.get(w["tags"]["highway"], 4.0) for w in ws])
        hw = min(max(wway, HEAD_MIN) / 2 + 1.0, max(width / 2 - 0.3, 1.0))
        heads = []
        for E, Pn, yE in ((line[0], line[1], prof[0]), (line[-1], line[-2], prof[-1])):
            t = (E - Pn) / max(float(np.hypot(*(E - Pn))), 1e-9)
            Q = np.array([E + t * o for o in (2.0, 3.0, 4.0)])
            wi_, wj_, wok_ = wcell(Q[:, 0], Q[:, 1])
            raw = bool((wok_ & water[wj_, wi_]).any())
            tq = top_at(Q[:, 0], Q[:, 1])
            fin = np.isfinite(tq)
            g = ("water" if raw else "drop" if fin.any() and np.nanmedian(tq) < yE - DROP
                 else "step" if fin.any() and np.nanmedian(tq) > yE + HEAD_STEP else "ok")
            heads.append({"E": E, "t": t, "n": np.array([-t[1], t[0]]), "y": float(yE), "ground": g})

        def head_edge(P0, nout):
            """sample points of a ring edge that face a head (outward normal along the end tangent,
            near that end): closed water does not count there (the closing fills narrow land
            between two arms, e.g. the Bode-Museum forecourt), only raw water or a real drop"""
            f = np.zeros(len(P0), bool)
            for h in heads:
                along = (P0 - h["E"]) @ h["t"]
                f |= (abs(float(nout @ h["t"])) > 0.5) & (along > -(width / 2 + 3.0)) & (along < 3.0)
            return f

        def in_mouth(P):
            """inside a head mouth: |across| < hw, along -HEAD_IN .. +HEAD_OUT of the end point"""
            f = np.zeros(len(P), bool)
            for h in heads:
                d = P - h["E"]
                f |= (np.abs(d @ h["n"]) < hw) & (d @ h["t"] > -HEAD_IN) & (d @ h["t"] < HEAD_OUT)
            return f

        # ---- rails: deck edges with a drop outside ----
        R = ring
        sa = 0.5 * np.sum(R[:, 0] * np.roll(R[:, 1], -1) - np.roll(R[:, 0], -1) * R[:, 1])
        rails = []
        for q in range(len(R)):
            A, B = R[q], R[(q + 1) % len(R)]
            el = float(np.hypot(*(B - A)))
            if el < 0.05:
                continue
            tdir = (B - A) / el
            nout = np.array([tdir[1], -tdir[0]]) if sa > 0 else np.array([-tdir[1], tdir[0]])
            m = max(1, int(round(el / 0.5)))     # 0.5 m samples (the mouth cut is exact enough)
            ts = (np.arange(m) + 0.5) / m
            P0 = A + ts[:, None] * (B - A)
            kk = kd.query(P0)[1]
            dy = prof[kk]
            drop = np.zeros(m, bool)
            hed = head_edge(P0, nout)
            for o in (1.5, 3.0):
                Po = P0 + nout * o
                to = top_at(Po[:, 0], Po[:, 1])
                wi_, wj_, wok_ = wcell(Po[:, 0], Po[:, 1])
                wet_o = np.where(hed, wok_ & water[wj_, wi_], cw(Po[:, 0], Po[:, 1]))
                drop |= wet_o | (np.isfinite(to) & (to < dy - DROP))
            # hard rule: never a rail across a head mouth (the car must always be able to
            # drive off the way it came, even where a head ends at steps or a drop)
            drop &= ~in_mouth(P0)
            run = None
            for u in range(m + 1):
                if u < m and drop[u]:
                    run = u if run is None else run
                elif run is not None:
                    a0, a1 = A + (run / m) * (B - A), A + (u / m) * (B - A)
                    rails.append([round(float(v), 2) for v in (*a0, *a1)])
                    run = None
        # ---- hard checks ----
        # 1) no rail (box: + WH along and across, cut at 0.5 m samples) inside a head mouth
        for r in rails:
            a0, a1 = np.array(r[:2]), np.array(r[2:])
            n_ = max(2, int(np.hypot(*(a1 - a0)) / 0.1) + 1)
            S_ = a0 + np.linspace(0, 1, n_)[:, None] * (a1 - a0)
            for h in heads:
                d = S_ - h["E"]
                bad = (np.abs(d @ h["n"]) < hw - 0.6) & (d @ h["t"] > -HEAD_IN + 0.6) & (d @ h["t"] < HEAD_OUT - 0.6)
                if bad.any():
                    raise SystemExit(f"HARD CHECK: rail {r} closes a head of {name or ids[0]} at "
                                     f"({h['E'][0]:.1f}, {h['E'][1]:.1f})")
        # 2) at least one head should reach drivable ground. Not fatal: both heads are open (1),
        #    so a car on the deck can always leave; listed so a dead-end deck gets looked at
        #    (Marie-Elisabeth-Lueders-Steg / Kanzleramts-Steg end at buildings / terraces)
        hrec = [{"x": round(float(h["E"][0]), 2), "z": round(float(h["E"][1]), 2), "ground": h["ground"],
                 "open": round(2 * hw, 1)} for h in heads]
        if not any(h["ground"] == "ok" for h in heads):
            dead_end.append(f"{name or ids[0]} ({', '.join(h['ground'] for h in heads)})")
        rec.update(drivable=True, heads=hrec, poly=np.round(ring, 2).tolist(),
                   line=[[round(float(p[0]), 2), round(float(p[1]), 2), round(float(y), 2)] for p, y in zip(line, prof)],
                   rails=rails)
        out.append(rec)
        print(f"  {name or '-':28s} {kinds[0]:12s} {L:5.0f} m x {width:4.1f} m  deck {prof.min():5.1f}..{prof.max():5.1f}"
              f"  water {wy if wy is None else round(wy, 1)}  slope {slope:.2f}  rails {len(rails)}  ({time.time()-t0:.0f} s)")
    for r in skipped:
        print(f"  NOT drivable: {r['name'] or '-'} ({r['kind']}, {r['osm'][0]}): {r['why']}")
    for s_ in dead_end:
        print(f"  CHECK 2 WARNING: no head reaches drivable ground (heads stay open): {s_}")
    doc = {"level": a.name,
           "note": "bridges over water (OSM highway bridge=* + man_made=bridge areas); poly = deck outline "
                   "(level frame x = east, z = -north), line = centre line [x, z, deck y] at 1 m, rails = "
                   "deck edges with a drop outside [x0, z0, x1, z1]; js/bridges.js",
           "source": "OpenStreetMap contributors (ODbL); deck height: 3D mesh Berlin Partner fuer Wirtschaft und Technologie GmbH",
           "bridges": out}
    with open(os.path.join(lv, "bridges.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    n = sum(1 for r in out if r.get("drivable"))
    print(f"bridges.json: {len(out)} bridges over water, {n} drivable ({time.time()-t0:.0f} s)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Drivable road tunnels (js/tunnels.js): routes, corridor walls and height profiles.

  levels/<name>/tunnels.json : per tube (one bore, one driving direction in reality)
      edges   - centre lines at <= 2 m steps (level frame), half width, roadway height,
                street height above, `u` = underground (past a portal face)
      portals - the face where the open ramp goes under the ground: point, inward
                direction, half width, roadway height, lon/lat, street name
      walls   - corridor wall segments [x0, z0, y0, x1, z1, y1, u] (Box2D boxes in the
                game, also the outline drawn through the ground)
      ends    - where a tube had to stop before the level border (glass + cap)

Frame as in build_stream.py: ENU around level.json["origin"], x = east, z = -north.

Sources (local only, no network):
  - OSM highways from levels/<name>/osm_map.json (the build_map.py cache): drivable
    classes (motorway ... residential, no service) with tunnel=yes and layer < 0, at
    least MIN_LEN per tunnel name; the open ways joined to their ends are followed
    outward (the ramps). Building passages, foot / cycle underpasses, garage and
    supply tunnels (service) and rail are not taken.
  - the L1 mesh tiles (tiles.json) rasterised from above in small windows around the
    portals only (build_level.raster_top): the open ramp's floor, the street beside it
    and the face where the mesh closes over the road.
  - height.bin (street above the tube) and water.bin (rivers above the tube).

Height profile: on the open ramp the mesh floor (low percentile across the carriageway,
median + Gaussian along it) up to FACE_KEEP m before the face; underground the
highest profile that keeps COVER m under the street (RIVER_COVER m under the water
surface where a river is within RIVER_R m) with grades <= GRADE, found as a
slope-limited envelope over the whole tube graph (Y-junctions stay consistent),
then smoothed with the ramp ends held fixed (no step where mesh and synthetic meet).

  python3 racing/build_tunnels.py --name mitte_all          # ~1-3 min (mesh windows)
"""
import argparse, heapq, json, math, os, sys, time
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)
from build_sbahn import frame, prims_of        # noqa: E402
from build_level import raster_top             # noqa: E402

DRV = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
       "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
MIN_LEN = 60.0       # m of tunnel per name
STEP = 2.0           # m, centre line sampling
LANE_W = 3.5         # m per lane
SHOULDER = 1.25      # m beyond the outer lanes (kerb, walkway)
OPEN_MAX = 240.0     # m of open road followed outward from a tunnel end
CELL = 0.5           # m, mesh raster
FACE_RISE = 1.5      # m the mesh jumps above the ramp floor where it closes over the road
FACE_HOLD = 30.0     # m the mesh must stay up behind a face (an overpass is shorter)
OVER_DZ = 1.0        # m off the ramp's running median: overpass / canopy, bridged
FACE_KEEP = 3.0      # m before the face the mesh ramp is no longer trusted
WALL_DEPTH = 1.0     # m below the street: from here on the ramp has walls
COVER = 7.0          # m street -> roadway underground (4.5 m clearance + slab + soil)
RIVER_COVER = 10.5   # m water surface -> roadway (river bed, slab, clearance)
RIVER_AREA = 20000.0 # m2: smaller water (ponds) is no river over a tube
RIVER_R = 25.0       # m beyond the corridor: a river this near counts as above the tube (bridges are cut out of the water mask)
GRADE = 0.05         # steepest underground grade
SMOOTH_IT = 150      # Jacobi smoothing iterations of the free (underground) profile
EDGE_KEEP = 40.0     # m a tube ends before the level border
TUBE_GAP = 0.3       # m kept between the corridors of neighbouring tubes


def plen(P):
    return float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0.0


def resample(P, step):
    seg = np.hypot(*np.diff(P, axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    n = max(1, int(math.ceil(s[-1] / step)))
    t = np.linspace(0, s[-1], n + 1)
    return np.c_[np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], t


def layer_of(t):
    try:
        return float(str(t.get("layer", "0")).split(";")[0])
    except ValueError:
        return 0.0


def seg_dist(px, pz, P):
    """distance of point to polyline P (n x 2)"""
    a, b = P[:-1], P[1:]
    d = b - a
    L2 = np.maximum((d ** 2).sum(1), 1e-12)
    u = np.clip(((px - a[:, 0]) * d[:, 0] + (pz - a[:, 1]) * d[:, 1]) / L2, 0, 1)
    ex = a[:, 0] + u * d[:, 0] - px; ez = a[:, 1] + u * d[:, 1] - pz
    return float(np.sqrt((ex * ex + ez * ez).min()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--debug", help="directory for profile plots (PNG) and the mesh windows (npz cache)")
    a = ap.parse_args()
    t_start = time.time()
    lv = os.path.join(HERE, "levels", a.name)
    level = json.load(open(os.path.join(lv, "level.json")))
    to_xz = frame(level)
    ext = level["extent"]

    def inv(x, z):
        lon, lat = level["origin"]["lon"], level["origin"]["lat"]
        for _ in range(8):
            ax, az = to_xz(lon, lat)
            lon += (x - ax) / (111320 * math.cos(math.radians(lat))); lat -= (z - az) / 111132
        return round(lon, 6), round(lat, 6)

    H = level["height"]
    hgrid = np.fromfile(os.path.join(lv, H["file"]), np.float32).reshape(H["nz"], H["nx"])

    def street(x, z):
        i = np.clip((np.asarray(x) - H["x0"]) / H["cell"], 0, H["nx"] - 1.001)
        j = np.clip((-np.asarray(z) - H["n0"]) / H["cell"], 0, H["nz"] - 1.001)
        return ndimage.map_coordinates(hgrid, [np.atleast_1d(j), np.atleast_1d(i)], order=1, mode="nearest")

    WT = level["water"]
    water = np.fromfile(os.path.join(lv, WT["file"]), np.uint8).reshape(WT["nz"], WT["nx"])

    def hw_k(T, k):
        return T["hw"][k] + RIVER_R

    # rivers / canals only: water regions of >= RIVER_AREA (ponds and fountains at Potsdamer Platz are not)
    lab, nlab = ndimage.label(water == 1)
    area = np.bincount(lab.ravel()) * WT["cell"] ** 2
    big = area >= RIVER_AREA; big[0] = False
    river = big[lab]
    del lab
    water = np.where(river, 1, 0).astype(np.uint8)

    def river_near(x, z, r):
        i = int((x - WT["x0"]) / WT["cell"]); j = int((-z - WT["n0"]) / WT["cell"]); k = int(r / WT["cell"])
        win = water[max(0, j - k):j + k + 1, max(0, i - k):i + k + 1]
        return win.size > 0 and bool((win == 1).any())

    # ---- OSM ----
    osm = json.load(open(os.path.join(lv, "osm_map.json")))
    ways = [e for e in osm["elements"] if e["type"] == "way" and (e.get("tags") or {}).get("highway") in DRV]
    pos = {}
    for e in ways:
        for n, g in zip(e["nodes"], e["geometry"]):
            if n not in pos:
                pos[n] = to_xz(g["lon"], g["lat"])
    node_ways = {}
    for e in ways:
        for n in e["nodes"]:
            node_ways.setdefault(n, []).append(e)
    is_tun = lambda e: e["tags"].get("tunnel") == "yes" and layer_of(e["tags"]) < 0   # noqa: E731
    tun = [e for e in ways if is_tun(e)]
    by_name = {}
    for e in tun:
        by_name.setdefault(e["tags"].get("name", "?"), []).append(e)
    tun = [e for nm, l in by_name.items()
           if sum(plen(np.array([pos[n] for n in w["nodes"]])) for w in l) >= MIN_LEN for e in l]
    print(f"{len(tun)} drivable tunnel ways: " + ", ".join(
        f"{nm} ({sum(plen(np.array([pos[n] for n in w['nodes']])) for w in l):.0f} m of ways)" for nm, l in by_name.items()))

    # tubes = connected components of tunnel ways (shared nodes)
    par = {}

    def find(u):
        while par.setdefault(u, u) != u:
            par[u] = par[par[u]]; u = par[u]
        return u
    for e in tun:
        for n in e["nodes"][1:]:
            ra, rb = find(e["nodes"][0]), find(n)
            if ra != rb:
                par[ra] = rb
    comps = {}
    for e in tun:
        comps.setdefault(find(e["nodes"][0]), []).append(e)
    tubes = sorted(comps.values(), key=lambda l: (l[0]["tags"].get("name", ""), -sum(len(w["nodes"]) for w in l)))

    # ---- names of streets (portal labels) ----
    named = [(e["tags"]["name"], np.array([pos[n] for n in e["nodes"]])) for e in ways
             if e["tags"].get("name") and not is_tun(e) and "Tunnel" not in e["tags"]["name"] and len(e["nodes"]) > 1]

    def street_name(x, z, r=60.0):
        best, bd = None, r
        for nm, P in named:
            if abs(P[:, 0].mean() - x) > 2000:
                continue
            d = seg_dist(x, z, P)
            if d < bd:
                best, bd = nm, d
        return best

    out_tubes = []
    gid = [0]

    def new_id():
        gid[0] -= 1
        return gid[0]

    for ti, tws in enumerate(tubes):
        tname = tws[0]["tags"].get("name", "Tunnel")
        tset = {w["id"] for w in tws}
        deg = {}
        for w in tws:
            for n in (w["nodes"][0], w["nodes"][-1]):
                deg[n] = deg.get(n, 0) + 1
        ends = [n for n, d in deg.items() if d == 1]
        # edges: (node ids at both ends, xz polyline, lanes, kind)
        edges = []
        for w in tws:
            P = np.array([pos[n] for n in w["nodes"]])
            edges.append({"a": w["nodes"][0], "b": w["nodes"][-1], "P": P, "lanes": int(float(w["tags"].get("lanes", 2) or 2)),
                          "tunnel": True, "way": w["id"]})
        portals = []
        for n in ends:
            tw = next(w for w in tws if n in (w["nodes"][0], w["nodes"][-1]))
            entering = tw["nodes"][0] == n            # the tunnel way starts here: traffic goes in
            lanes = int(float(tw["tags"].get("lanes", 2) or 2))
            # follow the open road outward (against the flow when entering, with it when leaving)
            chain, cur, used, prevdir = [n], n, set(), None
            Ltot = 0.0
            while Ltot < OPEN_MAX:
                best = None
                for o in node_ways.get(cur, []):
                    if o["id"] in tset or o["id"] in used or is_tun(o):
                        continue
                    nd = o["nodes"]
                    ow = o["tags"].get("oneway") in ("yes", "1", "true")
                    for k in [i for i, q in enumerate(nd) if q == cur]:
                        for dirn in (-1, 1):
                            if not 0 <= k + dirn < len(nd):
                                continue
                            # entering: we walk against the flow (the way must lead INTO cur)
                            if ow and ((entering and dirn == 1) or (not entering and dirn == -1)):
                                continue
                            seq = nd[k::dirn] if dirn == 1 else nd[k::-1]
                            d0 = np.subtract(pos[seq[1]], pos[cur])
                            d0 = d0 / max(1e-9, np.hypot(*d0))
                            turn = 0.0 if prevdir is None else 1 - float(np.dot(d0, prevdir))
                            if best is None or turn < best[0]:
                                best = (turn, o, seq)
                if best is None or (prevdir is not None and best[0] > 0.6):
                    break
                _, o, seq = best
                used.add(o["id"])
                for q in seq[1:]:
                    Ltot += math.dist(pos[chain[-1]], pos[q]); chain.append(q)
                    if Ltot >= OPEN_MAX:
                        break
                cur = chain[-1]
                d = np.subtract(pos[chain[-1]], pos[chain[-2]]); prevdir = d / max(1e-9, np.hypot(*d))
            P = np.array([pos[q] for q in chain])
            outer = new_id()
            edges.append({"a": n, "b": outer, "P": P, "lanes": lanes, "tunnel": False, "way": None})
            # inward path: outer end -> portal node -> along the tunnel way (<= 120 m)
            TP = np.array([pos[q] for q in (tw["nodes"] if entering else tw["nodes"][::-1])])
            cum = np.r_[0, np.cumsum(np.hypot(*np.diff(TP, axis=0).T))]
            TP = TP[:max(2, int(np.searchsorted(cum, 120.0)) + 1)]
            inward = np.vstack([P[::-1], TP[1:]])
            portals.append({"node": n, "entering": entering, "lanes": lanes, "inward": inward,
                            "s_node": plen(P), "open_len": plen(P)})
        out_tubes.append({"name": tname, "edges": edges, "portals": portals, "id": f"t{ti}"})

    # ---- resample edges, build the sample graph per tube ----
    for T in out_tubes:
        nodes_xz, nid = [], {}

        def node(osm_id, xz):
            if osm_id not in nid:
                nid[osm_id] = len(nodes_xz); nodes_xz.append(xz)
            return nid[osm_id]
        for e in T["edges"]:
            R, s = resample(e["P"], STEP)
            idx = [node(e["a"], R[0])]
            for p in R[1:-1]:
                nodes_xz.append(p); idx.append(len(nodes_xz) - 1)
            idx.append(node(e["b"], R[-1]))
            e["idx"] = idx; e["s"] = s
            e["hw"] = max(1, e["lanes"]) * LANE_W / 2 + SHOULDER
        T["xz"] = np.array(nodes_xz)
        nN = len(nodes_xz)
        adj = [[] for _ in range(nN)]
        for e in T["edges"]:
            for u, v in zip(e["idx"], e["idx"][1:]):
                d = math.dist(T["xz"][u], T["xz"][v])
                adj[u].append((v, d)); adj[v].append((u, d))
        T["adj"] = adj
        hw = np.zeros(nN)
        for e in T["edges"]:
            for k in e["idx"]:
                hw[k] = max(hw[k], e["hw"])
        T["hw"] = hw
        print(f"{T['id']} {T['name']}: {len(T['edges'])} edges ({sum(e['tunnel'] for e in T['edges'])} tunnel ways), "
              f"{len(T['portals'])} portals, {nN} samples")

    # neighbouring tubes: corridors never overlap (narrow the half width where they come close)
    for T in out_tubes:
        for U in out_tubes:
            if U is T:
                continue
            for e in U["edges"]:
                for k in range(len(T["xz"])):
                    x, z = T["xz"][k]
                    if np.hypot(*(e["P"].mean(0) - (x, z))) > plen(e["P"]) + 60:
                        continue
                    d = seg_dist(x, z, e["P"])
                    lim = d - e["hw"] - TUBE_GAP
                    if lim < T["hw"][k]:
                        T["hw"][k] = max(1.6, min(T["hw"][k], d / 2 - TUBE_GAP / 2))
    # ---- mesh windows around the portals ----
    tiles = json.load(open(os.path.join(lv, "tiles.json")))
    l1 = [r for r in tiles["tiles"] if r[1] == 1]
    wins = []
    for T in out_tubes:
        for p in T["portals"]:
            Q = p["inward"]
            m = 30.0
            wins.append([Q[:, 0].min() - m, Q[:, 0].max() + m, Q[:, 1].min() - m, Q[:, 1].max() + m])
    for T in out_tubes:              # rivers over the tubes (their water level)
        for e in T["edges"]:
            if not e["tunnel"]:
                continue
            for k in e["idx"]:
                x, z = T["xz"][k]
                if river_near(x, z, hw_k(T, k)):
                    for W in wins:
                        if W[0] - 40 <= x <= W[1] + 40 and W[2] - 40 <= z <= W[3] + 40:
                            W[0], W[1], W[2], W[3] = min(W[0], x - 45), max(W[1], x + 45), min(W[2], z - 45), max(W[3], z + 45)
                            break
                    else:
                        wins.append([x - 45, x + 45, z - 45, z + 45])
    merged = True
    while merged:                     # merge overlapping windows
        merged = False
        for i in range(len(wins)):
            for j in range(i + 1, len(wins)):
                A, B = wins[i], wins[j]
                if A[0] <= B[1] and B[0] <= A[1] and A[2] <= B[3] and B[2] <= A[3]:
                    wins[i] = [min(A[0], B[0]), max(A[1], B[1]), min(A[2], B[2]), max(A[3], B[3])]
                    del wins[j]; merged = True; break
            if merged:
                break
    rasters = []
    for wi, (wx0, wx1, wz0, wz1) in enumerate(wins):
        t0 = time.time()
        x0, n0 = wx0, -wz1
        nx, ny = int((wx1 - wx0) / CELL) + 1, int((wz1 - wz0) / CELL) + 1
        rows = [r for r in l1 if wx0 - r[6] < r[3] < wx1 + r[6] and wz0 - r[6] < r[5] < wz1 + r[6]]
        cache = a.debug and os.path.join(a.debug, f"win_{x0:.0f}_{n0:.0f}_{nx}_{ny}.npz")
        if cache and os.path.exists(cache) and np.load(cache)["top"].shape == (ny, nx):
            top = np.load(cache)["top"]
        else:
            top = np.full((ny, nx), -np.inf, np.float32)
            for r in rows:
                t, _ = raster_top(prims_of(r, a.mesh_src), x0, n0, nx, ny, CELL, colour=False)
                np.fmax(top, np.where(np.isfinite(t), t, -np.inf), out=top)
            top[~np.isfinite(top)] = np.nan
            if cache:
                os.makedirs(a.debug, exist_ok=True); np.savez(cache, top=top)
        rasters.append((x0, n0, nx, ny, top))
        print(f"mesh window {wx1 - wx0:.0f} x {wz1 - wz0:.0f} m: {len(rows)} L1 tiles ({time.time() - t0:.0f} s)")

    def top_at(x, z):
        x = np.atleast_1d(np.asarray(x, float)); z = np.atleast_1d(np.asarray(z, float))
        v = np.full(x.shape, np.nan, np.float32)
        for (x0, n0, nx, ny, top) in rasters:
            ii = np.round((x - x0) / CELL - 0.5).astype(int); jj = np.round((-z - n0) / CELL - 0.5).astype(int)
            ok = (ii >= 0) & (jj >= 0) & (ii < nx) & (jj < ny) & np.isnan(v)
            v[ok] = top[jj[ok], ii[ok]]
        return v

    # ---- ramps: floor, street beside, face ----
    for T in out_tubes:
        for p in T["portals"]:
            Q, sq = resample(p["inward"], 1.0)
            d = np.gradient(Q, axis=0); d /= np.hypot(d[:, 0], d[:, 1])[:, None]
            N = np.c_[-d[:, 1], d[:, 0]]
            hw = p["lanes"] * LANE_W / 2 + SHOULDER
            floor = np.full(len(Q), np.nan); side = np.full(len(Q), np.nan)
            o_in = np.arange(-(hw - 1.2), hw - 1.2 + 1e-6, CELL)
            o_out = np.r_[-np.arange(hw + 3, hw + 10, CELL), np.arange(hw + 3, hw + 10, CELL)]
            for k in range(len(Q)):
                v = top_at(Q[k, 0] + o_in * N[k, 0], Q[k, 1] + o_in * N[k, 1]); v = v[np.isfinite(v)]
                if len(v) >= 4:
                    floor[k] = np.percentile(v, 25)
                w = top_at(Q[k, 0] + o_out * N[k, 0], Q[k, 1] + o_out * N[k, 1]); w = w[np.isfinite(w)]
                if len(w) >= 4:
                    side[k] = np.median(w)
            # face: walking inward, the first place where the mesh jumps up off the ramp floor and stays
            sn = p["s_node"]
            face = None
            ok = np.isfinite(floor)
            k0 = 0
            while k0 < len(Q) and not ok[k0]:
                k0 += 1
            f_last, slope = floor[k0] if k0 < len(Q) else np.nan, 0.0
            hist = []
            for k in range(k0 + 1, len(Q)):
                if not ok[k]:
                    continue
                pred = f_last + slope
                if floor[k] - pred > FACE_RISE and sq[k] > sn - 80:
                    # must stay up (ground over the tube, not an overpass / footbridge): the
                    # next 4 m all, and >= 85 % of the next FACE_HOLD m
                    nxt = floor[k:k + 5]; nxt = nxt[np.isfinite(nxt)]
                    far = floor[k:k + int(FACE_HOLD) + 1]; far = far[np.isfinite(far)]
                    if (len(nxt) >= 3 and (nxt - pred > FACE_RISE).all()
                            and len(far) >= FACE_HOLD / 2 and np.mean(far - pred > FACE_RISE) >= 0.85):
                        face = k; break
                hist.append(floor[k] - f_last); hist = hist[-6:]
                slope = float(np.median(hist)) if hist else 0.0
                f_last = floor[k]
            if face is None:
                face = int(np.argmin(np.abs(sq - sn)))
                p["face_src"] = "osm node (mesh never closed)"
            else:
                p["face_src"] = "mesh"
            p["face_s"] = float(sq[face]); p["face_k"] = face
            # ramp floor up to FACE_KEEP before the face, cleaned
            keep = (sq <= sq[face] - FACE_KEEP)
            fl = floor.copy()
            good = keep & np.isfinite(fl)
            idx = np.arange(len(Q))
            if good.sum() < 5:
                sys.exit(f"{T['name']}: no mesh ramp at portal {inv(*Q[face])}")
            # overpasses / footbridges / canopies over the ramp: the mesh top is their deck, not
            # the road -> stretches off a long running median are bridged (as the S-Bahn roofs)
            ov = ~good
            for _ in range(3):
                base = ndimage.median_filter(np.interp(idx, idx[~ov], fl[~ov]), 61, mode="mirror")
                ov = ~good | ndimage.binary_dilation(np.abs(np.where(good, fl, base) - base) > OVER_DZ, iterations=4)
            p["over"] = int((ov & good).sum())
            fl = np.interp(idx, idx[~ov], fl[~ov])
            fl = ndimage.median_filter(fl, 7, mode="nearest")
            fl = ndimage.gaussian_filter1d(fl, 3.0, mode="nearest")
            sd = np.where(np.isfinite(side), side, np.nan)
            sgood = np.isfinite(sd)
            sd = np.interp(idx, idx[sgood], sd[sgood]) if sgood.any() else fl.copy()
            for _ in range(2):           # overpasses beside / over the ramp: off a long running median
                base = ndimage.median_filter(sd, 61, mode="mirror")
                bad = ndimage.binary_dilation(sd - base > OVER_DZ, iterations=4)
                if bad.any() and (~bad).any():
                    sd = np.interp(idx, idx[~bad], sd[~bad])
            sd = ndimage.median_filter(sd, 15, mode="mirror")
            p["Q"], p["sq"], p["floor"], p["side"], p["keep"], p["floor_raw"] = Q, sq, fl, sd, keep, floor
            depth = sd - fl
            wk = np.flatnonzero(keep & (depth >= WALL_DEPTH))
            p["wall_s"] = float(sq[wk[0]]) if len(wk) else float(sq[face]) - FACE_KEEP
            rk = np.flatnonzero(keep & (depth >= 0.3))
            p["ramp_s"] = float(sq[rk[0]]) if len(rk) else p["wall_s"]
            p["face_xz"] = Q[face]; p["face_n"] = d[face]; p["hw"] = hw
            p["face_depth"] = float(sd[face] - fl[max(0, np.flatnonzero(keep)[-1])])

    # ---- graph profile per tube ----
    for T in out_tubes:
        xz, adj, nN = T["xz"], T["adj"], len(T["xz"])
        y_fix = np.full(nN, np.nan)
        under = np.zeros(nN, bool)
        ramp_ok = np.zeros(nN, bool)      # ramp samples with walls (depth >= WALL_DEPTH)
        on_path = np.zeros(nN, bool)
        side_h = street(xz[:, 0], xz[:, 1]).astype(float)
        for e in T["edges"]:
            if e["tunnel"]:
                under[e["idx"]] = True
        for p in T["portals"]:
            # samples of this portal's inward path: the open edge + the tunnel samples within its reach
            Q, sq = p["Q"], p["sq"]
            cand = set()
            for e in T["edges"]:
                if (not e["tunnel"] and e["a"] == p["node"]) or (e["tunnel"] and p["node"] in (e["a"], e["b"])):
                    cand.update(e["idx"])
            for k in cand:
                dd = np.hypot(Q[:, 0] - xz[k, 0], Q[:, 1] - xz[k, 1])
                j = int(np.argmin(dd))
                if dd[j] > 1.5 or sq[j] > p["face_s"] + 60:
                    continue
                on_path[k] = True
                s = sq[j]
                if s < p["face_s"]:
                    under[k] = False
                    side_h[k] = p["side"][j]
                    if p["keep"][j]:
                        y_fix[k] = p["floor"][j]
                    if s >= p["wall_s"]:
                        ramp_ok[k] = True
                else:
                    under[k] = True
        # open samples not on any inward path (shouldn't happen) follow the street
        free = ~np.isfinite(y_fix)
        # distance (graph) from the faces, for the cover constraint
        dist_face = np.full(nN, np.inf); face_y = np.full(nN, np.inf)
        q = []
        for p in T["portals"]:
            k = int(np.argmin(np.hypot(*(xz - p["face_xz"]).T)))
            dist_face[k] = 0.0; heapq.heappush(q, (0.0, k))
            face_y[k] = p["floor"][np.flatnonzero(p["keep"])[-1]]      # last trusted mesh ramp height
        while q:
            dd, u = heapq.heappop(q)
            if dd > dist_face[u]:
                continue
            for v, w in adj[u]:
                if dd + w < dist_face[v]:
                    dist_face[v] = dd + w; face_y[v] = face_y[u]; heapq.heappush(q, (dd + w, v))
        p_up = np.full(nN, np.inf)
        wl = []
        for k in range(nN):
            if not under[k] or not free[k]:
                continue
            if dist_face[k] >= 50:
                p_up[k] = side_h[k] - COVER
            elif under[k]:
                p_up[k] = face_y[k]           # behind the face: never above the portal (no hump inside)
            if dist_face[k] >= 50 and river_near(xz[k, 0], xz[k, 1], hw_k(T, k)):
                wl.append(k)
        water_level = None
        if wl:
            # water surface = the mesh over the river cells near the tube (median: the photo
            # water has lumps of +-2 m); the height model leaves water out
            vals = []
            for k in wl[::5]:
                i = int((xz[k, 0] - WT["x0"]) / WT["cell"]); j = int((-xz[k, 1] - WT["n0"]) / WT["cell"]); r = int((hw_k(T, k) + 5) / WT["cell"])
                jj, ii = np.nonzero(water[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1] == 1)
                if len(jj):
                    v = top_at(WT["x0"] + (ii + max(0, i - r) + 0.5) * WT["cell"], -(WT["n0"] + (jj + max(0, j - r) + 0.5) * WT["cell"]))
                    vals.extend(v[np.isfinite(v)][::3])
            if not vals:
                print("river samples", [tuple(np.round(xz[k])) for k in wl[::10]], "windows", [tuple(np.round(r[:2])) + (r[2], r[3]) for r in rasters])
                sys.exit(f"{T['name']}: river over the tube but no mesh there (raster window missing)")
            water_level = float(np.median(vals))
            for k in wl:
                p_up[k] = min(p_up[k], water_level - RIVER_COVER)
        p_up[~free] = y_fix[~free]
        # slope-limited envelope (multi-source Dijkstra)
        y = p_up.copy()
        q = [(y[k], k) for k in range(nN) if np.isfinite(y[k])]
        heapq.heapify(q)
        while q:
            yy, u = heapq.heappop(q)
            if yy > y[u]:
                continue
            for v, w in adj[u]:
                c = yy + GRADE * w
                if c < y[v]:
                    y[v] = c; heapq.heappush(q, (c, v))
        if not np.isfinite(y).all():
            sys.exit(f"{T['name']}: profile not defined everywhere")
        env_low = float(np.max(np.where(~free, y_fix - y, 0)))
        y[~free] = y_fix[~free]
        # smoothing, ramp ends fixed, ceiling constraint kept
        nb = [np.array([v for v, _ in adj[k]]) for k in range(nN)]
        for _ in range(SMOOTH_IT):
            m = np.array([y[nb[k]].mean() if len(nb[k]) else y[k] for k in range(nN)])
            y = np.where(free, 0.5 * y + 0.5 * m, y)
            y = np.where(free, np.minimum(y, p_up), y)
        T["y"], T["under"], T["street"], T["ramp_ok"], T["water_level"], T["env_low"] = y, under, side_h, ramp_ok, water_level, env_low
        T["dist_face"] = dist_face

    # ---- level border: stop EDGE_KEEP m before it ----
    def inside_level(x, z, m):
        return ext["minX"] + m <= x <= ext["maxX"] - m and ext["minZ"] + m <= z <= ext["maxZ"] - m
    for T in out_tubes:
        T["ends"] = []
        for e in T["edges"]:
            ins = [inside_level(*T["xz"][k], EDGE_KEEP) for k in e["idx"]]
            if all(ins):
                continue
            k = ins.index(False) if ins[0] else len(ins) - 1 - ins[::-1].index(False)
            keep = e["idx"][:k] if ins[0] else e["idx"][k + 1:]
            print(f"  {T['name']}: an edge leaves the level, cut at {len(keep)} of {len(e['idx'])} samples")
            e["idx"] = keep
            if len(keep) >= 2:
                last, prev = (keep[-1], keep[-2]) if ins[0] else (keep[0], keep[1])
                dv = T["xz"][last] - T["xz"][prev]; dv /= np.hypot(*dv)
                T["ends"].append({"x": float(T["xz"][last][0]), "z": float(T["xz"][last][1]), "nx": float(dv[0]), "nz": float(dv[1]),
                                  "hw": float(T["hw"][last]), "y": float(T["y"][last])})

    # ---- walls: offsets of every edge where the ramp is deep enough or underground,
    # minus what lies inside another edge of the same tube (junction gores open) ----
    for T in out_tubes:
        xz, hw, y, under, ramp_ok = T["xz"], T["hw"], T["y"], T["under"], T["ramp_ok"]
        segs = []
        polys = [(xz[e["idx"]], e) for e in T["edges"] if len(e["idx"]) >= 2]
        for P, e in polys:
            I = e["idx"]
            d = np.gradient(P, axis=0) if len(P) > 2 else np.repeat(np.diff(P, axis=0), 2, axis=0)
            d /= np.maximum(1e-9, np.hypot(d[:, 0], d[:, 1]))[:, None]
            N = np.c_[-d[:, 1], d[:, 0]]
            for sgn in (1, -1):
                W = P + sgn * N * hw[I][:, None]
                okp = []
                for j, k in enumerate(I):
                    ok = bool(under[k] or ramp_ok[k])
                    if ok:
                        for P2, e2 in polys:
                            if e2 is e:
                                continue
                            if seg_dist(W[j, 0], W[j, 1], P2) < hw[e2["idx"]].min() - 0.15:
                                ok = False; break
                    okp.append(ok)
                for j in range(len(I) - 1):
                    if okp[j] and okp[j + 1]:
                        k0, k1 = I[j], I[j + 1]
                        segs.append([W[j, 0], W[j, 1], y[k0], W[j + 1, 0], W[j + 1, 1], y[k1], 1 if (under[k0] and under[k1]) else 0])
        for en in T["ends"]:          # cap before the level border
            cx, cz, nx_, nz_ = en["x"], en["z"], -en["nz"], en["nx"]
            segs.append([cx + nx_ * en["hw"], cz + nz_ * en["hw"], en["y"], cx - nx_ * en["hw"], cz - nz_ * en["hw"], en["y"], 1])
        T["walls"] = segs

    # ---- checks + output ----
    print("\nchecks")
    roads = json.load(open(os.path.join(lv, "map.json")))["roads"]
    road_P = [np.array(r[3]).reshape(-1, 2) for r in roads if r[0] in DRV and not r[2]]
    out = {"format": "edges: x, z, y (roadway), hw (half width), st (street above), u (1 = underground); "
                     "walls: [x0, z0, y0, x1, z1, y1, u] flat; portals: face point, inward unit (nx, nz)",
           "frame": "level x = east, z = -north (metres)", "ceiling": 5.0, "tubes": []}
    worst = {"slope": 0, "kink": 0}
    for T in out_tubes:
        xz, y, adj = T["xz"], T["y"], T["adj"]
        # slope + kink over the graph (2 m steps: kink = slope change per 10 m)
        sl, su = max((abs(y[v] - y[u]) / max(w, 1e-6), u) for u in range(len(xz)) for v, w in adj[u])
        kink = 0.0
        for u in range(len(xz)):
            if len(adj[u]) == 2:
                (v1, w1), (v2, w2) = adj[u]
                kink = max(kink, abs((y[v1] - y[u]) / w1 + (y[v2] - y[u]) / w2) * 10 / ((w1 + w2) / 2))
        worst["slope"] = max(worst["slope"], sl); worst["kink"] = max(worst["kink"], kink)
        uk = np.flatnonzero(T["under"])
        depth = T["street"] - y
        kd = uk[np.argmin(y[uk])]
        L_under = sum(math.dist(xz[u], xz[v]) for u in uk for v, _ in adj[u] if T["under"][v]) / 2
        lon, lat = inv(*xz[kd])
        print(f"{T['id']} {T['name']}: underground {L_under:.0f} m, deepest roadway {y[kd]:.1f} m "
              f"({depth[kd]:.1f} m under the street) at {lat:.5f} N {lon:.5f} E; max grade {sl*100:.1f} %, "
              f"max kink {kink*100:.2f} % per 10 m; water level above {T['water_level'] if T['water_level'] is None else round(T['water_level'], 1)}; "
              f"envelope under the mesh ramp by {T['env_low']:.2f} m; steepest at {inv(*xz[su])[::-1]}")
        mins = min(min(x - ext["minX"], ext["maxX"] - x, z - ext["minZ"], ext["maxZ"] - z) for x, z in xz)
        wmin = min(min(s[0] - ext["minX"], ext["maxX"] - s[0], s[1] - ext["minZ"], ext["maxZ"] - s[1]) for s in T["walls"])
        print(f"   route >= {mins:.0f} m inside the level border, corridor walls >= {wmin:.0f} m, {len(T['walls'])} wall segments")
        ports = []
        for p in T["portals"]:
            Q = p["Q"]
            fx, fz = p["face_xz"]
            lon, lat = inv(fx, fz)
            oe = Q[0]
            dr = min(seg_dist(oe[0], oe[1], P) for P in road_P if abs(P[:, 0].mean() - oe[0]) < 1500)
            nm = street_name(*oe) or street_name(fx, fz) or ""
            fk = p["face_k"]
            hand = [k for k in range(len(Q)) if p["keep"][k]]
            kh = hand[-1]
            # handover continuity: graph profile vs mesh ramp at the face
            kg = int(np.argmin(np.hypot(*(xz - p["face_xz"]).T)))
            print(f"   portal {'in ' if p['entering'] else 'out'} {nm or '?'}: face {lat:.5f} N {lon:.5f} E ({p['face_src']}, "
                  f"{p['face_s'] - p['s_node']:+.0f} m from the OSM tunnel end), roadway {y[kg]:.1f} m, "
                  f"{p['side'][fk] - y[kg]:.1f} m under the street; ramp from {p['face_s'] - p['ramp_s']:.0f} m before the face, "
                  f"walls from {p['face_s'] - p['wall_s']:.0f} m; mesh ramp ends at {p['floor'][kh]:.1f} m; "
                  f"open end {dr:.1f} m from a drivable OSM road")
            ports.append({"id": f"{T['id']}-{'in' if p['entering'] else 'out'}-{len(ports)}", "kind": "in" if p["entering"] else "out",
                          "name": nm, "lat": lat, "lon": lon, "x": round(float(fx), 2), "z": round(float(fz), 2),
                          "nx": round(float(p["face_n"][0]), 4), "nz": round(float(p["face_n"][1]), 4),
                          "hw": round(float(T["hw"][kg]), 2), "y": round(float(y[kg]), 2),
                          "street": round(float(p["side"][fk]), 2),
                          "outer": [round(float(Q[0][0]), 2), round(float(Q[0][1]), 2)]})
        edges = []
        for e in T["edges"]:
            I = e["idx"]
            if len(I) < 2:
                continue
            edges.append({"x": [round(float(xz[k, 0]), 2) for k in I], "z": [round(float(xz[k, 1]), 2) for k in I],
                          "y": [round(float(y[k]), 2) for k in I], "hw": [round(float(T["hw"][k]), 2) for k in I],
                          "st": [round(float(T["street"][k]), 2) for k in I], "u": [int(T["under"][k]) for k in I]})
        out["tubes"].append({"id": T["id"], "name": T["name"], "edges": edges, "portals": ports,
                             "walls": [round(float(v), 2) if i % 7 != 6 else int(v) for s in T["walls"] for i, v in enumerate(s)],
                             "ends": [{k: round(v, 3) for k, v in en.items()} for en in T["ends"]],
                             "length": round(L_under), "deepest": {"y": round(float(y[kd]), 1), "depth": round(float(depth[kd]), 1),
                                                                   "lat": lat, "lon": lon}})
    if a.debug:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        for T in out_tubes:
            fig, ax = plt.subplots(len(T["portals"]) + 1, 1, figsize=(12, 3.2 * (len(T["portals"]) + 1)))
            for i, p in enumerate(T["portals"]):
                A = ax[i]
                A.plot(p["sq"], p["floor_raw"], ".", ms=2, label="mesh floor p25")
                A.plot(p["sq"], p["floor"], label="ramp (kept)" )
                A.plot(p["sq"], p["side"], label="street beside")
                A.axvline(p["face_s"], color="r"); A.axvline(p["s_node"], color="k", ls=":")
                A.axvline(p["wall_s"], color="g", ls="--")
                kk = [int(np.argmin(np.hypot(*(T["xz"] - q).T))) for q in p["Q"]]
                A.plot(p["sq"], T["y"][kk], label="profile")
                A.set_title(f"{T['id']} portal {'in' if p['entering'] else 'out'}"); A.legend(fontsize=7)
            A = ax[-1]
            for e in T["edges"]:
                I = e["idx"]
                if len(I) > 1:
                    A.plot(T["dist_face"][I], T["y"][I], ".", ms=1)
                    A.plot(T["dist_face"][I], T["street"][I], "k.", ms=0.5)
            A.set_title("profile vs graph distance from the nearest face (black: street)")
            fig.tight_layout(); fig.savefig(os.path.join(a.debug, f"{T['id']}.png"), dpi=80); plt.close(fig)
    print(f"all tubes: max grade {worst['slope']*100:.1f} %, max kink {worst['kink']*100:.2f} % per 10 m")
    path = os.path.join(lv, "tunnels.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"wrote {path} ({os.path.getsize(path) / 1e3:.0f} kB, {time.time() - t_start:.0f} s)")


if __name__ == "__main__":
    main()

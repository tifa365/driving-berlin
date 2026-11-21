#!/usr/bin/env python3
"""Road audit: is every drivable road free of colliders the player cannot see?

  python3 audit_roads.py --name mitte_all [--area X0 Z0 X1 Z1] [--clutter PREFIX] [--no-mesh]
                         [--out levels/mitte_all/road_audit] [--workers 1]

Rule (owner, 2026-11-21): the car may only be stopped by something the player can see at car
height. This walks every drivable OSM road of the level (osm_map.json, the classes of
osm_semantic.ROAD_WIDTH that the game drives on; tunnel ways inside the tunnel tubes, bridge ways
on their decks), puts lanes across its width (lanes x 3.25 m or ROAD_WIDTH, one lane per 3.25 m,
lane centres spread evenly) and moves a corridor as wide as the car plus a margin (CAR_HALF +
MARGIN on each side) along every lane in 0.5 m steps. Each step is tested against ALL static
colliders the game builds, with the game's own geometry:
  wall     js/walls.js       walls.bin segments (0.6 m boxes), minus segments on bridge decks
  obstacle js/clutter.js     clutter.bin outlines (0.6 m boxes) incl. its size guess for unchecked rows
  trunk    js/clutter.js     clutter.bin trunk circles
  rail     js/bridges.js     bridges.json rails (bridge ways on a drivable deck only)
  tunnel   js/tunnels.js     tunnels.json tube walls (tunnel ways inside a tube only)
Pits are holes, not colliders, and count as intended; the level border is skipped (3 m).
Bridge heads (bridges.json, every drivable deck incl. footbridges, which the road walk skips): the
car corridor must cross each centre-line end at some lateral offset (BRIDGE HEADS section;
--heads-only runs just that in seconds).

Every blocked step names the collider and its contact point; steps are grouped into places
(same collider, contacts within 6 m). A place is "visible, intended" when the mesh shows something
at car height there (build_level.car_band: steep mesh surface 0.3-2 m above the local street,
>= EV_SIDE m2 within EV_R m of a contact, or a collider cell whose top itself is 0.3-2 m high);
anything else is a DEFECT. --no-mesh skips that test (all places "unchecked").

Output: <out>.txt (summary + every defect with lat/lon, x/z, road, collider, height/area and a
berlinDrive.teleport line) and <out>.json (all places). Local data only, no network.
"""
import argparse, json, math, os, sys, time
from collections import defaultdict
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_clutter as BC          # noqa: E402  (Level, prims_of, REPO)
import build_level as BL            # noqa: E402  (raster_top, street_ground, car_band, CAR_*)
from osm_semantic import ROAD_WIDTH  # noqa: E402

CAR_HALF = 0.835        # m, js/vehicle.js car outline half width
MARGIN = 0.3            # m each side
LANE_W = 3.25           # m
STEP = 0.5              # m along a lane
WH = 0.3                # m, half thickness of a wall / obstacle / rail box
BORDER = 3.0            # m, steps this close to the level border are not tested
GROUP_R = 6.0           # m, contacts of one collider this close form one place
EV_R = BL.CAR_REACH     # m around a contact point (as the build's car-height test)
EV_SIDE = BL.CAR_SIDE   # m2 of side face at car height within EV_R: visible
EV_TOP = 4              # collider cells (0.5 m) within EV_R whose top is in the car band: visible
WIN = 100.0             # m, mesh windows for the evidence test (+ GROUND margin)
GROUND = 20.0           # m, context around a window for the local street ground (16 m opening)
OVERHEAD = (4.5, 20.0)  # js/clutter.js size guess for rows without ev (minH m, maxA m2)


# ---------------------------------------------------------------- colliders
def seg_index(segs, kind, meta):
    """segments (N x 4: x0 z0 x1 z1) -> densified points for a KD tree"""
    pts, sid = [], []
    for k, (x0, z0, x1, z1) in enumerate(segs):
        L = math.hypot(x1 - x0, z1 - z0)
        n = max(1, int(math.ceil(L / 0.5)))
        s = (np.arange(n + 1) / n)
        pts.append(np.c_[x0 + (x1 - x0) * s, z0 + (z1 - z0) * s]); sid.append(np.full(n + 1, k))
    return {"kind": kind, "segs": np.asarray(segs, float).reshape(-1, 4), "pts": np.vstack(pts) if pts else np.zeros((0, 2)),
            "sid": np.concatenate(sid) if sid else np.zeros(0, int), "meta": meta}


def point_seg(px, pz, s):
    x0, z0, x1, z1 = s[..., 0], s[..., 1], s[..., 2], s[..., 3]
    dx, dz = x1 - x0, z1 - z0
    l2 = dx * dx + dz * dz
    u = np.where(l2 > 1e-12, ((px - x0) * dx + (pz - z0) * dz) / np.maximum(l2, 1e-12), 0.0).clip(0, 1)
    cx, cz = x0 + u * dx, z0 + u * dz
    return np.hypot(px - cx, pz - cz), cx, cz


def in_poly(P, x, z):
    c = False
    n = len(P)
    for a in range(n):
        xi, zi = P[a]; xj, zj = P[a - 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
    return c


def load_colliders(lv, clutter_prefix, guess=True, bridges=None):
    d = lv.dir
    out = {}
    # bridges (drivable decks) first: walls.js drops wall segments whose midpoint is on a deck
    bj = json.load(open(bridges or os.path.join(d, "bridges.json")))
    decks = [b for b in bj["bridges"] if b.get("drivable") and b.get("poly") and b.get("line")]
    deck_box = [(np.min(np.array(b["poly"])[:, 0]), np.min(np.array(b["poly"])[:, 1]),
                 np.max(np.array(b["poly"])[:, 0]), np.max(np.array(b["poly"])[:, 1])) for b in decks]

    def on_deck(x, z):
        for b, (a0, b0, a1, b1) in zip(decks, deck_box):
            if a0 <= x <= a1 and b0 <= z <= b1 and in_poly(b["poly"], x, z):
                return b
        return None
    # walls
    wj = json.load(open(os.path.join(d, "walls.json")))
    raw = open(os.path.join(d, wj["file"]), "rb").read()
    s = wj["segments"]
    W = np.frombuffer(raw, "<i2", s["count"] * 4, s["offset"]).reshape(-1, 4).astype(float) * wj["scale"]
    mid = (W[:, :2] + W[:, 2:]) / 2
    keep = np.array([on_deck(x, z) is None for x, z in mid])
    out["wall"] = seg_index(W[keep], "wall", [{} for _ in range(int(keep.sum()))])
    # clutter
    cj = json.load(open(clutter_prefix + ".json"))
    raw = open(clutter_prefix + ".bin", "rb").read()
    def sec(nm, dt="<f4"):
        q = cj["sections"][nm]
        return np.frombuffer(raw, dt, q["count"] * q["stride"], q["offset"]).reshape(q["count"], q["stride"])
    ob, pts, tr = sec("obst"), sec("pts"), sec("trees")
    ev = sec("ev") if "ev" in cj["sections"] else np.full((len(ob), 2), np.nan, np.float32)
    segs, meta = [], []
    nguess = 0
    out["outlines"] = {}
    for k, ((p0, pn, h, a), e) in enumerate(zip(ob.tolist(), ev.tolist())):
        if guess and not np.isfinite(e[0]) and h >= OVERHEAD[0] and a <= OVERHEAD[1]:
            nguess += 1
            continue                                   # js/clutter.js gives it no collider
        p = pts[int(p0):int(p0 + pn)]
        out["outlines"][k] = p
        for q in range(len(p) - 1):
            segs.append([p[q, 0], p[q, 1], p[q + 1, 0], p[q + 1, 1]])
            meta.append({"obj": k, "h": round(h, 1), "a": round(a, 1), "ev": None if not np.isfinite(e[0]) else [round(e[0], 2), round(e[1], 2)]})
    out["obstacle"] = seg_index(segs, "obstacle", meta)
    out["trunk"] = {"kind": "trunk", "xy": tr[:, :2].astype(float), "r": tr[:, 2].astype(float),
                    "vis": tr[:, 3].astype(float)}
    # rails
    rs, rm = [], []
    for bi, b in enumerate(decks):
        for r in b.get("rails") or []:
            rs.append(r); rm.append({"bridge": bi, "name": b.get("name")})
    out["rail"] = seg_index(rs, "rail", rm)
    # tunnel walls
    tj = json.load(open(os.path.join(d, "tunnels.json")))
    ts, tm, tube_pts = [], [], []
    for ti, T in enumerate(tj["tubes"]):
        Wt = np.array(T["walls"], float).reshape(-1, 7)
        for w in Wt:
            ts.append([w[0], w[1], w[3], w[4]]); tm.append({"tube": ti, "name": T.get("name")})
        for e in T["edges"]:
            for x, z, hw in zip(e["x"], e["z"], e["hw"] if isinstance(e["hw"], list) else [e["hw"]] * len(e["x"])):
                tube_pts.append((x, z, hw, ti))
    out["tunnel"] = seg_index(ts, "tunnel", tm)
    tp = np.array(tube_pts, float).reshape(-1, 4)
    out["tubes"] = (cKDTree(tp[:, :2]) if len(tp) else None, tp)
    out["on_deck"] = on_deck
    out["decks"] = decks
    out["guessed"] = nguess
    for k in ("wall", "obstacle", "rail", "tunnel"):
        c = out[k]
        c["tree"] = cKDTree(c["pts"]) if len(c["pts"]) else None
    out["trunk"]["tree"] = cKDTree(out["trunk"]["xy"]) if len(out["trunk"]["xy"]) else None
    return out


# ---------------------------------------------------------------- roads
def lane_offsets(t, hw):
    ln = t.get("lanes", "")
    W = float(ln) * LANE_W if ln.replace(".", "").isdigit() and float(ln) > 0 else ROAD_WIDTH[hw]
    n = max(1, int(round(W / LANE_W)))
    return W, [(-W / 2 + (i + 0.5) * W / n) for i in range(n)]


def roads(lv, area):
    """[(way id, tags, mode, E/N polyline)] mode: surface | bridge | tunnel"""
    out = []
    for el in json.load(open(os.path.join(lv.dir, "osm_map.json")))["elements"]:
        t, g = el.get("tags", {}), el.get("geometry")
        hw = t.get("highway")
        if hw not in ROAD_WIDTH or not g or t.get("area") == "yes":
            continue
        tun = t.get("tunnel", "no")
        if tun in ("yes",):
            mode = "tunnel"
        elif t.get("bridge", "no") != "no":
            mode = "bridge"
        elif t.get("layer", "0").startswith("-") and tun not in ("building_passage", "covered", "passage"):
            continue                                       # underground, not in the game
        else:
            mode = "surface"
        en = np.array([lv.to_en(p["lon"], p["lat"]) for p in g])
        if area is not None:
            x0, z0, x1, z1 = area
            xs, zs = en[:, 0], -en[:, 1]
            if xs.max() < min(x0, x1) or xs.min() > max(x0, x1) or zs.max() < min(z0, z1) or zs.min() > max(z0, z1):
                continue
        out.append((el.get("id"), t, mode, en))
    return out


def free_at(col, kinds, x, z, reach):
    for kind in kinds:
        c = col[kind]
        if c.get("tree") is None:
            continue
        if kind == "trunk":
            for j in c["tree"].query_ball_point([x, z], reach + (c["r"].max() if len(c["r"]) else 0)):
                if math.hypot(c["xy"][j, 0] - x, c["xy"][j, 1] - z) - c["r"][j] < reach:
                    return False
        else:
            cs = c["tree"].query_ball_point([x, z], reach + WH + 0.3)
            if cs:
                d, _, _ = point_seg(x, z, c["segs"][np.unique(c["sid"][cs])])
                if (d < reach + WH).any():
                    return False
    return True


def walk(lv, ways, col, area):
    """lane steps -> hits [(way k, lane i, step s, kind, collider index, cx, cz, x, z)], metres"""
    ext = lv.ext
    hits, metres, lane_m, nsteps = [], 0.0, 0.0, 0
    full = []                                   # (way k, station s): every lane blocked
    reach = CAR_HALF + MARGIN
    tube_tree, tube_pts = col["tubes"]
    for k, (wid, t, mode, en) in enumerate(ways):
        W, offs = lane_offsets(t, t["highway"])
        seg = np.diff(en, axis=0); L = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.r_[0, np.cumsum(L)]
        if cum[-1] < 0.5:
            continue
        s = np.arange(0, cum[-1], STEP)
        i = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(L) - 1)
        u = (s - cum[i]) / np.maximum(L[i], 1e-9)
        P = en[i] + seg[i] * u[:, None]
        tang = seg[i] / np.maximum(L[i], 1e-9)[:, None]
        nrm = np.c_[-tang[:, 1], tang[:, 0]]
        ok = ((P[:, 0] > ext[0] + BORDER) & (P[:, 0] < ext[2] - BORDER) & (P[:, 1] > ext[1] + BORDER)
              & (P[:, 1] < ext[3] - BORDER))
        if area is not None:
            x0, z0, x1, z1 = area
            ok &= ((P[:, 0] >= min(x0, x1)) & (P[:, 0] <= max(x0, x1)) & (-P[:, 1] >= min(z0, z1))
                   & (-P[:, 1] <= max(z0, z1)))
        deck = None
        if mode == "tunnel":
            if tube_tree is None:
                continue
            d, j = tube_tree.query(P)
            ok &= d < tube_pts[j, 2] + 3.0              # only the parts inside a game tunnel tube
            kinds = ("tunnel",)
        elif mode == "bridge":
            on = np.array([col["on_deck"](x, -n) is not None for x, n in P])
            if on.any():
                kinds = ("rail", "wall", "obstacle", "trunk")
                deck = on
            else:
                kinds = ("wall", "obstacle", "trunk")
        else:
            kinds = ("wall", "obstacle", "trunk")
        if not ok.any():
            continue
        metres += STEP * ok.sum()
        blocked_lanes = np.zeros((len(offs), len(s)), bool)
        for li, off in enumerate(offs):
            Q = P + nrm * off
            X, Z = Q[:, 0], -Q[:, 1]
            lane_m += STEP * ok.sum(); nsteps += int(ok.sum())
            for kind in kinds:
                c = col[kind]
                if c.get("tree") is None:
                    continue
                if kind == "trunk":
                    rmax = c["r"].max() if len(c["r"]) else 0
                    cand = c["tree"].query_ball_point(np.c_[X, Z], reach + rmax)
                else:
                    cand = c["tree"].query_ball_point(np.c_[X, Z], reach + WH + 0.3)
                for q in np.flatnonzero(ok):
                    if kind == "rail" and not deck[q]:
                        continue
                    cs = cand[q]
                    if not cs:
                        continue
                    if kind == "trunk":
                        cs = np.array(cs)
                        d = np.hypot(c["xy"][cs, 0] - X[q], c["xy"][cs, 1] - Z[q]) - c["r"][cs]
                        b = np.flatnonzero(d < reach)
                        for j in cs[b]:
                            hits.append((k, li, int(q), kind, int(j), c["xy"][j, 0], c["xy"][j, 1], X[q], Z[q]))
                            blocked_lanes[li, q] = True
                    else:
                        sids = np.unique(c["sid"][cs])
                        d, cx, cz = point_seg(X[q], Z[q], c["segs"][sids])
                        b = np.flatnonzero(d < reach + WH)
                        for j in b:
                            hits.append((k, li, int(q), kind, int(sids[j]), cx[j], cz[j], X[q], Z[q]))
                            blocked_lanes[li, q] = True
        # every lane blocked at a station: is there any lateral position left where the car fits?
        span = max(W / 2 - CAR_HALF, 0.0)
        fine = np.arange(-span, span + 1e-6, 0.25) if span > 0 else np.zeros(1)
        for q in np.flatnonzero(blocked_lanes.all(0) & ok):
            if mode == "bridge" and deck is not None and deck[q]:
                kk = kinds
            else:
                kk = tuple(x for x in kinds if x != "rail")
            if not any(free_at(col, kk, P[q, 0] + nrm[q, 0] * o, -(P[q, 1] + nrm[q, 1] * o), reach) for o in fine):
                full.append((k, int(q)))
    return hits, metres, lane_m, nsteps, set(full)


def group(hits, col, ways):
    """hits -> places: same collider object (obstacle: outline object; others: segment / trunk),
    contacts within GROUP_R m"""
    by = defaultdict(list)
    for h in hits:
        k, li, q, kind, j, cx, cz, x, z = h
        if kind == "obstacle":
            key = (kind, col["obstacle"]["meta"][j]["obj"])
        elif kind == "wall":
            key = (kind, 0)                               # walls: by position only
        elif kind == "rail":
            key = (kind, col["rail"]["meta"][j]["bridge"])
        elif kind == "tunnel":
            key = (kind, col["tunnel"]["meta"][j]["tube"])
        else:
            key = (kind, j)
        by[key].append(h)
    places = []
    for key, hs in by.items():
        C = np.array([[h[5], h[6]] for h in hs])
        if len(C) > 1:
            pairs = cKDTree(C).query_pairs(GROUP_R, output_type="ndarray")
            import scipy.sparse as sp
            g = sp.coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(C), len(C))) if len(pairs) else sp.coo_matrix((len(C), len(C)))
            n, lab = sp.csgraph.connected_components(g, directed=False)
        else:
            n, lab = 1, np.zeros(1, int)
        for c in range(n):
            sel = [hs[i] for i in np.flatnonzero(lab == c)]
            places.append({"kind": key[0], "key": key, "hits": sel})
    return places


# ---------------------------------------------------------------- evidence at car height
class Mesh:
    def __init__(self, lv, base):
        self.lv, self.base = lv, base
        tiles = json.load(open(os.path.join(lv.dir, "tiles.json")))
        self.leaves = [r for r in tiles["tiles"] if r[-1] == 1]

    def window(self, e0, n0, e1, n1):
        """band (side-face m2 per 0.5 m cell in the car band), nd (top over the street), ext"""
        lv, C = self.lv, BL.MASK_CELL
        ext = (e0 - GROUND, n0 - GROUND, e1 + GROUND, n1 + GROUND)
        mx, my = int(round((ext[2] - ext[0]) / C)), int(round((ext[3] - ext[1]) / C))
        rows = [r for r in self.leaves if r[3] + r[6] >= ext[0] and r[3] - r[6] <= ext[2]
                and -r[5] + r[6] >= ext[1] and -r[5] - r[6] <= ext[3]]
        prims = []
        for r in rows:
            try:
                prims += BC.prims_of(r, self.base)
            except Exception as e:                         # noqa: BLE001
                print(f"  ! {r[0]}: {e}")
        for p in prims:
            p["img"] = p["uv"] = None
        top, _ = BL.raster_top(prims, ext[0], ext[1], 2 * mx, 2 * my, C / 2, colour=False)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                t = np.nanmax(np.nanmax(top.reshape(my, 2, mx, 2), axis=3), axis=1)
        E = ext[0] + (np.arange(mx) + 0.5) * C; N = ext[1] + (np.arange(my) + 0.5) * C
        EE, NN = np.meshgrid(E, N)
        mask = lv.sample(lv.bld, lv.bx0, lv.bn0, lv.bcell, EE, NN)
        hx = int(np.ceil((ext[2] - ext[0]) / BL.H_CELL)) + 1; hy = int(np.ceil((ext[3] - ext[1]) / BL.H_CELL)) + 1
        HE, HN = np.meshgrid(ext[0] + np.arange(hx) * BL.H_CELL, ext[1] + np.arange(hy) * BL.H_CELL)
        height = lv.height_at(HE, HN).astype(np.float32)
        road, res, gr = BL.street_ground(t, height, mask, C)
        street = road + gr
        band = BL.car_band(prims, ext[0], ext[1], mx, my, C, np.where(np.isfinite(street), street, -1e4), *BL.CAR_BAND)
        return ext, band, res - gr, len(rows)


def evidence(places, mesh, col):
    """per place: side m2 near the contacts, low-top cells of the collider near the contacts"""
    C = BL.MASK_CELL
    win = defaultdict(list)
    for pi, p in enumerate(places):
        c = np.array([[h[5], -h[6]] for h in p["hits"]])      # E, N
        ce = c.mean(0)
        win[(int(ce[0] // WIN), int(ce[1] // WIN))].append(pi)
    t0 = time.time()
    rr = int(math.ceil(EV_R / C))
    dj, di = np.mgrid[-rr:rr + 1, -rr:rr + 1]
    disc = (np.hypot(dj, di) * C <= EV_R)
    dj, di = dj[disc], di[disc]
    for wn, ((wi, wj), pis) in enumerate(sorted(win.items())):
        # window covering the contacts of these places
        allc = np.vstack([[[h[5], -h[6]] for h in places[pi]["hits"]] for pi in pis])
        e0, n0 = allc.min(0) - 2; e1, n1 = allc.max(0) + 2
        ext, band, nd, ntiles = mesh.window(e0, n0, e1, n1)
        my, mx = band.shape
        for pi in pis:
            p = places[pi]
            inside = None
            if p["kind"] == "obstacle":
                from PIL import Image, ImageDraw
                img = Image.new("L", (mx, my), 0)
                ImageDraw.Draw(img).polygon([((x - ext[0]) / C - 0.5, (-z - ext[1]) / C - 0.5)
                                             for x, z in col["outlines"][p["key"][1]]], fill=1, outline=1)
                inside = np.array(img, bool)
            best_side, best_low = 0.0, 0
            for h in p["hits"][:: max(1, len(p["hits"]) // 40)]:
                i = int((h[5] - ext[0]) / C); j = int((-h[6] - ext[1]) / C)
                I, J = np.clip(i + di, 0, mx - 1), np.clip(j + dj, 0, my - 1)
                side = float(band[J, I].sum())
                v = nd[J, I]
                low = (int(((v >= BL.CAR_BAND[0]) & (v <= BL.CAR_BAND[1]) & inside[J, I]).sum())
                       if inside is not None else 0)
                best_side, best_low = max(best_side, side), max(best_low, low)
            p["ev_side"], p["ev_low"] = round(best_side, 2), best_low
            p["visible"] = best_side >= EV_SIDE or best_low >= EV_TOP
        if (wn + 1) % 10 == 0 or wn + 1 == len(win):
            print(f"  evidence: {wn + 1}/{len(win)} windows ({time.time() - t0:.0f} s)", flush=True)


# ---------------------------------------------------------------- bridge heads
def bridge_heads(col):
    """every drivable deck's two heads (bridges.json `line` ends): can the car corridor cross the
    head from HEAD_IN m on the deck to HEAD_OUT m beyond the end at SOME lateral offset? Rails count
    always (they exist while the car is at deck level), obstacles / trunks are reported separately
    (they collide only with "Hindernisse" on). Footbridges are not in the road walk (path classes),
    so this is their only check."""
    HEAD_IN, HEAD_OUT = 6.0, 3.0
    reach = CAR_HALF + MARGIN
    rows = []
    for b in col["decks"]:
        L = np.array(b["line"], float)[:, :2]
        for tag, E, Pn in (("start", L[0], L[1]), ("end", L[-1], L[-2])):
            t = (E - Pn) / max(float(np.hypot(*(E - Pn))), 1e-9)
            n = np.array([-t[1], t[0]])
            # lateral offsets: the exact centre line first, then +-0.25 m steps up to 4 m
            # (a 3 m footbridge is only 0.13 m wider than the car corridor + rail boxes, so
            # only the centre line itself fits there)
            half = max(min(float(b.get("width", 4)) / 2 - reach, 4.0), 0.0)
            offs = [0.0] + [s_ * k * 0.25 for k in range(1, int(half / 0.25) + 1) for s_ in (1, -1)]
            along = np.arange(-HEAD_IN, HEAD_OUT + 1e-6, STEP)
            res = {}
            for kinds in (("rail", "wall"), ("rail", "wall", "obstacle", "trunk")):
                res[len(kinds)] = next((o for o in offs
                                        if all(free_at(col, kinds, *(E + t * s + n * o), reach - MARGIN) for s in along)), None)
            rows.append({"name": b.get("name") or b["osm"][0], "end": tag, "x": round(float(E[0]), 1),
                         "z": round(float(E[1]), 1), "off": res[2], "on": res[4]})
    return rows


# ---------------------------------------------------------------- report
def ecef_to_latlon(v):
    a, e2 = 6378137.0, 6.69437999014e-3
    x, y, z = v
    lon = math.atan2(y, x); p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(6):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
    return math.degrees(lat), math.degrees(lon)


def describe(places, ways, col, lv, full):
    for p in places:
        hs = p["hits"]
        C = np.array([[h[5], h[6]] for h in hs])
        X = np.array([[h[7], h[8]] for h in hs])
        cx, cz = C.mean(0)
        # the car pose: the lane step nearest the contact centre, heading along the way
        q = int(np.argmin(np.hypot(X[:, 0] - cx, X[:, 1] - cz)))
        k, li, s = hs[q][0], hs[q][1], hs[q][2]
        wid, t, mode, en = ways[k]
        seg = np.diff(en, axis=0); L = np.hypot(seg[:, 0], seg[:, 1]); cum = np.r_[0, np.cumsum(L)]
        i = min(int(np.searchsorted(cum, s * STEP, side="right") - 1), len(L) - 1)
        de, dn = seg[i] / max(L[i], 1e-9)
        # back off 6 m along the way so the car starts in front of it
        px, pz = X[q, 0] - de * 6.0, X[q, 1] + dn * 6.0
        heading = math.atan2(de, dn)                      # 0 = north, clockwise (level.json spawn)
        v = lv.R.T @ np.array([cx, -cz, 0.0]) + lv.origin
        lat, lon = ecef_to_latlon(v)
        names = sorted({(ways[h[0]][1].get("name") or f"{ways[h[0]][1]['highway']} way/{ways[h[0]][0]}") for h in hs})
        lanes = defaultdict(set)
        for h in hs:
            lanes[h[0]].add(h[1])
        nl = {kk: len(lane_offsets(ways[kk][1], ways[kk][1]["highway"])[1]) for kk in lanes}
        p.update(x=round(cx, 1), z=round(cz, 1), lat=round(lat, 6), lon=round(lon, 6), road=names,
                 cls=sorted({ways[h[0]][1]["highway"] for h in hs}),
                 lanes=max(len(v_) for v_ in lanes.values()), of=max(nl.values()),
                 full=any((h[0], h[2]) in full for h in hs),
                 metres=round(len({(h[0], h[1], h[2]) for h in hs}) * STEP, 1),
                 teleport=f"berlinDrive.teleport({px:.1f}, {pz:.1f}, {heading:.2f})")
        if p["kind"] == "obstacle":
            m = col["obstacle"]["meta"][hs[0][4]]
            L, _ = BC.obj_shape(col["outlines"][m["obj"]])
            p.update(h=m["h"], a=m["a"], ev=m["ev"], L=round(L, 1))
            # the lane rule's exception class (build_clutter.lane_rule): sites, hoardings, container rows
            if m["a"] >= BC.BARRIER_A and m["h"] >= BC.BARRIER_H and L >= BC.BARRIER_L:
                p["kind"] = "barrier"
        elif p["kind"] == "trunk":
            j = hs[0][4]
            p.update(r=round(float(col["trunk"]["r"][j]), 2), vis=round(float(col["trunk"]["vis"][j]), 1))
        elif p["kind"] == "rail":
            p.update(bridge=col["rail"]["meta"][hs[0][4]]["name"])
        elif p["kind"] == "tunnel":
            p.update(tube=col["tunnel"]["meta"][hs[0][4]]["name"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--area", type=float, nargs=4, metavar=("X0", "Z0", "X1", "Z1"), help="level x/z rectangle")
    ap.add_argument("--clutter", default=None, help="clutter.json/.bin prefix (default levels/<name>/clutter)")
    ap.add_argument("--mesh-src", default=os.path.join(BC.REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--no-mesh", action="store_true", help="skip the car-height evidence test")
    ap.add_argument("--no-guess", action="store_true",
                    help="ignore js/clutter.js's size guess for unchecked rows (the state before 2026-11-21)")
    ap.add_argument("--out", default=None, help="output prefix (default levels/<name>/road_audit)")
    ap.add_argument("--list-max", type=int, default=150, help="defects listed in the .txt at most")
    ap.add_argument("--bridges", default=None, help="bridges.json to use (default levels/<name>/bridges.json)")
    ap.add_argument("--heads-only", action="store_true",
                    help="only the bridge head check (seconds; prints closed heads, writes nothing)")
    a = ap.parse_args()
    t0 = time.time()
    lv = BC.Level(a.name)
    col = load_colliders(lv, a.clutter or os.path.join(lv.dir, "clutter"), guess=not a.no_guess, bridges=a.bridges)
    heads = bridge_heads(col)
    def st(v):
        return "CLOSED" if v is None else f"open (offset {v:+.2f} m)"
    head_lines = [f"{h['name'][:34]:34s} {h['end']:5s} x {h['x']:7.1f} z {h['z']:7.1f}  "
                  f"obstacles off: {st(h['off'])}, on: {st(h['on'])}" for h in heads]
    nclosed = sum(1 for h in heads if h["off"] is None)
    print(f"bridge heads: {len(heads)} checked, {nclosed} closed (rails / walls), "
          f"{sum(1 for h in heads if h['on'] is None)} closed with obstacles on")
    for ln in head_lines:
        if "CLOSED" in ln:
            print("  " + ln)
    if a.heads_only:
        return
    ways = roads(lv, a.area)
    print(f"{len(ways)} drivable ways; colliders: {len(col['wall']['segs'])} wall segments, "
          f"{len(col['obstacle']['segs'])} obstacle segments ({col['guessed']} rows without a collider by "
          f"js/clutter.js's size guess), {len(col['trunk']['r'])} trunks, {len(col['rail']['segs'])} rail and "
          f"{len(col['tunnel']['segs'])} tunnel wall segments", flush=True)
    hits, metres, lane_m, nsteps, full = walk(lv, ways, col, a.area)
    places = group(hits, col, ways)
    print(f"walked {metres / 1000:.1f} km of road ({lane_m / 1000:.1f} km of lanes, {nsteps:,} steps): "
          f"{len(hits):,} blocked steps in {len(places)} places ({time.time() - t0:.0f} s)", flush=True)
    if a.no_mesh:
        for p in places:
            p["visible"] = None
    else:
        evidence(places, Mesh(lv, a.mesh_src), col)
    describe(places, ways, col, lv, full)
    kinds = ("wall", "barrier", "obstacle", "trunk", "rail", "tunnel")
    cnt = {v: {k: 0 for k in kinds} for v in ("visible", "defect", "unchecked")}
    for p in places:
        v = "unchecked" if p["visible"] is None else ("visible" if p["visible"] else "defect")
        cnt[v][p["kind"]] += 1
    def fmt(d):
        return ", ".join(f"{k} {n}" for k, n in d.items() if n) or "none"
    nfull = sum(1 for p in places if p["full"] and p["visible"] is False)
    summary = (f"ROAD AUDIT {a.name}{' area ' + str(a.area) if a.area else ''}: {metres / 1000:.2f} km of drivable road "
               f"checked ({lane_m / 1000:.2f} km of lanes, corridor {2 * (CAR_HALF + MARGIN):.2f} m); blocked places: "
               f"visible/intended {sum(cnt['visible'].values())} ({fmt(cnt['visible'])}); "
               f"DEFECTS {sum(cnt['defect'].values())} ({fmt(cnt['defect'])}; {nfull} block every lane)"
               + (f"; unchecked {sum(cnt['unchecked'].values())} ({fmt(cnt['unchecked'])})" if sum(cnt['unchecked'].values()) else ""))
    out = a.out or os.path.join(lv.dir, "road_audit")
    def line(p):
        extra = ""
        if p["kind"] in ("obstacle", "barrier"):
            extra = f" h {p['h']} m a {p['a']} m2 L {p['L']} m" + (f" ev {p['ev']}" if p.get("ev") else " (built before the car-height test)")
        elif p["kind"] == "trunk":
            extra = f" r {p['r']} m crown {p['vis']} m"
        elif p["kind"] == "rail":
            extra = f" bridge {p['bridge']}"
        elif p["kind"] == "tunnel":
            extra = f" tube {p['tube']}"
        return (f"{p['kind']:8s} {p['lat']:.6f},{p['lon']:.6f}  x {p['x']:7.1f} z {p['z']:7.1f}  "
                f"{'/'.join(p['road'])[:48]} ({'/'.join(p['cls'])}), lanes {p['lanes']}/{p['of']}"
                f"{' ALL' if p['full'] else ''}, {p['metres']} m{extra}; car-height side {p.get('ev_side', '-')} m2"
                f" low {p.get('ev_low', '-')}\n    {p['teleport']}")
    defects = sorted([p for p in places if p["visible"] is False],
                     key=lambda p: (not p["full"], -p["lanes"] / p["of"], -p["metres"]))
    with open(out + ".txt", "w") as f:
        f.write(summary + "\n")
        f.write(f"rule: only what the player can see at car height blocks. Visible = steep mesh surface "
                f"{BL.CAR_BAND[0]:g}-{BL.CAR_BAND[1]:g} m over the local street >= {EV_SIDE:g} m2 within {EV_R:g} m "
                f"of the contact, or (obstacles) >= {EV_TOP} cells whose top is in that band. Built "
                f"{time.strftime('%Y-%m-%d %H:%M')} by audit_roads.py from {a.clutter or 'clutter'}.bin, walls.bin, "
                f"bridges.json, tunnels.json; roads: osm_map.json.\n\n")
        f.write(f"DEFECTS ({len(defects)}; ALL = no lateral position left where the car fits)\n")
        for p in defects[:a.list_max]:
            f.write(line(p) + "\n")
        if len(defects) > a.list_max:
            f.write(f"... {len(defects) - a.list_max} more in {os.path.basename(out)}.json\n")
        bar = sorted([p for p in places if p["kind"] == "barrier"], key=lambda p: (not p["full"], -p["metres"]))
        f.write(f"\nBARRIERS in lanes, kept by the lane rule (>= {BC.BARRIER_A:g} m2, >= {BC.BARRIER_H:g} m, "
                f">= {BC.BARRIER_L:g} m long; {len(bar)}):\n")
        for p in bar:
            f.write(line(p) + "\n")
        f.write(f"\nBRIDGE HEADS ({len(heads)}; {nclosed} closed by rails / walls; car corridor from "
                f"6 m on the deck to 3 m beyond each centre-line end at the best lateral offset):\n")
        for ln in head_lines:
            f.write(ln + "\n")
        vis = [p for p in places if p["visible"] and p["kind"] != "barrier"]
        f.write(f"\nVISIBLE, INTENDED ({len(vis)}), every-lane blocks first:\n")
        for p in sorted(vis, key=lambda p: (not p["full"], -p["metres"]))[:40]:
            f.write(line(p) + "\n")
        if len(vis) > 40:
            f.write(f"... {len(vis) - 40} more in {os.path.basename(out)}.json\n")
    slim = [{k: v for k, v in p.items() if k not in ("hits", "key")} for p in places]
    json.dump({"summary": summary, "km": round(metres / 1000, 2), "laneKm": round(lane_m / 1000, 2),
               "counts": cnt, "defects": sum(cnt["defect"].values()), "defectsAll": nfull, "places": slim,
               "bridgeHeads": heads},
              open(out + ".json", "w"), separators=(",", ":"))
    print(summary)
    print(f"-> {out}.txt, {out}.json ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()

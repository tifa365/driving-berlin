#!/usr/bin/env python3
"""Building walls for a streamed level (Box2D colliders, loaded near the car by js/walls.js).

  python3 racing/build_walls.py --name mitte_all [--pbf berlin-latest.osm.pbf] [--png]

Source: OpenStreetMap `building=*` areas from a local extract (osmium CLI, no network);
LoD2 for the whole box is not on disk. Frame as build_stream.py / build_level.py: ENU at
level.origin, x = east, z = -north (metres).

What is a wall: outer rings and courtyard rings of buildings standing on the ground.
  - dropped: building=roof|carport|canopy|bridge|viaduct, bridge=*, min_height /
    building:min_level > 0, layer < 0 / location=underground, sheds < MIN_AREA m2;
    layer > 0 only for station halls / viaducts or where the footprint lies mostly over a
    bridge (man_made=bridge areas, railway/highway bridge ways) - layer=1 alone is common
    on ground buildings over tunnels (Fernsehturm, Bahntower) and keeps them solid;
  - shared walls of terraced houses (the same OSM edge in two footprints) are removed;
    Douglas-Peucker SIMPLIFY m;
  - raised building:parts (min_height / building:min_level > 0, roof) not over a ground
    part of the same building open the outline there and the ground parts become the
    walls (Brandenburger Tor: the columns stay, the five passages are open);
  - carved (walls within the capsule removed, both ends of a passage at once):
      passages: highway ways tunnel=building_passage|passage|covered, covered=yes|arcade|
        colonnade, short tunnel=yes (< 60 m, not underground): width/2 + WALL_HALF, >= 2 m;
      roads under / through buildings (any drivable highway inside a footprint, no tags
        needed - viaduct arches, station halls, OSM roads drawn through a building):
        width/2, lanes * 1.75 or a class default (+ WALL_HALF);
      every drivable road centre line keeps ROAD_CLEAR m to the wall face;
      special spots (S-Bahn door, bears in closed courtyards, ...): see SPOTS / fix_spot.
  - inside test = in a footprint ring (outer count > courtyard count) and not in a carved
    passage / road-under-building corridor.
Checks (printed): road centre lines every 2 m outside all walls with clearance, flood fill
from the spawn on a 0.5 m raster (car disc 0.9 m): roads, bears, pitches, goals, balls,
Weltballon platform, S-Bahn entrance + drop-off points reachable. A bear in a closed
courtyard gets one car-wide gateway toward the nearest reachable street (reported).

Writes levels/<name>/walls.bin + walls.json (layout in walls.json "format"); index.html
loads it lazily via js/walls.js when walls.json exists. Re-runnable (levels/ is gitignored).
"""
import argparse, json, math, os, subprocess, sys, tempfile, time
from collections import defaultdict
import numpy as np
from matplotlib.path import Path
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PBF = os.environ.get("OSM_PBF")   # local OSM extract (.osm.pbf): --pbf or env OSM_PBF
def need_pbf(p):
    if not p:
        sys.exit("no OSM extract: pass --pbf <berlin-latest.osm.pbf> or set OSM_PBF "
                 "(e.g. from download.geofabrik.de/europe/germany/berlin.html)")
    return p
A_WGS, E2 = 6378137.0, 6.69437999014e-3   # WGS84 (as build_buildings.py)

WALL_HALF = 0.3        # m, half thickness of the Box2D wall boxes (index.html addWall)
CAR_HALF_W = 0.91      # m, car half width (js/vehicle.js bodyWidth 1.81)
ROAD_CLEAR = 1.5       # m from a road centre line to the wall face
SIMPLIFY = 0.4         # m Douglas-Peucker
MIN_AREA = 6.0         # m2, smaller footprints are dropped (sheds, kiosks)
MIN_HOLE = 4.0         # m2, smaller courtyards are ignored
MAX_OPEN = 12.0        # m, longest opening under a raised building:part (Brandenburger Tor passages ~4-6 m)
OPEN_SHARE = 0.3       # at most this share of a building's outline is opened by raised parts
MAX_SEG = 16.0         # m, longer wall segments are split (one grid cell per segment midpoint)
SAMPLE = 0.25          # m, wall sampling for carving
SCALE = 10             # int16 quantum: 0.1 m
RASTER = 0.5           # m, reachability raster
OVER_BUILDING = {"bridge", "roof", "carport", "canopy", "viaduct"}
STATION = {"train_station", "station", "viaduct", "transportation"}
DRIVABLE = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
            "primary_link", "secondary_link", "tertiary_link", "unclassified", "residential",
            "living_street", "service", "pedestrian", "road", "track", "busway"}
NO_PASSAGE = {"steps", "corridor", "elevator", "platform", "construction", "proposed", "bus_stop", "escalator"}
HALF_W = {"motorway": 7, "trunk": 6.5, "primary": 6, "secondary": 5, "tertiary": 4.5, "unclassified": 3.5,
          "residential": 3.5, "living_street": 3, "service": 2.5, "pedestrian": 3, "road": 3.5, "track": 2.5,
          "busway": 3.5}   # m, default half width of a road where it passes under a building


def num(v, default=0.0):
    try:
        return float(str(v).split(";")[0].replace("m", "").replace(",", ".").strip())
    except (TypeError, ValueError):
        return default


class Frame:
    def __init__(self, L):
        lat0, lon0 = L["origin"]["lat"], L["origin"]["lon"]
        la, lo = math.radians(lat0), math.radians(lon0)
        self.R = np.array([[-math.sin(lo), math.cos(lo), 0],
                           [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)]])
        self.o = self.ecef(np.array([lat0]), np.array([lon0]))[0]

    @staticmethod
    def ecef(lat, lon):
        la, lo = np.radians(lat), np.radians(lon)
        N = A_WGS / np.sqrt(1 - E2 * np.sin(la) ** 2)
        return np.stack([N * np.cos(la) * np.cos(lo), N * np.cos(la) * np.sin(lo), N * (1 - E2) * np.sin(la)], -1)

    def xz(self, lonlat):
        ll = np.asarray(lonlat, float).reshape(-1, 2)
        en = (self.R @ (self.ecef(ll[:, 1], ll[:, 0]) - self.o).T).T
        return np.stack([en[:, 0], -en[:, 1]], 1)

    def lonlat(self, x, z):   # inverse by fixed point (sub-mm after 3 rounds)
        lat, lon = 52.5, 13.4
        for _ in range(4):
            p = self.xz([[lon, lat]])[0]
            lon += (x - p[0]) / (111320 * math.cos(math.radians(lat)))
            lat -= (z - p[1]) / 110574
        return lon, lat


# ---------------------------------------------------------------- geometry helpers
def area(r):
    x, z = r[:, 0], r[:, 1]
    return 0.5 * float(np.dot(x[:-1], z[1:]) - np.dot(x[1:], z[:-1]))


def seg_dist(px, pz, ax, az, bx, bz):
    """distance of points (px, pz) [n] to segments (a, b) [m] -> [n, m]"""
    dx, dz = bx - ax, bz - az
    l2 = np.maximum(dx * dx + dz * dz, 1e-12)
    t = np.clip(((px[:, None] - ax) * dx + (pz[:, None] - az) * dz) / l2, 0, 1)
    ex, ez = ax + t * dx - px[:, None], az + t * dz - pz[:, None]
    return np.sqrt(ex * ex + ez * ez)


def dp(pts, tol):
    """Douglas-Peucker on an (n, 2) polyline (closed if first == last)"""
    n = len(pts)
    if n <= 2:
        return pts
    keep = np.zeros(n, bool); keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        seg = pts[i + 1:j]
        d = b - a; l = math.hypot(*d)
        if l < 1e-9:
            dist = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            dist = np.abs(d[0] * (seg[:, 1] - a[1]) - d[1] * (seg[:, 0] - a[0])) / l
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k; keep[m] = True
            stack += [(i, m), (m, j)]
    return pts[keep]


def group(pts, cell):
    """(key, indices) per grid cell of the points"""
    if not len(pts):
        return
    k = np.floor(np.asarray(pts)[:, :2] / cell).astype(np.int64)
    code = k[:, 0] * 1000003 + k[:, 1]
    o = np.argsort(code, kind="stable")
    cs = code[o]
    cut = np.flatnonzero(np.diff(cs)) + 1
    for ks in np.split(o, cut):
        yield (int(k[ks[0], 0]), int(k[ks[0], 1])), ks


class Grid:
    """bucket items by bbox into square cells"""
    def __init__(self, cell):
        self.cell, self.c = cell, defaultdict(list)

    def add(self, i, x0, z0, x1, z1):
        c = self.cell
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gz in range(int(math.floor(z0 / c)), int(math.floor(z1 / c)) + 1):
                self.c[(gx, gz)].append(i)

    def near(self, x0, z0, x1, z1):
        c, out = self.cell, set()
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gz in range(int(math.floor(z0 / c)), int(math.floor(z1 / c)) + 1):
                out.update(self.c.get((gx, gz), ()))
        return out


class Rings:
    """point-in-footprint for many points: outer count > hole count"""
    def __init__(self, rings, holes):   # rings: list of (n, 2); holes: bool per ring
        self.rings, self.holes = rings, holes
        self.paths = [Path(r) for r in rings]
        self.box = np.array([[r[:, 0].min(), r[:, 1].min(), r[:, 0].max(), r[:, 1].max()] for r in rings]) if rings else np.zeros((0, 4))
        self.g = Grid(32.0)
        for i, b in enumerate(self.box):
            self.g.add(i, *b)

    def which(self, pts):
        """per point: index of the containing outer ring (first found) or -1; courtyards -> -1"""
        pts = np.asarray(pts, float)
        cnt = np.zeros(len(pts), int); out = np.full(len(pts), -1)
        if not len(pts):
            return out
        for (gx, gz), ks in group(pts, 32.0):
            for i in self.g.c.get((gx, gz), ()):
                b = self.box[i]
                P = pts[ks]
                m = (P[:, 0] >= b[0]) & (P[:, 0] <= b[2]) & (P[:, 1] >= b[1]) & (P[:, 1] <= b[3])
                if not m.any():
                    continue
                ins = np.zeros(len(ks), bool)
                ins[m] = self.paths[i].contains_points(P[m])
                if self.holes[i]:
                    cnt[ks[ins]] -= 1
                else:
                    cnt[ks[ins]] += 1
                    sel = ks[ins & (out[ks] < 0)]
                    out[sel] = i
        out[cnt <= 0] = -1
        return out


class Capsules:
    """segments with a radius: carve / corridor tests"""
    def __init__(self):
        self.a = []   # (x0, z0, x1, z1, r, kind)

    def add(self, x0, z0, x1, z1, r, kind):
        self.a.append((x0, z0, x1, z1, r, kind))

    def freeze(self):
        self.A = np.array([c[:5] for c in self.a], float).reshape(-1, 5)
        self.kind = [c[5] for c in self.a]
        self.g = Grid(16.0)
        for i, (x0, z0, x1, z1, r) in enumerate(self.A):
            self.g.add(i, min(x0, x1) - r, min(z0, z1) - r, max(x0, x1) + r, max(z0, z1) + r)
        return self

    def hit(self, pts):
        """per point: index of a capsule containing it or -1"""
        pts = np.asarray(pts, float)
        out = np.full(len(pts), -1)
        for key, ks in group(pts, 16.0):
            ids = self.g.c.get(key)
            if not ids:
                continue
            ids = np.array(ids)
            C = self.A[ids]
            d = seg_dist(pts[ks, 0], pts[ks, 1], C[:, 0], C[:, 1], C[:, 2], C[:, 3]) - C[:, 4]
            j = np.argmin(d, 1)
            ok = d[np.arange(len(ks)), j] < 0
            out[ks[ok]] = ids[j[ok]]
        return out


# ---------------------------------------------------------------- OSM
def load_osm(pbf, bbox, td):
    W, S, E, N = bbox
    m = 0.002
    box, f, gj = (os.path.join(td, n) for n in ("box.osm.pbf", "f.osm.pbf", "f.geojsonl"))
    q = dict(check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["osmium", "extract", "-b", f"{W - m},{S - m},{E + m},{N + m}", pbf, "-o", box, "-O", "-s", "smart"], **q)
    subprocess.run(["osmium", "tags-filter", box, "wr/building", "wr/building:part", "w/highway", "w/railway",
                    "wr/man_made=bridge", "-o", f, "-O"], **q)
    subprocess.run(["osmium", "export", f, "-f", "geojsonseq", "-o", gj, "-O", "-a", "type,id",
                    "--geometry-types=linestring,polygon"], **q)
    with open(gj) as fh:
        return [json.loads(l.lstrip("\x1e")) for l in fh if l.strip()]


def polys_of(g):
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--png", action="store_true", help="also write walls_debug.png (reachability raster)")
    a = ap.parse_args()
    t0 = time.time()
    out = os.path.join(HERE, "levels", a.name)
    L = json.load(open(os.path.join(out, "level.json")))
    F = Frame(L)
    ext = L["extent"]
    with tempfile.TemporaryDirectory() as td:
        feats = load_osm(need_pbf(a.pbf), L["bbox"], td)
    print(f"{len(feats)} OSM features ({time.time() - t0:.0f} s)")

    # ---------------- classify
    bld, parts, roads, bridges = [], [], [], []
    for f in feats:
        p, g = f.get("properties") or {}, f["geometry"]
        oid = f"{p.get('@type', 'w')[0]}{p.get('@id', '?')}"
        if g["type"] in ("Polygon", "MultiPolygon"):
            rings = [[F.xz(r) for r in poly] for poly in polys_of(g)]
            if p.get("building", "no") != "no":
                bld.append({"id": oid, "p": p, "polys": rings})
            elif p.get("building:part", "no") != "no":
                parts.append({"id": oid, "p": p, "polys": rings})
            elif p.get("man_made") == "bridge":
                bridges.extend(poly[0] for poly in rings)
        elif g["type"] == "LineString":
            xy = F.xz(g["coordinates"])
            if p.get("highway"):
                closed = np.allclose(xy[0], xy[-1])
                if closed and (p.get("area") == "yes" or p["highway"] in ("pedestrian", "platform", "footway")):
                    continue   # areas, not centre lines
                roads.append({"id": oid, "p": p, "xy": xy})
            if p.get("bridge", "no") != "no" and (p.get("railway") or p.get("highway")):
                half = 3.5 if p.get("railway") else max(3.0, num(p.get("width")) / 2 or HALF_W.get(p.get("highway"), 3))
                bridges.append(("line", xy, half))
    print(f"{len(bld)} buildings, {len(parts)} building:parts, {len(roads)} highway ways")

    # bridge test for layer > 0 buildings: share of footprint vertices over a bridge
    bridge_area = [Path(r) for r in bridges if not isinstance(r, tuple)]
    bridge_lines = [b for b in bridges if isinstance(b, tuple)]

    def over_bridge(ring):
        P = ring[:-1]
        if len(P) == 0:
            return False
        on = np.zeros(len(P), bool)
        b0, b1 = P.min(0) - 10, P.max(0) + 10
        for pa in bridge_area:
            e = pa.get_extents()
            if e.x1 < b0[0] or e.x0 > b1[0] or e.y1 < b0[1] or e.y0 > b1[1]:
                continue
            on |= pa.contains_points(P)
        for _, xy, half in bridge_lines:
            if xy[:, 0].max() + half < b0[0] or xy[:, 0].min() - half > b1[0] or xy[:, 1].max() + half < b0[1] or xy[:, 1].min() - half > b1[1]:
                continue
            on |= seg_dist(P[:, 0], P[:, 1], xy[:-1, 0], xy[:-1, 1], xy[1:, 0], xy[1:, 1]).min(1) < half
        return on.mean() >= 0.5

    drop = defaultdict(int)
    keep = []
    for b in bld:
        p = b["p"]
        kind = p.get("building")
        lay = num(p.get("layer"))
        why = None
        if kind in OVER_BUILDING:
            why = f"building={kind}"
        elif p.get("bridge", "no") != "no":
            why = "bridge=*"
        elif num(p.get("min_height")) > 0 or num(p.get("building:min_level")) > 0:
            why = "raised (min_height / min_level)"
        elif lay < 0 or p.get("location") in ("underground", "roof"):
            why = "underground / on a roof"
        elif lay > 0 and (kind in STATION or over_bridge(b["polys"][0][0])):
            why = "station hall / on a bridge (layer > 0)"
        if why is None:
            polys = []
            for poly in b["polys"]:
                if abs(area(poly[0])) < MIN_AREA:
                    continue
                polys.append([poly[0]] + [h for h in poly[1:] if abs(area(h)) >= MIN_HOLE])
            if not polys:
                why = f"tiny (< {MIN_AREA:g} m2)"
            else:
                bx = np.concatenate([poly[0] for poly in polys])
                if (bx[:, 0].max() < ext["minX"] - 5 or bx[:, 0].min() > ext["maxX"] + 5
                        or bx[:, 1].max() < ext["minZ"] - 5 or bx[:, 1].min() > ext["maxZ"] + 5):
                    why = "outside the level"
                else:
                    b["polys"] = polys
        if why:
            drop[why] += 1
        else:
            keep.append(b)
    print(f"kept {len(keep)} buildings; dropped: " + ", ".join(f"{k} {v}" for k, v in sorted(drop.items(), key=lambda kv: -kv[1])))

    # footprint rings (inside test), per building
    rings, holes, ring_b = [], [], []
    for bi, b in enumerate(keep):
        for poly in b["polys"]:
            for k, r in enumerate(poly):
                rings.append(r); holes.append(k > 0); ring_b.append(bi)
    FP = Rings(rings, holes)
    gates = {bi for bi, b in enumerate(keep) if b["p"].get("building") == "gate"}   # town gates: all passages open
    perim = [sum(float(np.hypot(*np.diff(r, axis=0).T).sum()) for r in [poly[0] for poly in b["polys"]]) for b in keep]

    # ---------------- building:parts: raised parts over no ground part open the outline
    gparts, rparts = [], []
    for pt in parts:
        p = pt["p"]
        if num(p.get("layer")) < 0 or p.get("location") == "underground":
            continue
        raised = (num(p.get("min_height")) > 0 or num(p.get("building:min_level")) > 0
                  or p.get("building:part") in ("roof", "canopy", "bridge"))
        for poly in pt["polys"]:
            (rparts if raised else gparts).append(poly[0])
    def owner(rs):   # building index of each part (by its vertex mean)
        if not rs:
            return np.zeros(0, int)
        w = FP.which(np.array([r[:-1].mean(0) for r in rs]))
        return np.array([ring_b[i] if i >= 0 else -1 for i in w])
    g_own, r_own = owner(gparts), owner(rparts)
    has_ground = set(int(i) for i in g_own if i >= 0)
    GP = Rings(gparts, [False] * len(gparts)) if gparts else None
    RP = Rings(rparts, [False] * len(rparts)) if rparts else None
    print(f"building:parts: {len(gparts)} on the ground, {len(rparts)} raised")

    def near_ring(pts, R, tol):
        """index of a ring of R containing the point or within tol of its boundary, else -1"""
        w = R.which(pts)
        miss = np.where(w < 0)[0]
        for k in miss:
            x, z = pts[k]
            for i in R.g.near(x - tol, z - tol, x + tol, z + tol):
                r = R.rings[i]
                if seg_dist(np.array([x]), np.array([z]), r[:-1, 0], r[:-1, 1], r[1:, 0], r[1:, 1]).min() <= tol:
                    w[k] = i; break
        return w

    # ---------------- edges: all rings, shared walls (same edge twice) removed
    E = []
    for r in rings:
        E.append(np.concatenate([r[:-1], r[1:]], 1))
    E = np.concatenate(E) if E else np.zeros((0, 4))
    E = E[np.hypot(E[:, 2] - E[:, 0], E[:, 3] - E[:, 1]) > 1e-3]
    q = np.round(E * 1000).astype(np.int64)
    a_first = (q[:, 0] < q[:, 2]) | ((q[:, 0] == q[:, 2]) & (q[:, 1] <= q[:, 3]))
    key = np.where(a_first[:, None], q, q[:, [2, 3, 0, 1]])
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    shared = cnt[inv.ravel()] > 1
    print(f"{len(E)} footprint edges, {shared.sum()} shared walls removed")
    E = E[~shared]

    def chains_of(E):
        """join edges into polylines through vertices of degree 2"""
        q = np.round(E * 1000).astype(np.int64)
        ka = [tuple(v) for v in q[:, :2]]; kb = [tuple(v) for v in q[:, 2:]]
        adj = defaultdict(list)
        for i in range(len(E)):
            adj[ka[i]].append(i); adj[kb[i]].append(i)
        used = np.zeros(len(E), bool)
        out = []

        def walk(i, start):
            pts = [E[i, :2] if start == ka[i] else E[i, 2:]]
            cur, v = i, start
            while True:
                used[cur] = True
                nv = kb[cur] if v == ka[cur] else ka[cur]
                pts.append(E[cur, 2:] if nv == kb[cur] else E[cur, :2])
                nxt = [j for j in adj[nv] if not used[j]]
                if len(adj[nv]) != 2 or not nxt:
                    break
                cur, v = nxt[0], nv
            return np.array(pts)
        for v, es in adj.items():   # open chains start at ends / junctions
            if len(es) != 2:
                for i in es:
                    if not used[i]:
                        out.append(walk(i, v))
        for i in range(len(E)):     # loops
            if not used[i]:
                out.append(walk(i, ka[i]))
        return out

    chains = [dp(c, SIMPLIFY) for c in chains_of(E)]

    # ground parts of opened buildings become walls (computed after the raised test below)
    # ---------------- capsules: passages, roads under buildings, road clearance
    CAP = Capsules()
    road_samples = []       # (x, z, way index) every 2 m, drivable surface roads (the checks)
    nway = defaultdict(int)
    skipped = defaultdict(int)
    for wi, r in enumerate(roads):
        p, xy = r["p"], r["xy"]
        hw = p["highway"]
        tun, cov = p.get("tunnel", "no"), p.get("covered", "no")
        lay = num(p.get("layer"))
        seglen = np.hypot(*np.diff(xy, axis=0).T)
        length = float(seglen.sum())
        if p.get("indoor") == "yes" or p.get("location") == "underground" or num(p.get("level"), 0) < 0:
            skipped["indoor / underground"] += 1; continue
        under = lay < 0 or (tun == "yes" and length >= 60) or tun == "culvert"
        passage = (not under and hw not in NO_PASSAGE and
                   (tun in ("building_passage", "passage", "covered", "yes") or cov in ("yes", "arcade", "colonnade", "building_passage")))
        if under:
            skipped["tunnel / underground"] += 1; continue
        if hw not in DRIVABLE and not passage:
            continue
        w = num(p.get("width"))
        if passage:
            rad = max(2.0, (w / 2 if w > 0 else 1.75) + WALL_HALF)
            rad = min(rad, 6.0)
            for k in range(len(xy) - 1):
                CAP.add(*xy[k], *xy[k + 1], rad, "passage")
            nway["passage"] += 1
        if hw not in DRIVABLE:
            continue
        # drivable: densify to <= 2 m pieces, clearance everywhere, wide where inside a footprint
        pts = [xy[0]]
        for k in range(len(xy) - 1):
            n = max(1, int(math.ceil(seglen[k] / 2.0)))
            t = np.arange(1, n + 1)[:, None] / n
            pts.extend(xy[k] + t * (xy[k + 1] - xy[k]))
        pts = np.array(pts)
        ins = FP.which(pts) >= 0
        wide = (w / 2 if w > 0 else (num(p.get("lanes")) * 1.75 + 1.0 if num(p.get("lanes")) > 0 else HALF_W.get(hw, 3))) + WALL_HALF
        wide = min(max(wide, ROAD_CLEAR + WALL_HALF + 0.2), 9.0)
        if ins.any():
            nway["road under a building"] += 1
        for k in range(len(pts) - 1):
            if ins[k] or ins[k + 1]:
                CAP.add(*pts[k], *pts[k + 1], wide, "road-under")
            else:
                CAP.add(*pts[k], *pts[k + 1], ROAD_CLEAR + WALL_HALF + 0.05, "road")
        for k in range(0, len(pts), 1):
            road_samples.append((pts[k][0], pts[k][1], wi))
    road_samples = np.array(road_samples).reshape(-1, 3)
    m = ((road_samples[:, 0] > ext["minX"] + 3) & (road_samples[:, 0] < ext["maxX"] - 3)
         & (road_samples[:, 1] > ext["minZ"] + 3) & (road_samples[:, 1] < ext["maxZ"] - 3))
    road_samples = road_samples[m]
    print(f"roads: {len(road_samples)} samples (2 m) on drivable ways; passages {nway['passage']} ways, "
          f"roads under / through buildings {nway['road under a building']} ways; skipped "
          + ", ".join(f"{k} {v}" for k, v in skipped.items()))

    # ---------------- special spots (things the car must reach)
    spots = []   # (name, x, z, reach radius: a reachable car centre within this distance)
    S = L["spawn"]
    spots.append(("spawn", S["x"], S["z"], 0.5))
    ep = os.path.join(out, "eggs.json")
    eggs = json.load(open(ep))["items"] if os.path.exists(ep) else []
    for it in eggs:
        if it["kind"] == "bear":
            spots.append((f"bear {it['name']}", it["x"], it["z"], 4.5))
        elif it["kind"] in ("ball", "goal", "pitch"):
            spots.append((f"{it['kind']} {it['id'].split('.', 1)[1]}", it["x"], it["z"], 3.0 if it["kind"] != "goal" else 4.0))
    sp = os.path.join(out, "sbahn.json")
    sb = json.load(open(sp)) if os.path.exists(sp) else None
    if sb:
        ens = sb.get("entrances") or [sb["entrance"]]   # one door per station (old files: one `entrance`)
        for en in ens:
            spots.append(("S-Bahn entrance zone" + ("" if en is ens[0] else f" {en['name']}"), en["x"], en["z"], en["r"]))
        for e in sb["exits"]:
            st = e["street"]
            spots.append((f"S-Bahn drop-off {e['name']}", st["x"], st["z"], 1.0))
        # the entrance sequence moves the car kinematically (js/sbahn.js pose), but its nose
        # must get into the zone: open the doorway (zone centre -> door) car-wide
        for en in ens:
            CAP.add(en["x"], en["z"], *en["door"], 2.2, "S-Bahn doorway")
    # Weltballon platform (js/balloon.js: OSM way 1250081894; constants there)
    BAL = (13.386118, 52.507932)
    bx, bz = F.xz([BAL])[0]
    platform = None
    if ext["minX"] < bx < ext["maxX"] and ext["minZ"] < bz < ext["maxZ"]:
        platform = (bx, bz, 10.0)
        spots.append(("Weltballon platform", bx, bz, 14.0))

    # ---------------- carve + raised parts, repeat with gateways for unreachable spots
    gateways = []
    for it in range(4):
        CAP.freeze()
        walls, cut_log = carve(chains, CAP, RP, GP, r_own, has_ground, near_ring, ext, perim, gates)
        opened = cut_log.pop("_opened"); gaps = cut_log.pop("_gaps"); open_m = cut_log.pop("_open_m")
        # ground parts of buildings opened by raised parts: their outlines are the walls there
        extra = []
        if opened:
            pe = []
            for i, r in enumerate(gparts):
                if g_own[i] in opened:
                    pe.append(np.concatenate([r[:-1], r[1:]], 1))
            if pe:
                pe = np.concatenate(pe)
                q = np.round(pe * 1000).astype(np.int64)
                af = (q[:, 0] < q[:, 2]) | ((q[:, 0] == q[:, 2]) & (q[:, 1] <= q[:, 3]))
                k2 = np.where(af[:, None], q, q[:, [2, 3, 0, 1]])
                _, inv, cnt = np.unique(k2, axis=0, return_inverse=True, return_counts=True)
                pe = pe[cnt[inv.ravel()] == 1]
                outl = [rings[j] for j in range(len(rings)) if ring_b[j] in opened]
                extra = carve_parts([dp(c, SIMPLIFY) for c in chains_of(pe)], outl, CAP, ext)
        segs = split_long(walls + extra)
        # inside rings: opened buildings use their ground parts
        in_rings = [(r, h) for r, h, b in zip(rings, holes, ring_b) if b not in opened]
        in_rings += [(r, False) for i, r in enumerate(gparts) if g_own[i] in opened]
        corridors = [c for c in CAP.a if c[5] != "road"]
        reach, reach_info = reachability(segs, ext, L["spawn"], CAP, corridors)
        bad = []
        for (name, x, z, rr) in spots:
            ok = reach_near(reach, ext, x, z, rr)
            if not ok:
                bad.append((name, x, z, rr))
        new = 0
        for name, x, z, rr in bad:
            if not name.startswith("bear") or any(g[0] == name for g in gateways):
                continue
            # one car-wide gateway from the spot to the nearest reachable street sample
            rs = road_samples[np.argsort(np.hypot(road_samples[:, 0] - x, road_samples[:, 1] - z))[:400]]
            near = rs[np.array([reach_near(reach, ext, sx, sz, 0.5) for sx, sz, _ in rs], bool)]
            if not len(near):
                continue
            tx, tz = near[0][:2]
            CAP.add(x, z, tx, tz, 2.2, f"gateway {name}")
            gateways.append((name, x, z, tx, tz))
            new += 1
        if not new:
            break
        print(f"  {new} gateway(s) carved, again")

    # ---------------- checks
    print(f"walls: {len(segs)} segments ({sum(np.hypot(s[2] - s[0], s[3] - s[1]) for s in segs) / 1000:.0f} km), "
          f"{len(walls)} pieces + {len(extra)} from ground parts of {len(opened)} opened buildings")
    print("carved gaps by reason: " + ", ".join(f"{k} {v[0]} gaps / {v[1]:.0f} m" for k, v in sorted(cut_log.items())))
    SG = np.array(segs)
    IR = Rings([r for r, _ in in_rings], [h for _, h in in_rings])
    CO = Capsules()
    for c in corridors:
        CO.add(*c)
    CO.freeze()
    rsx, rsz = road_samples[:, 0], road_samples[:, 1]
    inside = (IR.which(road_samples[:, :2]) >= 0) & (CO.hit(road_samples[:, :2]) < 0)
    clear = np.full(len(road_samples), np.inf)
    sg = Grid(16.0)
    for i, s in enumerate(SG):
        sg.add(i, min(s[0], s[2]), min(s[1], s[3]), max(s[0], s[2]), max(s[1], s[3]))
    for (gx, gz), ks in group(road_samples, 16.0):
        ids = set()
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                ids.update(sg.c.get((gx + dx, gz + dz), ()))
        if not ids:
            continue
        ids = np.array(sorted(ids))
        S2 = SG[ids]
        clear[ks] = seg_dist(rsx[ks], rsz[ks], S2[:, 0], S2[:, 1], S2[:, 2], S2[:, 3]).min(1) - WALL_HALF
    tight = clear < ROAD_CLEAR - 0.05
    unreach = np.array([not reach_near(reach, ext, x, z, 0.7) for x, z in road_samples[:, :2]])
    print(f"check roads: {len(road_samples)} samples, inside a footprint {inside.sum()}, wall face < {ROAD_CLEAR:g} m "
          f"from the centre line {tight.sum()} (min {clear.min():.2f} m), not reachable from the spawn {unreach.sum()} "
          f"({unreach.mean() * 100:.2f} %)")
    # unreachable road stretches, by way
    ur = defaultdict(int)
    for wi in road_samples[unreach, 2].astype(int):
        ur[wi] += 2
    ur_list = sorted(ur.items(), key=lambda kv: -kv[1])
    ur_ways = []
    for wi, l in ur_list[:12]:
        r = roads[wi]
        xs = road_samples[unreach & (road_samples[:, 2] == wi)]
        lon, lat = F.lonlat(*xs[len(xs) // 2][:2])
        ur_ways.append({"way": r["id"], "highway": r["p"]["highway"], "name": r["p"].get("name", ""), "m": l,
                        "lat": round(lat, 6), "lon": round(lon, 6)})
        print(f"   unreachable road {r['id']} {r['p']['highway']} {r['p'].get('name', '')!r} ~{l} m at {lat:.6f} N {lon:.6f} E")
    print(f"   ({len(ur_list)} ways with unreachable samples, {sum(ur.values()) / 1000:.1f} km)")
    problems = []
    for (name, x, z, rr) in spots:
        insb = IR.which(np.array([[x, z]]))[0] >= 0 and CO.hit(np.array([[x, z]]))[0] < 0
        ok = reach_near(reach, ext, x, z, rr)
        if insb or not ok:
            lon, lat = F.lonlat(x, z)
            problems.append({"spot": name, "x": round(x, 1), "z": round(z, 1), "lat": round(lat, 6), "lon": round(lon, 6),
                             "inside": bool(insb), "reachable": bool(ok)})
    if platform:
        px_, pz_, pr = platform
        d = seg_dist(np.array([px_]), np.array([pz_]), SG[:, 0], SG[:, 1], SG[:, 2], SG[:, 3]).min() - WALL_HALF
        print(f"check Weltballon platform: nearest wall face {d - pr:.1f} m outside the platform rim")
        if d < pr + 2:
            problems.append({"spot": "Weltballon platform", "wall_gap_m": round(d - pr, 1)})
    for it in eggs:   # pitch areas free of walls
        if it["kind"] == "pitch" and it.get("corners"):
            c = np.array(it["corners"] + it["corners"][:1], float)
            inn = Path(c).contains_points(np.concatenate([SG[:, :2], SG[:, 2:]]))
            if inn.any():
                problems.append({"spot": f"pitch {it['id']}", "walls_on_pitch": int(inn.sum())})
    for g in gateways:
        lon, lat = F.lonlat(g[1], g[2])
        print(f"   gateway carved for {g[0]} ({lat:.6f} N {lon:.6f} E) toward the street at x {g[3]:.1f} z {g[4]:.1f}")
    print(f"check special spots: {len(spots)} checked, problems: {len(problems)}")
    for pr in problems:
        print("   NOT OK:", pr)
    print(f"reachability raster: {reach_info}")
    # buildings opened by raised parts: share of the outline opened (large shares are suspicious)
    for bi, m_ in sorted(open_m.items(), key=lambda kv: -kv[1])[:12]:
        b = keep[bi]; per = perim[bi]
        lon, lat = F.lonlat(*b["polys"][0][0][0])
        print(f"   opened by raised parts: {b['id']} {b['p'].get('name', b['p'].get('building'))!r} {m_:.0f} m of {per:.0f} m outline ({lat:.5f} N {lon:.5f} E)")
    print(f"   opened buildings ({len(opened)}): " + ", ".join(sorted(set(str(keep[b]['p'].get('name') or keep[b]['id']) for b in opened))))
    for bi, b in enumerate(keep):   # Brandenburger Tor: a car-wide line through it from west to east
        if b["p"].get("name") == "Brandenburger Tor":
            r = b["polys"][0][0]
            c = r[:-1].mean(0)
            lanes = 0
            for dz in np.arange(-30, 30, 0.5):
                xs = np.arange(c[0] - 20, c[0] + 20, 0.5)
                if all(reach_near(reach, ext, x, c[1] + dz, 0.0) for x in xs):
                    lanes += 1
            print(f"check Brandenburger Tor: opened {bi in opened}, {lanes} free west-east raster lines (0.5 m) through it")
    for (name, x, z, rr) in spots:   # what opens the way to each bear (gaps within 60 m)
        if not name.startswith("bear"):
            continue
        near_g = [g for g in gaps if math.hypot(g[1] - x, g[2] - z) < 60 and g[0] != "road"]
        if near_g:
            print(f"   {name}: gaps within 60 m: " + ", ".join(f"{g[0]} {g[3]:.1f} m at {math.hypot(g[1] - x, g[2] - z):.0f} m" for g in near_g[:6]))
    if a.png:
        Image.fromarray(np.where(reach, 230, 40).astype(np.uint8)).save(os.path.join(out, "walls_debug.png"))   # row = z (south down)

    # ---------------- write
    write(out, segs, in_rings, corridors, {
        "level": a.name, "buildings": len(keep), "dropped": dict(drop),
        "carved": {k: {"gaps": v[0], "m": round(v[1])} for k, v in cut_log.items()},
        "openedByParts": len(opened), "gateways": [{"spot": g[0], "x": round(g[1], 1), "z": round(g[2], 1)} for g in gateways],
        "checks": {"roadSamples": int(len(road_samples)), "roadInside": int(inside.sum()), "roadTight": int(tight.sum()),
                   "roadUnreachable": int(unreach.sum()), "unreachableWays": ur_ways, "spots": len(spots), "problems": problems},
    })
    print(f"done in {time.time() - t0:.0f} s")


def carve(chains, CAP, RP, GP, r_own, has_ground, near_ring, ext, perim, gates):
    """sample chains at SAMPLE m, drop samples inside capsules / under raised parts / outside
    the level; return kept pieces [(n, 2)] and {reason: [gaps, metres]}"""
    pieces, log, opened, gaps = [], defaultdict(lambda: [0, 0.0]), set(), []
    open_m = defaultdict(float)
    allp, idx = [], []
    for ci, c in enumerate(chains):
        seg = np.diff(c, axis=0); sl = np.hypot(seg[:, 0], seg[:, 1])
        P = [c[:1]]
        for k in range(len(seg)):
            n = max(1, int(math.ceil(sl[k] / SAMPLE)))
            t = np.arange(1, n + 1)[:, None] / n
            P.append(c[k] + t * seg[k])
        P = np.concatenate(P)
        allp.append(P); idx.append(np.full(len(P), ci))
    P = np.concatenate(allp); I = np.concatenate(idx)
    why = np.full(len(P), "", dtype=object)
    h = CAP.hit(P)
    for k in np.where(h >= 0)[0]:
        why[k] = CAP.kind[h[k]]
    outside = (P[:, 0] < ext["minX"] - 2) | (P[:, 0] > ext["maxX"] + 2) | (P[:, 1] < ext["minZ"] - 2) | (P[:, 1] > ext["maxZ"] + 2)
    why[outside & (why == "")] = "_outside"
    if RP is not None:
        cand = np.where(why == "")[0]
        rw = RP.which(P[cand])
        # boundary tolerance only for candidates near a raised part
        near = cand[rw < 0]
        sub = [k for k in near if RP.g.near(P[k, 0] - .3, P[k, 1] - .3, P[k, 0] + .3, P[k, 1] + .3)]
        if sub:
            rw2 = near_ring(P[sub], RP, 0.3)
            rwf = dict(zip(cand[rw >= 0], rw[rw >= 0])); rwf.update({k: v for k, v in zip(sub, rw2) if v >= 0})
        else:
            rwf = dict(zip(cand[rw >= 0], rw[rw >= 0]))
        ks = np.array([k for k, v in rwf.items() if r_own[v] in has_ground], int)
        if len(ks):
            gw = near_ring(P[ks], GP, 0.3) if GP is not None else np.full(len(ks), -1)
            RAISED = "raised part (no wall below)"
            own = {}
            for k, g in zip(ks, gw):
                if g < 0:
                    why[k] = RAISED; own[k] = int(r_own[rwf[k]])
            # only passage-like openings: runs <= MAX_OPEN m, and <= OPEN_SHARE of a building's outline;
            # longer ones are overhangs / arcades / incompletely mapped parts -> the outline stays a wall
            for ci in np.unique(I[list(own)]) if own else []:
                sel = np.where(I == ci)[0]
                r = why[sel] == RAISED
                j = 0
                while j < len(sel):
                    if r[j]:
                        j2 = j
                        while j2 < len(sel) and r[j2]:
                            j2 += 1
                        if (j2 - j) * SAMPLE > MAX_OPEN and own.get(sel[j]) not in gates:
                            for k in sel[j:j2]:
                                why[k] = ""; own.pop(k, None)
                        j = j2
                    else:
                        j += 1
            for k, b in own.items():
                open_m[b] += SAMPLE
            for b in [b for b, m_ in open_m.items() if m_ > OPEN_SHARE * perim[b] and b not in gates]:
                del open_m[b]
            for k, b in own.items():
                if b in open_m:
                    opened.add(b)
                else:
                    why[k] = ""
    # runs
    for ci in range(len(chains)):
        sel = np.where(I == ci)[0]
        w = why[sel]
        keep = w == ""
        k0 = None
        for j in range(len(sel) + 1):
            if j < len(sel) and keep[j]:
                if k0 is None:
                    k0 = j
                continue
            if k0 is not None and j - k0 >= 2:
                pc = P[sel[k0:j]]
                if np.hypot(*(pc[-1] - pc[0])) > 0.3 or len(pc) > 4:
                    pieces.append(dp(pc, 0.02))
            k0 = None
        # gap log
        j = 0
        while j < len(sel):
            if not keep[j]:
                j2 = j
                while j2 < len(sel) and not keep[j2]:
                    j2 += 1
                r = w[j]
                if r != "_outside":
                    log[r][0] += 1; log[r][1] += (j2 - j) * SAMPLE
                    mid = P[sel[(j + j2) // 2]]
                    gaps.append((r, float(mid[0]), float(mid[1]), (j2 - j) * SAMPLE))
                j = j2
            else:
                j += 1
    log = dict(log); log["_opened"] = opened; log["_gaps"] = gaps; log["_open_m"] = open_m
    return pieces, log


def carve_parts(chains, outline_rings, CAP, ext):
    """ground-part walls of opened buildings, minus what lies on the building outline"""
    pieces = []
    O = np.concatenate([np.concatenate([r[:-1], r[1:]], 1) for r in outline_rings]) if outline_rings else np.zeros((0, 4))
    for c in chains:
        seg = np.diff(c, axis=0); sl = np.hypot(seg[:, 0], seg[:, 1])
        P = [c[:1]]
        for k in range(len(seg)):
            n = max(1, int(math.ceil(sl[k] / SAMPLE)))
            P.append(c[k] + (np.arange(1, n + 1)[:, None] / n) * seg[k])
        P = np.concatenate(P)
        keep = CAP.hit(P) < 0
        if len(O):
            keep &= seg_dist(P[:, 0], P[:, 1], O[:, 0], O[:, 1], O[:, 2], O[:, 3]).min(1) > 0.3
        k0 = None
        for j in range(len(P) + 1):
            if j < len(P) and keep[j]:
                if k0 is None:
                    k0 = j
                continue
            if k0 is not None and j - k0 >= 2:
                pieces.append(dp(P[k0:j], 0.02))
            k0 = None
    return pieces


def split_long(pieces):
    segs = []
    for pc in pieces:
        for k in range(len(pc) - 1):
            a, b = pc[k], pc[k + 1]
            l = math.hypot(*(b - a))
            if l < 0.05:
                continue
            n = max(1, int(math.ceil(l / MAX_SEG)))
            for i in range(n):
                p0, p1 = a + (b - a) * i / n, a + (b - a) * (i + 1) / n
                segs.append((p0[0], p0[1], p1[0], p1[1]))
    return segs


def reachability(segs, ext, spawn, CAP, corridors):
    """0.5 m raster: walls grown by WALL_HALF + car half width; flood fill from the spawn"""
    nx = int(math.ceil((ext["maxX"] - ext["minX"]) / RASTER)); nz = int(math.ceil((ext["maxZ"] - ext["minZ"]) / RASTER))
    img = Image.new("1", (nx, nz), 0)
    dr = ImageDraw.Draw(img)
    grow = (WALL_HALF + CAR_HALF_W) / RASTER
    w = max(1, int(round(2 * grow)))
    for x0, z0, x1, z1 in segs:
        a = ((x0 - ext["minX"]) / RASTER, (z0 - ext["minZ"]) / RASTER)
        b = ((x1 - ext["minX"]) / RASTER, (z1 - ext["minZ"]) / RASTER)
        dr.line([a, b], fill=1, width=w)
        for (u, v) in (a, b):
            dr.ellipse([u - grow, v - grow, u + grow, v + grow], fill=1)
    blocked = np.array(img, bool)
    g = int(math.ceil(grow))
    blocked[:g, :] = blocked[-g:, :] = True; blocked[:, :g] = blocked[:, -g:] = True
    lab, n = ndimage.label(~blocked)
    del blocked
    sx, sz = int((spawn["x"] - ext["minX"]) / RASTER), int((spawn["z"] - ext["minZ"]) / RASTER)
    l0 = lab[sz, sx]
    if l0 == 0:
        print("WARNING: the spawn is blocked")
    reach = lab == l0
    info = f"{nx}x{nz} @ {RASTER} m, {n} free regions, spawn region {reach.mean() * 100:.1f} % of the level"
    return reach, info


def reach_near(reach, ext, x, z, r):
    nz, nx = reach.shape
    i0, i1 = int((x - r - ext["minX"]) / RASTER), int((x + r - ext["minX"]) / RASTER) + 1
    j0, j1 = int((z - r - ext["minZ"]) / RASTER), int((z + r - ext["minZ"]) / RASTER) + 1
    i0, j0 = max(0, i0), max(0, j0); i1, j1 = min(nx, i1), min(nz, j1)
    if i1 <= i0 or j1 <= j0:
        return False
    sub = reach[j0:j1, i0:i1]
    if not sub.any():
        return False
    jj, ii = np.nonzero(sub)
    cx = ext["minX"] + (ii + i0 + 0.5) * RASTER; cz = ext["minZ"] + (jj + j0 + 0.5) * RASTER
    return bool((np.hypot(cx - x, cz - z) <= r + RASTER).any())


def write(out, segs, in_rings, corridors, meta):
    """walls.bin: little endian, sections 4-byte aligned, coordinates int16 in 1/SCALE m
      segments  int16 [nSeg * 4]      x0 z0 x1 z1
      ringLen   int32 [nRing]         vertex count, negative = courtyard (hole)
      rings     int16 [sum |len| * 2] x z ... (closed: last = first)
      corridors int16 [nCor * 5]      x0 z0 x1 z1 r"""
    def q(a):
        a = np.round(np.asarray(a, float) * SCALE)
        assert np.abs(a).max(initial=0) < 32767, "level too large for int16 at 0.1 m"
        return a.astype("<i2")
    S = q(np.array(segs).reshape(-1, 4))
    RL, RV = [], []
    for r, h in in_rings:
        r = dp(r, SIMPLIFY)
        if len(r) < 4:
            continue
        RL.append(-len(r) if h else len(r)); RV.append(r)
    RL = np.array(RL, "<i4"); RV = q(np.concatenate(RV)) if RV else np.zeros((0, 2), "<i2")
    C = q(np.array([c[:5] for c in corridors], float).reshape(-1, 5))
    blobs, offs, off = [S, RL, RV, C], [], 0
    data = b""
    for bl in blobs:
        b = bl.tobytes()
        offs.append(off)
        pad = (-len(b)) % 4
        data += b + b"\0" * pad
        off += len(b) + pad
    tmp = os.path.join(out, "walls.bin.tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, os.path.join(out, "walls.bin"))
    meta.update({
        "file": "walls.bin", "scale": 1 / SCALE, "wallHalf": WALL_HALF, "bytes": len(data),
        "segments": {"offset": offs[0], "count": int(len(S))},
        "ringLen": {"offset": offs[1], "count": int(len(RL))},
        "rings": {"offset": offs[2], "count": int(len(RV))},
        "corridors": {"offset": offs[3], "count": int(len(C))},
        "source": "OpenStreetMap building=* / building:part / highway (local extract via osmium), (c) OpenStreetMap contributors, ODbL",
        "format": "little endian int16 in 1/10 m, level frame (x = east, z = -north): segments x0 z0 x1 z1 (Box2D boxes "
                  "2 * wallHalf thick); ringLen int32 (negative = courtyard) + rings x z (inside test: outer count > "
                  "courtyard count); corridors x0 z0 x1 z1 r (carved passages: never inside)",
    })
    json.dump(meta, open(os.path.join(out, "walls.json"), "w"), indent=1, ensure_ascii=False)
    print(f"-> {out}/walls.bin {len(data) / 1e6:.2f} MB: {len(S)} segments, {len(RL)} rings ({len(RV)} vertices), "
          f"{len(C)} corridors")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Decorations fixed to real buildings -> levels/<name>/sights.json (js/sights.js).

  python3 build_sights.py [--level mitte_all] [--pbf berlin-latest.osm.pbf | env OSM_PBF] [--mesh-src DIR]

  clock : the national debt clock ("Schuldenuhr") over the entrance of Reinhardtstrasse 52: a black
          LED panel with red seven-segment digits that count up (js/sights.js). Digits only.
  nest  : a stork's nest with two white storks on the highest flat part of the roof of
          Charitestrasse 3 (the NABU office).
  berlinale: red carpet, stanchions with ropes, crowd barriers and a "Berlinale!" banner at the building the
          owner's car stood at (BERLINALE: the Theater am Potsdamer Platz).

Local data only (no network):
  - OSM extract (osmium CLI): the address / name nodes, the building footprint, the street
    centre lines. Clock: the node named like "Schuldenuhr" is a vertex of the footprint of
    Reinhardtstrasse 52; the straight facade run through it (vertices within RUN_DEG of one
    direction) is the facade, outward = away from the footprint. Nest: the footprint that holds
    the node named like NABU (addr Charitestrasse 3).
  - L1 mesh (levels/<name>/tiles.json -> ../berlin_mesh_2025_wab/, build_pits.Level): street level
    in front of the facade, the facade's real line (the panel never cuts a wall), the roof top.
Frame: level x = east, z = -north (m), y = mesh height (m, game frame); heading clockwise from
north (rad): the direction the panel faces / the storks look, forward = (sin h, -cos h).
Each sight also gets `view`: a suggested car start (x, z, heading) on the street with the object in
the default camera's view; build_spots.py carries these as known starts (slugs schuldenuhr, nabu).
"""
import argparse, json, math, os, re, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PBF = os.environ.get("OSM_PBF")   # local OSM extract (.osm.pbf): --pbf or env OSM_PBF

# ---------------------------------------------------------------- the numbers (easy to correct)
# Debt clock: the owner's photo of 13 Jan 2026 shows 2.638.033.084.257 EUR (big row) and, on the small
# row, 6.918 (EUR per second) and 31.596 (EUR per inhabitant). js/sights.js shows
#   value(t) = base + rate * (t - at)  and  perCapita(t) = value(t) / (base / perCapita)
CLOCK_NUMBERS = {"base": 2638033084257, "at": "2026-01-13T12:00:00+01:00", "rate": 6918, "perCapita": 31596}
CLOCK = {"name": r"Schuldenuhr", "street": "Reinhardtstraße", "number": "52",
         "width": 6.6, "height": 1.6,     # m panel (the real one ~ 6 x 1.3; larger so it reads from the 60/80 camera)
         "u": -0.7,                       # m along the facade from the run's middle (+ = facade direction t); the
                                          # right end stays west of the east block's corner (u ~ +2.7)
         "bottom": 3.3,                   # m above the street in front
         "tilt": 15.0,                    # deg, face turned up toward the high street camera
         "gap": 0.25}                     # m in front of the outermost wall behind the panel (`back`: depth to the
                                          # facade behind its middle, js/sights.js bridges it with two brackets)
NEST = {"name": r"Naturschutzbund|NABU", "street": "Charitéstraße", "number": "3",
        "radius": 1.0,                    # m nest radius (js/sights.js builds it from this)
        "stork": 2.3}                     # m stork height (larger than life: reads from the street camera)
RUN_DEG = 15.0
CELL = 0.25
VIEW_AHEAD = {"clock": 14.0, "nest": 2.0}   # m: object ahead of the car start (default camera: see README)
VIEW_SIDE = 3.0     # m along the facade (east): straight out from the clock a tree crown hangs over the street
# Berlinale (the owner, 2026-11-21): "where my car is now standing" (car pose the owner gave: level x, z, heading rad,
# at Marlene-Dietrich-Platz). Building, first rule that finds one: (1) a theatre footprint (amenity=theatre or a name
# like THEATRE) within NEAR m of the car -> its facade nearest the car; (2) the ray along the heading to the first OSM
# footprint edge within RAY m; (3) the nearest facade. The carpet starts at an OSM entrance node on that facade run
# (nearest to the foot / hit point, within ENTRANCE_MAX m), else at that point, and runs out toward the car's side.
THEATRE = r"Theater am Potsdamer Platz|Berlinale|Musical Theater|Stage Theater"
BERLINALE = {"car": (-1647.37, 1679.04, -1.881), "near": 80.0, "ray": 40.0, "entrance_max": 45.0,
             "carpet": 3.2,                     # m wide
             "length": (8.0, 16.0),             # m, clamped; ends 1 m short of the nearest street centre line
             "open_len": 12.0,                  # door under a canopy (mesh roof over it): carpet m from the canopy edge out
             "view_beyond": 2.0,                # m: spot start beyond the carpet end, facing the door (5 m: a bollard)
             "banner": (9.0, 1.8), "bottom": 9.5, "tilt": 8.0, "gap": 0.25}   # bottom: m over the ground; truss posts under a canopy
# OSM is cut to these boxes (W S E N) only, one after the other: clock, nest / Potsdamer Platz (osmium's
# smart extract of the whole level, or of one box over all of them, needs 4+ GB here)
SIGHTS_BBOXES = [(13.374, 52.518, 13.398, 52.525), (13.366, 52.504, 13.378, 52.511)]


def need_pbf(p):
    if not p:
        sys.exit("no OSM extract: pass --pbf <berlin-latest.osm.pbf> or set OSM_PBF")
    return p


def load_osm(pbf, bboxes, td):
    out, seen = [], set()
    for bb in bboxes:
        for f in load_box(pbf, bb, td):
            k = (f["properties"].get("@type"), f["properties"].get("@id"), f["geometry"]["type"])
            if k not in seen:
                seen.add(k); out.append(f)
    return out


def load_box(pbf, bbox, td):
    W, S, E, N = bbox
    box, f, gj = (os.path.join(td, n) for n in ("box.osm.pbf", "f.osm.pbf", "f.geojsonl"))
    q = dict(check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["osmium", "extract", "-b", f"{W},{S},{E},{N}", pbf, "-o", box, "-O", "-s", "smart"], **q)
    subprocess.run(["osmium", "tags-filter", box, "n/name", "n/addr:street", "n/entrance", "wr/building", "wr/amenity=theatre", "w/highway",
                    "-o", f, "-O"], **q)
    subprocess.run(["osmium", "export", f, "-f", "geojsonseq", "-o", gj, "-O", "-a", "type,id"], **q)
    out = []
    with open(gj) as fh:
        for l in fh:
            l = l.strip("\x1e \n")
            if l:
                out.append(json.loads(l))
    return out


def in_ring(p, r):
    x, y = p; c = False
    for i in range(len(r)):
        a, b = r[i], r[i - 1]
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
    return c


def area(r):
    r = np.asarray(r)
    return 0.5 * abs(np.dot(r[:, 0], np.roll(r[:, 1], 1)) - np.dot(r[:, 1], np.roll(r[:, 0], 1)))


def seg_near(p, a, b):
    d = b - a; L2 = float(d @ d)
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, float((p - a) @ d) / L2))
    return a + t * d, t


class Sights:
    def __init__(self, level, mesh_src, feats):
        from build_pits import Level
        self.lv = Level(level, mesh_src)
        self.F = feats
        self.en = lambda c: np.array(self.lv.to_en(c[0], c[1]))

    def node(self, rx, street=None, number=None):
        for f in self.F:
            p, g = f["properties"], f["geometry"]
            if g["type"] == "Point" and re.search(rx, p.get("name", "") + " " + p.get("short_name", "")):
                if street is None or (p.get("addr:street") in (None, street) and p.get("addr:housenumber") in (None, number)):
                    return f
        return None

    def buildings(self, theatre=False):
        for f in self.F:
            p, g = f["properties"], f["geometry"]
            if ("building" in p or (theatre and p.get("amenity") == "theatre")) and g["type"] in ("Polygon", "MultiPolygon"):
                for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
                    yield p, poly[0]

    def street(self, name):
        return [np.array([self.en(c) for c in f["geometry"]["coordinates"]]) for f in self.F
                if f["geometry"]["type"] == "LineString" and f["properties"].get("highway") and f["properties"].get("name") == name]

    def street_near(self, name, p):
        """nearest point on the named street's centre lines and the unit direction there (E, N)"""
        best = None
        for ln in self.street(name):
            for a, b in zip(ln[:-1], ln[1:]):
                q, _ = seg_near(p, a, b)
                d = float(np.hypot(*(q - p)))
                if best is None or d < best[0]:
                    best = (d, q, (b - a) / max(1e-9, np.hypot(*(b - a))))
        return best

    def top(self, E0, N0, nx, ny):
        from build_level import raster_top
        prims, nt = self.lv.prims((E0, N0, E0 + nx * CELL, N0 + ny * CELL), margin=2.0)
        T = raster_top(prims, E0, N0, nx, ny, CELL, colour=False)[0]
        del prims
        print(f"    mesh: {nt} L1 tiles, {nx} x {ny} cells of {CELL} m")
        return T

    # ------------------------------------------------------------ the debt clock
    def clock(self):
        C = CLOCK
        nd = self.node(C["name"])
        if nd is None:
            sys.exit("clock: no OSM node named like " + C["name"])
        cl = nd["geometry"]["coordinates"]
        ring = None
        for p, r in self.buildings():
            if p.get("addr:street") == C["street"] and p.get("addr:housenumber") == C["number"] and any(
                    abs(c[0] - cl[0]) < 1e-9 and abs(c[1] - cl[1]) < 1e-9 for c in r):
                ring = r; break
        if ring is None:
            sys.exit(f"clock: node {nd['properties']['@id']} is no vertex of {C['street']} {C['number']}")
        R = [self.en(c) for c in ring[:-1]]
        n = len(R)
        k = next(i for i, c in enumerate(ring[:-1]) if abs(c[0] - cl[0]) < 1e-9 and abs(c[1] - cl[1]) < 1e-9)
        ea, eb = R[(k + 1) % n] - R[k], R[k] - R[k - 1]
        ref = ea if np.hypot(*ea) > np.hypot(*eb) else eb
        ref = ref / np.hypot(*ref)
        same = lambda e: np.hypot(*e) > 0 and abs(math.degrees(math.asin(max(-1, min(1, float(np.cross(ref, e / np.hypot(*e)))))))) < RUN_DEG \
            and float(ref @ e) > 0
        i0, i1 = k, k
        while same(R[i0] - R[(i0 - 1) % n]) and (i0 - 1) % n != k: i0 = (i0 - 1) % n
        while same(R[(i1 + 1) % n] - R[i1]) and (i1 + 1) % n != k: i1 = (i1 + 1) % n
        a, b = R[i0], R[i1]
        t = (b - a) / np.hypot(*(b - a)); mid = (a + b) / 2
        nn = np.array([t[1], -t[0]])
        if in_ring(mid + nn * 0.5, np.array(R)):
            nn = -nn
        print(f"  clock: OSM node {nd['properties']['@id']} on the footprint of {C['street']} {C['number']}; "
              f"facade run {np.hypot(*(b - a)):.2f} m ({i1 - i0 if i1 >= i0 else i1 - i0 + n} edges), outward ({nn[0]:.3f} E, {nn[1]:.3f} N)")
        # mesh window around the run
        E0, N0 = math.floor(mid[0] - 16), math.floor(mid[1] - 16)
        T = self.top(E0, N0, int(32 / CELL), int(32 / CELL))
        at = lambda p: T[int((p[1] - N0) / CELL), int((p[0] - E0) / CELL)]
        us = np.arange(C["u"] - C["width"] / 2, C["u"] + C["width"] / 2 + 1e-6, CELL)
        street = [at(mid + nn * s + t * u) for s in np.arange(5.0, 8.01, CELL) for u in us]
        g = float(np.nanpercentile(street, 25))   # the pavement (the far west of the window climbs to the S-Bahn ramp)
        walls = []
        for u in us:   # scan from the street toward the facade: first cell with a wall/roof 5 m over the street
            s_w = None
            for s in np.arange(4.0, -3.01, -CELL):   # the facade, not the S-Bahn ramp 5+ m out in the west
                v = at(mid + nn * s + t * u)
                if np.isfinite(v) and v > g + 5.0:
                    s_w = s; break
            walls.append(s_w)
        if all(w is None for w in walls):
            sys.exit("clock: no facade in the mesh behind the panel")
        # in front of the outermost wall over the whole span; the tilt leans the top edge back (panel 0.14 m deep)
        sp = max(w for w in walls if w is not None) + C["gap"] + C["height"] / 2 * math.sin(math.radians(C["tilt"])) + 0.07
        print(f"    street {g:.2f} m; wall line (m in front of the OSM run) over the panel span: "
              + " ".join("-" if w is None else f"{w:.2f}" for w in walls[::2]) + f"  -> panel plane {sp:.2f} m")
        p = mid + t * C["u"] + nn * sp
        y = g + C["bottom"] + C["height"] / 2
        h = math.atan2(nn[0], nn[1])          # (E, N) -> clockwise from north
        lat, lon = self.lv_latlon(p)
        rec = {"x": round(float(p[0]), 2), "z": round(float(-p[1]), 2), "y": round(y, 2), "street": round(g, 2),
               "heading": round(h, 4), "deg": round(math.degrees(h) % 360, 1), "tilt": C["tilt"],
               "width": C["width"], "height": C["height"], "lat": lat, "lon": lon,
               "back": round(float(sp - np.median([w for w in walls if w is not None])), 2), "numbers": CLOCK_NUMBERS,
               "source": f"OSM node {nd['properties']['@id']} ('{nd['properties'].get('name')}') = vertex of the footprint of "
                         f"{C['street']} {C['number']}; facade line and street level from the L1 mesh"}
        rec["view"] = self.view(p, nn, VIEW_AHEAD["clock"], facing=True, side=t * VIEW_SIDE)
        return rec

    def lv_latlon(self, p):
        lv = self.lv
        kx, kz = 111320 * math.cos(math.radians(lv.lat0)), 111132.0
        lat, lon = lv.lat0 + p[1] / kz, lv.lon0 + p[0] / kx
        for _ in range(4):
            e, n_ = lv.to_en(lon, lat)
            lon += (p[0] - e) / kx; lat += (p[1] - n_) / kz
        return round(lat, 7), round(lon, 7)

    def view(self, p, nn, ahead, facing=False, street=None, side=0.0):
        """suggested car start: facing -> out from the object along nn (+ side, E/N), turned toward it;
        else on the street centre line (street name), the object `ahead` m in front along the street"""
        if facing:
            s = p + nn * ahead + side
            h = math.atan2(p[0] - s[0], p[1] - s[1])
        else:
            d, q, dirv = self.street_near(street, p)
            if dirv[1] < 0:          # drive the northward way (any choice works; fixed for repeatability)
                dirv = -dirv
            s = q - dirv * ahead
            h = math.atan2(dirv[0], dirv[1])
        return {"x": round(float(s[0]), 1), "z": round(float(-s[1]), 1), "heading": round(h, 3), "deg": round(math.degrees(h) % 360)}

    # ------------------------------------------------------------ the stork's nest
    def nest(self):
        C = NEST
        nd = self.node(C["name"], C["street"], C["number"])
        if nd is None:
            sys.exit("nest: no OSM node named like " + C["name"])
        c = nd["geometry"]["coordinates"]
        cand = [(area(r), r) for p, r in self.buildings() if in_ring(c, r)]
        if not cand:
            sys.exit(f"nest: node {nd['properties']['@id']} in no building footprint")
        ring = min(cand, key=lambda a: a[0])[1]
        R = np.array([self.en(q) for q in ring])
        E0, N0 = math.floor(R[:, 0].min() - 3), math.floor(R[:, 1].min() - 3)
        nx, ny = int(math.ceil((R[:, 0].max() + 3 - E0) / CELL)), int(math.ceil((R[:, 1].max() + 3 - N0) / CELL))
        print(f"  nest: OSM node {nd['properties']['@id']} ('{nd['properties'].get('name')}') in a footprint of {area(R):.0f} m2")
        T = self.top(E0, N0, nx, ny)
        im = Image.new("L", (nx, ny), 0)
        ImageDraw.Draw(im).polygon([((e - E0) / CELL - 0.5, (n_ - N0) / CELL - 0.5) for e, n_ in R], fill=1)
        M = np.array(im, bool) & np.isfinite(T)
        f = np.where(M, T, 0.0).astype(np.float64)
        k = 9
        mean = ndimage.uniform_filter(f, k); sd = np.sqrt(np.maximum(ndimage.uniform_filter(f * f, k) - mean ** 2, 0))
        full = ndimage.uniform_filter(M.astype(float), k) > 0.999
        flat = M & full & (sd < 0.12)
        if not flat.any():
            sys.exit("nest: no flat roof part")
        hmax = float(np.percentile(T[flat], 98))
        plate = flat & (T >= hmax - 0.4)
        lab, nl = ndimage.label(plate)
        big = lab == (np.argmax(ndimage.sum(plate, lab, range(1, nl + 1))) + 1)
        inner = ndimage.distance_transform_edt(big) * CELL >= C["radius"] + 0.3
        if not inner.any():
            sys.exit("nest: highest flat part too small for the nest")
        jj, ii = np.nonzero(inner)
        P = np.c_[E0 + (ii + 0.5) * CELL, N0 + (jj + 0.5) * CELL]
        sd_ = [self.street_near(C["street"], q)[0] for q in P[::max(1, len(P) // 400)]]
        sel = np.argmin(sd_) * max(1, len(P) // 400)
        p = P[sel]
        j, i = jj[sel], ii[sel]
        r = int(C["radius"] / CELL)
        y = float(np.nanmedian(T[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1][big[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]]))
        ground = float(np.nanpercentile(np.where(M, np.nan, T), 10))
        d, q, _ = self.street_near(C["street"], p)
        face = math.atan2(q[0] - p[0], q[1] - p[1])
        print(f"    roof plateau {big.sum() * CELL * CELL:.0f} m2 at {hmax:.2f} m (98th pct of flat roof), nest at {y:.2f} m, "
              f"{y - ground:.1f} m over the ground around, {d:.1f} m from the {C['street']} centre line")
        lat, lon = self.lv_latlon(p)
        rec = {"x": round(float(p[0]), 2), "z": round(float(-p[1]), 2), "y": round(y, 2), "ground": round(ground, 2),
               "heading": round(face, 4), "deg": round(math.degrees(face) % 360, 1), "radius": C["radius"], "stork": C["stork"],
               "lat": lat, "lon": lon,
               "source": f"OSM node {nd['properties']['@id']} ('{nd['properties'].get('name')}', {C['street']} {C['number']}) in its "
                         f"footprint; highest flat roof part of the L1 mesh, the point of it nearest the street"}
        rec["view"] = self.view(p, None, VIEW_AHEAD["nest"], street=C["street"])
        return rec

    # ------------------------------------------------------------ helpers for the newer sights
    CAR_ROADS = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service", "pedestrian"}

    def run_at(self, R, k):
        """straight facade run through vertex k of the closed ring R (E/N points, last = first):
        ends a, b, unit direction t and the outward normal nn (away from the footprint)"""
        P = R[:-1] if np.allclose(R[0], R[-1]) else R
        n = len(P)
        ea, eb = P[(k + 1) % n] - P[k], P[k] - P[k - 1]
        ref = ea if np.hypot(*ea) > np.hypot(*eb) else eb
        ref = ref / np.hypot(*ref)

        def same(e):
            L = np.hypot(*e)
            return L > 0 and abs(math.degrees(math.asin(max(-1, min(1, float(np.cross(ref, e / L))))))) < RUN_DEG and float(ref @ e) > 0
        i0, i1 = k, k
        while same(P[i0] - P[(i0 - 1) % n]) and (i0 - 1) % n != k: i0 = (i0 - 1) % n
        while same(P[(i1 + 1) % n] - P[i1]) and (i1 + 1) % n != k: i1 = (i1 + 1) % n
        a, b = P[i0], P[i1]
        t = (b - a) / np.hypot(*(b - a))
        nn = np.array([t[1], -t[0]])
        if in_ring((a + b) / 2 + nn * 0.5, np.array(P)):
            nn = -nn
        return a, b, t, nn

    @staticmethod
    def wall_scan(at, mid, t, nn, us, g, smax=4.0):
        """per u: first s (from smax toward the building) with the mesh > 5 m over the street g, None = open"""
        out = []
        for u in us:
            s_w = None
            for s in np.arange(smax, -3.01, -CELL):
                v = at(mid + nn * s + t * u)
                if np.isfinite(v) and v > g + 5.0:
                    s_w = float(s); break
            out.append(s_w)
        return out

    def road_cross(self, p, nn, smax=30.0):
        """first crossing of the ray p + s nn (s in (0, smax]) with a car road centre line -> (s, name)"""
        best = None
        for f in self.F:
            pr, g = f["properties"], f["geometry"]
            if g["type"] != "LineString" or pr.get("highway") not in self.CAR_ROADS or pr.get("tunnel") or pr.get("layer", "0").startswith("-"):
                continue
            L = np.array([self.en(c) for c in g["coordinates"]])
            for a, b in zip(L[:-1], L[1:]):
                d = b - a
                den = nn[0] * d[1] - nn[1] * d[0]
                if abs(den) < 1e-9:
                    continue
                w = a - p
                s = (w[0] * d[1] - w[1] * d[0]) / den
                u = (w[0] * nn[1] - w[1] * nn[0]) / den
                if 0 < s <= smax and 0 <= u <= 1 and (best is None or s < best[0]):
                    best = (float(s), pr.get("name"))
        return best

    @staticmethod
    def tags(p, keys=("name", "addr:street", "addr:housenumber", "addr:housename", "building", "building:levels", "amenity", "operator")):
        return {k: p[k] for k in keys if k in p} | {"osm": f"{p.get('@type', 'way')}/{p.get('@id')}"}

    # ------------------------------------------------------------ Berlinale: red carpet, ropes, barriers, banner
    def berlinale(self):
        C = BERLINALE
        cx, cz, h = C["car"]
        car, fw = np.array([cx, -cz]), np.array([math.sin(h), math.cos(h)])
        best = near = th = theatre_node = None
        for p, r in self.buildings(theatre=True):
            R = np.array([self.en(c) for c in r])
            if np.hypot(*(R.mean(0) - car)) > 400:
                continue
            for i in range(len(R) - 1):
                a, b = R[i], R[i + 1]; d = b - a
                den = fw[0] * d[1] - fw[1] * d[0]
                if abs(den) > 1e-9:
                    w = a - car
                    tt = (w[0] * d[1] - w[1] * d[0]) / den; uu = (w[0] * fw[1] - w[1] * fw[0]) / den
                    if 0 < tt <= C["ray"] and 0 <= uu <= 1 and (best is None or tt < best[0]):
                        best = (float(tt), p, R, i, car + fw * tt)
                q, _ = seg_near(car, a, b)
                dd = float(np.hypot(*(q - car)))
                if near is None or dd < near[0]:
                    near = (dd, p, R, i, q)
                if (p.get("amenity") == "theatre" or re.search(THEATRE, p.get("name", ""))) and dd <= C["near"] and (th is None or dd < th[0]):
                    th = (dd, p, R, i, q)
        if th is None:   # a theatre mapped as a node (name / alt_name like THEATRE) inside a building footprint
            for f in self.F:
                pr, g = f["properties"], f["geometry"]
                if g["type"] != "Point" or not (pr.get("amenity") == "theatre" and re.search(THEATRE, pr.get("name", "") + "|" + pr.get("alt_name", ""))):
                    continue
                e = self.en(g["coordinates"])
                if np.hypot(*(e - car)) > C["near"]:
                    continue
                hold = [(area(np.array(r)), p, r) for p, r in self.buildings() if in_ring(g["coordinates"], r)]
                if not hold:
                    continue
                _, p, r = min(hold, key=lambda x: x[0])
                R = np.array([self.en(c) for c in r])
                for i in range(len(R) - 1):
                    q, _ = seg_near(car, R[i], R[i + 1])
                    dd = float(np.hypot(*(q - car)))
                    if th is None or dd < th[0]:
                        th = (dd, p, R, i, q)
                theatre_node = pr
                print(f"    theatre node {pr['@id']} ({self.tags(pr, ('name', 'alt_name', 'amenity', 'addr:street', 'addr:housenumber'))}) "
                      f"{np.hypot(*(e - car)):.0f} m from the car, in the footprint {self.tags(p)}")
                break
        if th:
            how = "theatre within %.0f m (its footprint), the facade nearest the car" % C["near"]
        elif best:
            how = "no theatre within %.0f m; first footprint along the heading" % C["near"]
        else:
            how = "no theatre within %.0f m, the ray hits no footprint within %.0f m: nearest facade" % (C["near"], C["ray"])
        dist, props, R, i, hit = th or best or near
        best = th or best   # 'hit' wording below
        print(f"  berlinale: {how}: {dist:.1f} m from the car -> {self.tags(props)}")
        a, b, t, nn = self.run_at(R, i)
        # entrance node on that facade run
        ent = None
        for f in self.F:
            pr, g = f["properties"], f["geometry"]
            if g["type"] != "Point" or "entrance" not in pr:
                continue
            e = self.en(g["coordinates"])
            q, _ = seg_near(e, a, b)
            if np.hypot(*(q - e)) < 0.5:
                d_ = float(np.hypot(*(e - hit)))
                if d_ <= C["entrance_max"] and (ent is None or d_ < ent[0]):
                    ent = (d_, pr, e)
        door = ent[2] if ent else hit
        if ent:
            print(f"    entrance node {ent[1]['@id']} ({self.tags(ent[1], ('entrance', 'addr:street', 'addr:housenumber'))}) on that facade, "
                  f"{ent[0]:.1f} m from the {'hit' if best else 'foot'} point")
        else:
            print("    no entrance node on that facade within %.0f m: the carpet starts at the %s point" % (C["entrance_max"], "hit" if best else "foot"))
        # mesh window around the door (big enough for a canopy and the carpet beyond it)
        E0, N0 = math.floor(door[0] - 40), math.floor(door[1] - 40)
        T = self.top(E0, N0, int(80 / CELL), int(80 / CELL))
        H = self.lv.H
        Hg = self.lv.height.astype(np.float64)

        def grid(p):   # the level's height model (street level, also under roofs)
            return float(ndimage.map_coordinates(Hg, [[(p[1] - H["n0"]) / H["cell"]], [(p[0] - H["x0"]) / H["cell"]]], order=1, mode="nearest")[0])
        at = lambda p: T[int((p[1] - N0) / CELL), int((p[0] - E0) / CELL)]

        def ground(p):   # mesh where it is street level, else (under a roof / canopy) the height model
            v, gr = at(p), grid(p)
            return float(v) if np.isfinite(v) and v <= gr + 2.5 else gr
        hw = C["carpet"] / 2
        g = float(np.median([grid(door + nn * s + t * u) for s in (3.0, 5.0, 8.0) for u in (-2.0, 0.0, 2.0)]))
        wc = self.wall_scan(at, door, t, nn, np.arange(-hw, hw + 1e-6, CELL), g)
        covered = all(w is not None and w >= 3.99 for w in wc)       # mesh high right in front of the door: a roof over it
        s_wall = 0.3 if covered else max(w for w in wc if w is not None) + 0.15
        open_ = lambda p: np.isfinite(at(p)) and at(p) <= grid(p) + 2.5

        def edge_s(u):   # canopy: first s (from the wall) with 2 m of open ground after it
            run = 0
            for s in np.arange(s_wall, 45.0, CELL):
                run = run + 1 if open_(door + nn * s + t * u) else 0
                if run * CELL >= 2.0:
                    return float(s - 2.0 + CELL)
            return s_wall
        BW, BH = C["banner"]
        if covered:
            # the camera cannot see under the canopy: carpet only where the whole width is open (square end, no edge
            # cutting across it), banner on a truss over it where the whole banner is clear of the canopy
            s0 = max(edge_s(u) for u in np.arange(-hw, hw + 1e-6, 0.4)) + 0.3
            sb = max(edge_s(u) for u in np.arange(-BW / 2 - 0.3, BW / 2 + 0.31, 0.5)) + 0.6
            L = float(C["open_len"])
            rc = None
        else:
            s0 = s_wall
            rc = self.road_cross(door, nn)
            lo, hi = C["length"]
            L = float(min(hi, max(lo, (rc[0] - 1.0 - s0) if rc else 12.0)))
            wb = self.wall_scan(at, door, t, nn, np.arange(-BW / 2, BW / 2 + 1e-6, CELL), g)
            sb = max(w for w in wb if w is not None) + C["gap"] + BH / 2 * math.sin(math.radians(C["tilt"])) + 0.05
        # one straight height line for the whole carpet: least-squares fit to the open mesh ground under it
        # (no switching between mesh and height model, no per-metre kinks)
        S_, Y_ = [], []
        for s in np.arange(s0, s0 + L + 1e-6, 0.5):
            for u in np.arange(-hw, hw + 1e-6, 0.4):
                p = door + nn * s + t * u
                if open_(p):
                    S_.append(s - s0); Y_.append(float(at(p)))
        if len(S_) >= 8:
            Y_ = np.array(Y_); S_ = np.array(S_)
            keep = np.abs(Y_ - np.median(Y_)) < 0.6                 # bollards, people, bikes out
            b1, b0 = np.polyfit(S_[keep], Y_[keep], 1)
            b1 = float(np.clip(b1, -0.08, 0.08))
            res = Y_[keep] - (b0 + b1 * S_[keep])
            b0 += max(0.0, float(np.percentile(res, 97)))           # above the ground nearly everywhere (no ground poking through)
        else:
            b0, b1 = grid(door + nn * (s0 + L / 2)) - 0, 0.0
        yline = lambda s: float(b0 + b1 * (s - s0))
        prof = [round(yline(s0 + min(k, L)), 3) for k in range(int(math.ceil(L)) + 1)]
        bp = door + nn * sb
        hd = math.atan2(nn[0], nn[1])
        cs = door + nn * s0
        gb = yline(sb) if s0 <= sb <= s0 + L else grid(bp)
        print(f"    street {g:.2f} m (height model); " + ("door under a canopy: carpet from its edge, %.1f m out" % (s0,) if covered
              else f"wall at the door {s_wall - 0.15:.2f} m out from the OSM line") + f"; carpet {L:.1f} m"
              + ("" if covered else f" (road centre line {'%.1f m out (%s)' % rc if rc else 'not found'})")
              + f", straight line {prof[0]:.2f} -> {prof[-1]:.2f} m ({len(S_)} samples); banner {sb - s0:+.1f} m along it, bottom {C['bottom']} m up")
        lat, lon = self.lv_latlon(door)
        rec = {"x": round(float(door[0]), 2), "z": round(float(-door[1]), 2), "street": round(g, 2), "heading": round(hd, 4),
               "deg": round(math.degrees(hd) % 360, 1), "lat": lat, "lon": lon,
               "building": self.tags(props),
               **({"theatre": self.tags(theatre_node, ("name", "alt_name", "amenity", "addr:street", "addr:housenumber"))} if theatre_node else {}),
               **({"entrance": self.tags(ent[1], ("entrance", "addr:street", "addr:housenumber"))} if ent else {}),
               "found": how, **({"canopy": True} if covered else {}),
               "carpet": {"x": round(float(cs[0]), 2), "z": round(float(-cs[1]), 2), "width": C["carpet"], "length": round(L, 2),
                          "step": 1.0, "y": prof},
               "banner": {"x": round(float(bp[0]), 2), "z": round(float(-bp[1]), 2), "ground": round(gb, 2),
                          "y": round(gb + C["bottom"] + BH / 2, 2), "heading": round(hd, 4), "width": BW, "height": BH,
                          "tilt": C["tilt"], "text": "Berlinale!", "truss": bool(covered)},
               "bear": {"side": 1, "height": 2.0},
               "source": f"owner's car pose {C['car']}; {how}; OSM footprint + entrance node, L1 mesh wall / canopy line; "
                         f"carpet height = one straight line fitted to the open mesh ground"}
        # view: beyond the carpet's end, turned toward the door (carpet and banner ahead)
        rec["view"] = self.view(cs, nn, L + C["view_beyond"], facing=True)
        return rec

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--level", default="mitte_all")
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    a = ap.parse_args()
    sys.path.insert(0, REPO)
    L = json.load(open(os.path.join(HERE, "levels", a.level, "level.json")))
    with tempfile.TemporaryDirectory() as td:
        feats = load_osm(need_pbf(a.pbf), SIGHTS_BBOXES, td)
    S = Sights(a.level, a.mesh_src, feats)
    del feats
    out = {"level": a.level, "frame": "level x = east, z = -north, y = mesh height (m); heading clockwise from north (rad), "
                                       "the direction the clock faces / the storks look",
           "note": "built by build_sights.py; decorations without colliders (js/sights.js)",
           "clock": S.clock(), "nest": S.nest(), "berlinale": S.berlinale()}
    path = os.path.join(HERE, "levels", a.level, "sights.json")
    json.dump(out, open(path, "w"), ensure_ascii=False, indent=1)
    for k in ("clock", "nest", "berlinale"):
        r = out[k]
        print(f"  {k}: ({r['x']}, {r['z']}) y {r.get('y', r.get('street'))} m, facing {r['deg']} deg; view start {r['view']}")
    print(f"-> {path}")


if __name__ == "__main__":
    main()

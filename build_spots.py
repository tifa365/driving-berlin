#!/usr/bin/env python3
"""Easter-egg spots with their own URL -> levels/<name>/spots.json (index.html ?spot=<slug>, map.html).

  python3 build_spots.py [--level mitte_all] [--only SLUG ...] [--dry-run]

Every spot has a start pose (x, z, heading; heading clockwise from north like the car,
forward = (sin h, -cos h)) a short drive before it, facing it. Poses come from this file,
never from guesses in the browser:
  known  the owner's / an earlier session's tested start (S-Bahn, pits, tunnels)
  auto   chosen here: candidates every 2 m along OSM highway centre lines (osm_map.json) near
         the spot, ranked by driving distance to the spot (close to `pref`), straightness
         (driving distance / straight distance) and road class; heading = toward the farthest
         point of the driving path that is in straight sight of the start.
Every pose (known or auto) is checked against the level data on a 0.5 m raster around the spot:
  car box (4.5 x 1.81 m, js/vehicle.js) clear of:  building walls (walls.bin segments, >= 1.3 m
  from the centre line, i.e. 1 m beside the 0.6 m box) and footprints (rings minus carved
  passages, >= 1 m; walls.js inside() would move a car there), clutter obstacle outlines (>= 3 m: clutter.bin is rebuilt tonight, outlines move)
  and trunks (>= 2 m), water (>= 2 m; drivable bridge decks are dry), pits (>= 3 m), the
  no-drive zones (>= 3 m), bridge rails / goal frames (>= 1.3 m), the level border (>= 20 m);
  reachable: in the car's free space (the colliders above grown by 1.3 m, clutter by 1.5 m) the start
  is connected to the spot AND to the edge of the 400 m window (not a closed pocket).
Clutter outlines are loaded as they are on disk now; the margin covers small changes.
Ride height (2026-11-21, ride_check / RIDE_*): the L1 mesh top over the car box (+0.5 m) must be street
level: within the js/ground.js acquire band of the height grid, and nothing over the car (viaduct and
station decks, canopies, crowns). Needs the mesh in ../berlin_mesh_2025_wab (MESH_SRC).

Output per spot: slug, name, kind, ref, target {x, z, lat, lon}, start {x, z, heading, deg, lat,
lon}, how (known | auto), check {clear: m per category, drive: driving distance m, straight: m, ok}.
Local data only (no network). Exit 1 when a spot fails its check.
"""
import argparse, json, math, os, re, sys
from collections import deque
import numpy as np
from scipy import ndimage
from matplotlib.path import Path

HERE = os.path.dirname(os.path.abspath(__file__))

CAR_HL, CAR_HW = 4.495 / 2, 1.81 / 2     # js/vehicle.js car body
CELL = 0.5                               # m raster
WIN = 200.0                              # m half window around a spot
# start-pose clearance (m from the car box) per category
MARGIN = {"wall": 1.3, "building": 1.0, "clutter": 3.0, "trunk": 2.0, "water": 2.0, "pit": 3.0, "nodrive": 3.0, "rail": 1.3, "border": 20.0}
# free space for the drive: distance from the obstacle the car centre needs (half width + a bit);
# footprint interiors are not in it: where OSM has a footprint but walls.bin no wall (raised parts,
# colonnades, carved passages) the car drives through, as in the game
FREE = {"wall": 1.3, "clutter": 1.5, "trunk": 1.3, "water": 1.2, "pit": 1.2, "nodrive": 1.5, "rail": 1.3}
CAR_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
             "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link",
             "tertiary_link", "road", "pedestrian"}
NO_ROADS = {"steps", "corridor", "elevator", "proposed", "construction", "platform", "bus_stop"}

# ---------------------------------------------------------------- the spots
# kind, slug, name, target, options. target: ("egg", id) | ("ll", lat, lon) | ("nodrive",) |
# ("sbahn", entrance id in sbahn.json) | ("pit", [index...]) | ("portal", id) | ("bridge", name) |
# ("roof", route id in roofs_deck.json: the start is ON the roof, checked against the deck, not the street) |
# ("doorway", id in doorway.json: the figure of js/doorway.js)
# options: start=(x, z, h) known pose; pref = wanted driving distance m (auto); reach = m around the
# target that count as "there"; side = (ux, uz): auto candidates only on that side of the target
SPOTS = [
    ("football", "fussball-stallschreiberstrasse", "Bolzplatz Stallschreiberstraße", ("egg", "mitte_all.pitch.1"), {}),
    ("football", "fussball-kleine-hamburger", "Bolzplatz an der Kleinen Hamburger Straße", ("egg", "mitte_all.pitch.2"), {}),
    ("football", "fussball-holzmarktstrasse", "Bolzplatz an der Holzmarktstraße", ("egg", "mitte_all.pitch.3"), {}),
    ("football", "fussball-reichstag", "Wiese vor dem Reichstag", ("egg", "mitte_all.pitch.4"), {}),
    ("bear", "baer-republika", "Republika am Platz der Republik", ("egg", "mitte_all.bear.01"), {}),
    ("bear", "baer-paula", "Paula am Pariser Platz", ("egg", "mitte_all.bear.02"), {}),
    ("bear", "baer-gustav", "Gustav am Gendarmenmarkt", ("egg", "mitte_all.bear.03"), {}),
    ("bear", "baer-luise", "Luise im Lustgarten", ("egg", "mitte_all.bear.04"), {}),
    ("bear", "baer-ursula", "Ursula an der Weltzeituhr", ("egg", "mitte_all.bear.05"), {}),
    ("bear", "baer-hacki", "Hacki am Hackeschen Markt", ("egg", "mitte_all.bear.06"), {}),
    ("bear", "baer-leo", "Leo am Leipziger Platz", ("egg", "mitte_all.bear.07"), {}),
    ("bear", "baer-niko", "Niko im Nikolaiviertel", ("egg", "mitte_all.bear.08"), {}),
    ("bear", "baer-mona", "Mona im Monbijoupark", ("egg", "mitte_all.bear.09"), {}),
    ("bear", "baer-hugo", "Hugo am Hauptbahnhof", ("egg", "mitte_all.bear.10"), {}),
    ("bear", "baer-maxi", "Maxi im Köllnischen Park", ("egg", "mitte_all.bear.11"), {}),
    ("bear", "baer-wilma", "Wilma im Weinbergspark", ("egg", "mitte_all.bear.12"), {}),
    ("bear", "baer-hilde", "Hilde im Hinterhof", ("egg", "mitte_all.bear.13"), {}),
    ("bear", "baer-fritzi", "Fritzi am Kronprinzenpalais", ("egg", "mitte_all.bear.14"), {}),
    ("bear", "baer-jana", "Jana an der Jannowitzbrücke", ("egg", "mitte_all.bear.15"), {}),
    ("bear", "baer-philippa", "Philippa am Campus Nord", ("egg", "mitte_all.bear.16"), {}),
    ("bear", "baer-lola", "Lola in der Albrechtstraße", ("egg", "mitte_all.bear.18"), {}),
    # Maura sits in the block interior behind the building passage off Mauerstrasse (green hint frame, doorway.json):
    # start on Mauerstrasse 8 m before the passage mouth, facing into it (231 deg)
    ("bear", "baer-maura", "Maura an der Mauerstraße", ("egg", "mitte_all.bear.19"), {"start": (-552.4, 1480.0, -2.134)}),
    # Checkpoint Charlie photo group (doorway.json photo-group) in front of the guard hut: start on Friedrichstrasse north of it, facing south
    ("photo", "checkpoint", "Checkpoint Charlie: Fotos am Wachhaus", ("doorway", "mitte_all.photo.1"), {"reach": 3.0, "pref": 35, "side": (0.0, -1.0)}),
    # roof bear (eggs.json roof): the link starts the car on the Lueders-Haus hall roof 32 m west of her, facing her
    ("bear", "baer-lotte", "Lotte auf dem Lüders-Haus", ("roof", "bundestag", "mitte_all.bear.17"), {"start": (-1250.0, 261.0, math.pi / 2)}),
    # doorway figure (doorway.json, build_eggs.DOORWAYS) at the red house on the east side of the garden of
    # Albrechtstrasse 14: start west of it on Albrechtstrasse, driving east into the garden, so figure, fountain and
    # Lola the bear are all ahead
    ("doorway", "lola", "Garten in der Albrechtstraße (Hauseingang, Brunnen)", ("doorway", "mitte_all.doorway.1"), {"reach": 3.0, "pref": 40, "side": (-1.0, 0.0)}),
    ("balloon", "weltballon", "Weltballon (E: mitfahren)", ("ll", 52.507932, 13.386118), {"reach": 13.0, "pref": 45}),
    # sights.json (build_sights.py): target = the object. Clock: start 14 m out from the panel, 3 m east of its axis
    # (straight out lies under a tree crown, beyond 16 m the S-Bahn viaduct), turned toward it; nest: its `view`,
    # on Charitéstraße with the nest 2 m ahead, 16 m to the left and 22 m up
    ("sight", "schuldenuhr", "Schuldenuhr (Reinhardtstraße 52)", ("ll", 52.5223814, 13.3776981), {"start": (-1269.9, 26.1, -0.47), "reach": 4.0}),
    ("sight", "nabu", "Storchennest auf dem NABU-Haus (Charitéstraße 3)", ("ll", 52.5228817, 13.3786086), {"start": (-1200.4, -49.7, -0.596), "reach": 17.0}),
    # Berlinale carpet at the Theater am Potsdamer Platz (sights.json `berlinale`, the owner's car pose on Marlene-Dietrich-Platz):
    # start = its `view`, 2 m beyond the carpet's end on the open square, facing the door (banner on its truss ahead)
    ("sight", "berlinale", "Berlinale: roter Teppich am Theater am Potsdamer Platz", ("ll", 52.5073203, 13.3720913), {"start": (-1630.4, 1662.2, -2.352), "reach": 4.0}),
    ("nodrive", "mahnmal", "Denkmal für die ermordeten Juden Europas (nicht befahrbar)", ("nodrive",), {"pref": 35}),
    # station doors (sbahn.json `entrances`, sides chosen by build_sbahn.door_sides): the start is the door's
    # `approach` (head of its clear straight corridor); "corridor": the straight drive start -> door zone
    # must be free of walls / clutter / trunks by car half width + 1 m either side
    ("sbahn", "sbahn", "S-Bahn: Tür an der Jannowitzbrücke", ("sbahn", "sbahn-jannowitzbruecke"), {"reach": 3.0, "approach": True, "corridor": True}),
    ("sbahn", "sbahn-alexanderplatz", "S-Bahn: Tür am Alexanderplatz", ("sbahn", "sbahn-alexanderplatz"), {"reach": 3.0, "approach": True, "corridor": True}),
    ("sbahn", "sbahn-hackescher-markt", "S-Bahn: Tür am Hackeschen Markt", ("sbahn", "sbahn-hackescher-markt"), {"reach": 3.0, "approach": True, "corridor": True}),
    ("sbahn", "sbahn-friedrichstrasse", "S-Bahn: Tür an der Friedrichstraße", ("sbahn", "sbahn-friedrichstrasse"), {"reach": 3.0, "approach": True, "corridor": True}),
    # Hauptbahnhof: the door's own approach head lies under a structure 26 m up (ride check); start in the open on Washingtonplatz instead
    ("sbahn", "sbahn-hauptbahnhof", "S-Bahn: Tür am Hauptbahnhof", ("sbahn", "sbahn-hauptbahnhof"), {"reach": 3.0, "start": (-1832.5, -176.2, 0.766), "corridor": True}),
    # sbahn.json `portal` (build_sbahn.PORTAL): the garage ramp on Am Friedrichshain -> cut to the Friedrichstrasse hall; start where the driveway leaves the street, 21 m straight to the entrance node
    ("sbahn", "tiefgarage", "Tiefgarage Am Friedrichshain", ("ll", 52.5286101, 13.4271242), {"start": (2085.0, -660.0, -0.316), "reach": 4.0}),
    ("pit", "baugrube-wilhelmstrasse", "Baugrube Wilhelmstraße", ("pit", [0, 1]), {"start": (-1015.0, 857.0, math.pi / 2)}),
    ("pit", "baugrube-elisabeth-selbert-haus", "Baugrube Elisabeth-Selbert-Haus (Ostseite offen)", ("pit", [2]), {"pref": 35, "side": (1.0, 0.0)}),
    ("tunnel", "tunnel-tiergarten-nord", "Tunnel Tiergarten Spreebogen, Nordeinfahrt (Minna-Cauer-Straße)", ("portal", "t3-in-0"), {"start": (-1956.0, -571.0, -3.02), "reach": 4.0}),
    ("tunnel", "tunnel-tiergarten-sued", "Tunnel Tiergarten Spreebogen, Südeinfahrt (Schöneberger Ufer)", ("portal", "t2-in-0"), {"start": (-1667.0, 1947.0, 0.66), "reach": 4.0}),
    ("tunnel", "tunnel-alexanderplatz", "Tunnel Alexanderplatz (Grunerstraße)", ("portal", "t1-in-0"), {"start": (1134.0, 323.0, 0.94), "reach": 4.0}),
    ("bridge", "heinemann-bruecke", "Gustav-Heinemann-Brücke (befahrbare Fußgängerbrücke)", ("bridge", "Gustav-Heinemann-Brücke"), {"pref": 75, "reach": 3.0}),
    ("roof", "bundestag-dach", "Bundestag-Dach: Paul-Löbe-Haus → Spree-Skywalk → Marie-Elisabeth-Lüders-Haus", ("roof", "bundestag"), {}),
]
DEFAULT = {"football": {"pref": 60, "reach": 3.0}, "bear": {"pref": 35, "reach": 2.0}}


# ---------------------------------------------------------------- level data
class Level:
    def __init__(self, name):
        self.name, self.dir = name, os.path.join(HERE, "levels", name)
        d = self.dir
        L = self.L = json.load(open(os.path.join(d, "level.json")))
        self.ex = L["extent"]
        lat0, lon0 = L["origin"]["lat"], L["origin"]["lon"]
        A, F = 6378137.0, 1 / 298.257223563
        E2 = F * (2 - F)

        def ecef(lat, lon):
            la, lo = math.radians(lat), math.radians(lon)
            N = A / math.sqrt(1 - E2 * math.sin(la) ** 2)
            return np.array([N * math.cos(la) * math.cos(lo), N * math.cos(la) * math.sin(lo), N * (1 - E2) * math.sin(la)])
        o = ecef(lat0, lon0)
        sa, ca, so, co = math.sin(math.radians(lat0)), math.cos(math.radians(lat0)), math.sin(math.radians(lon0)), math.cos(math.radians(lon0))

        def xz(lat, lon):   # build_stream.py / js/nodrive.js frame
            p = ecef(lat, lon) - o
            e = -so * p[0] + co * p[1]
            n = -sa * co * p[0] - sa * so * p[1] + ca * p[2]
            return float(e), float(-n)
        kx, kz = 111320 * ca, 111132.0

        def latlon(x, z):
            lat, lon = lat0 - z / kz, lon0 + x / kx
            for _ in range(4):
                e, zz = xz(lat, lon)
                lon += (x - e) / kx; lat -= (z - zz) / kz
            return lat, lon
        self.xz, self.latlon = xz, latlon
        W = self.W = L["water"]
        self.water = np.fromfile(os.path.join(d, W["file"]), np.uint8).reshape(W["nz"], W["nx"])
        # walls.bin: segments, rings (outer / courtyard), carved corridors
        wj = json.load(open(os.path.join(d, "walls.json")))
        raw = open(os.path.join(d, wj["file"]), "rb").read()
        sc = wj["scale"]
        s = wj["segments"]
        self.segs = np.frombuffer(raw, "<i2", s["count"] * 4, s["offset"]).reshape(-1, 4).astype(float) * sc
        rl = np.frombuffer(raw, "<i4", wj["ringLen"]["count"], wj["ringLen"]["offset"])
        rp = np.frombuffer(raw, "<i2", wj["rings"]["count"] * 2, wj["rings"]["offset"]).reshape(-1, 2).astype(float) * sc
        self.rings, o_ = [], 0
        for n in rl:
            m = abs(int(n)); p = rp[o_:o_ + m]; o_ += m
            self.rings.append((p, n < 0, p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()))
        c = wj["corridors"]
        self.cors = np.frombuffer(raw, "<i2", c["count"] * 5, c["offset"]).reshape(-1, 5).astype(float) * sc
        # bridges: drivable decks are dry (and their wall segments are dropped, as js/walls.js)
        bj = json.load(open(os.path.join(d, "bridges.json")))
        self.bridges = bj["bridges"]
        self.decks = [np.array(b["poly"], float) for b in bj["bridges"] if b.get("drivable") and b.get("poly")]
        self.rails = [r for b in bj["bridges"] if b.get("drivable") for r in b.get("rails") or []]
        if self.decks:
            mid = (self.segs[:, :2] + self.segs[:, 2:]) / 2
            on = np.zeros(len(mid), bool)
            for P in self.decks:
                on |= Path(P).contains_points(mid)
            self.segs = self.segs[~on]
        # clutter (as on disk now)
        cj = json.load(open(os.path.join(d, "clutter.json")))
        raw = open(os.path.join(d, cj["file"]), "rb").read()

        def sec(nm):
            q = cj["sections"][nm]
            return np.frombuffer(raw, "<f4", q["count"] * q["stride"], q["offset"]).reshape(q["count"], q["stride"])
        ob, pts = sec("obst"), sec("pts")
        self.trees = sec("trees")[:, :3].astype(float)
        self.obst = [pts[int(p0):int(p0 + pn)].astype(float) for p0, pn, _, _ in ob]
        self.obox = np.array([[p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()] for p in self.obst]).reshape(-1, 4)
        # pits
        self.pits = [np.array(p["p"], float) for p in (L.get("pit") or {}).get("pits", [])]
        self.pit_meta = (L.get("pit") or {}).get("pits", [])
        # no-drive zones: rings from js/nodrive.js
        js = open(os.path.join(HERE, "js", "nodrive.js")).read()
        self.nodrive = []
        for m in re.finditer(r"name:\s*'([^']+)'.*?ring:\s*\[(.*?)\],\s*\n\s*\}", js, re.S):
            ll = [(float(a), float(b)) for a, b in re.findall(r"\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]", m.group(2))]
            self.nodrive.append((m.group(1), np.array([self.xz(lat, lon) for lon, lat in ll])))
        self.eggs = {it["id"]: it for it in json.load(open(os.path.join(d, "eggs.json")))["items"]}
        sb = json.load(open(os.path.join(d, "sbahn.json")))   # one `entrance` today; a list `entrances` later
        self.sbahn = {e["id"]: e for e in ([sb["entrance"]] if sb.get("entrance") else []) + (sb.get("entrances") or [])}
        tj = json.load(open(os.path.join(d, "tunnels.json")))
        self.portals = {p["id"]: p for T in tj["tubes"] for p in T["portals"]}
        # goal frames (static bodies in js/eggs.js): the net box behind each goal line
        self.goals = []
        for it in self.eggs.values():
            if it["kind"] == "goal":
                h, w, dpt = it["heading"], it["width"], it["depth"]
                fx, fz, lx, lz = math.sin(h), -math.cos(h), math.cos(h), math.sin(h)
                x, z = it["x"], it["z"]
                self.goals.append(np.array([[x + a * fx + b * lx, z + a * fz + b * lz]
                                            for a, b in ((0, -w / 2), (dpt, -w / 2), (dpt, w / 2), (0, w / 2))]))
        self.roads = None

    def load_roads(self):
        if self.roads is not None:
            return self.roads
        out = []
        for el in json.load(open(os.path.join(self.dir, "osm_map.json")))["elements"]:
            t, g = el.get("tags", {}), el.get("geometry")
            hw = t.get("highway")
            if not hw or not g or hw in NO_ROADS or t.get("area") == "yes":
                continue
            if t.get("tunnel", "no") not in ("no", "building_passage") or t.get("bridge", "no") != "no":
                continue
            if t.get("layer", "0").startswith("-"):
                continue
            xz = np.array([self.xz(p["lat"], p["lon"]) for p in g])
            out.append((hw, t.get("name", ""), xz))
        self.roads = out
        return out


# ---------------------------------------------------------------- raster around a spot
class Window:
    def __init__(self, lv, cx, cz, half=WIN):
        self.lv, self.x0, self.z0 = lv, cx - half, cz - half
        self.n = n = int(2 * half / CELL)
        xs = self.x0 + (np.arange(n) + 0.5) * CELL
        zs = self.z0 + (np.arange(n) + 0.5) * CELL
        self.X, self.Z = np.meshgrid(xs, zs)          # [j (z), i (x)]
        self.P = np.c_[self.X.ravel(), self.Z.ravel()]
        x1, z1 = self.x0 + 2 * half, self.z0 + 2 * half
        self.box = (self.x0, self.z0, x1, z1)
        self.cat = {}
        # walls: segment lines + footprint interiors
        wall = np.zeros((n, n), bool)
        S = lv.segs
        near = (np.minimum(S[:, 0], S[:, 2]) < x1) & (np.maximum(S[:, 0], S[:, 2]) > self.x0) & \
               (np.minimum(S[:, 1], S[:, 3]) < z1) & (np.maximum(S[:, 1], S[:, 3]) > self.z0)
        self._lines(wall, S[near])
        cnt = np.zeros(n * n, np.int16)
        for p, hole, a0, b0, a1, b1 in lv.rings:
            if a1 < self.x0 or a0 > x1 or b1 < self.z0 or b0 > z1:
                continue
            idx = self._bbox_idx(a0, b0, a1, b1)
            ins = Path(p).contains_points(self.P[idx])
            cnt[idx[ins]] += -1 if hole else 1
        inside = cnt > 0
        C = lv.cors
        for x0_, z0_, x1_, z1_, r in C:   # carved passages: never inside
            if max(x0_, x1_) + r < self.x0 or min(x0_, x1_) - r > x1 or max(z0_, z1_) + r < self.z0 or min(z0_, z1_) - r > z1:
                continue
            idx = self._bbox_idx((min(x0_, x1_) - r, min(z0_, z1_) - r, max(x0_, x1_) + r, max(z0_, z1_) + r))
            q = self.P[idx]
            dx, dz = x1_ - x0_, z1_ - z0_
            L2 = dx * dx + dz * dz
            u = np.clip(((q[:, 0] - x0_) * dx + (q[:, 1] - z0_) * dz) / L2 if L2 > 1e-9 else 0 * q[:, 0], 0, 1)
            d = np.hypot(x0_ + u * dx - q[:, 0], z0_ + u * dz - q[:, 1])
            inside[idx[d < r]] = False
        self.cat["wall"] = wall                                # Box2D wall boxes: what stops the car
        self.cat["building"] = inside.reshape(n, n) & ~wall    # footprint interior (walls.js inside()): no start there
        # clutter outlines (filled) + trunks
        cl = np.zeros((n, n), bool)
        B = lv.obox
        sel = np.flatnonzero((B[:, 2] > self.x0) & (B[:, 0] < x1) & (B[:, 3] > self.z0) & (B[:, 1] < z1))
        for k in sel:
            p = lv.obst[k]
            self._lines(cl, np.c_[p[:-1], p[1:]])
            if len(p) >= 4:
                idx = self._bbox_idx(*B[k])
                cl.ravel()[idx[Path(p).contains_points(self.P[idx])]] = True
        self.cat["clutter"] = cl
        tr = np.zeros((n, n), bool)
        T = lv.trees
        for x, z, r in T[(T[:, 0] > self.x0 - 2) & (T[:, 0] < x1 + 2) & (T[:, 1] > self.z0 - 2) & (T[:, 1] < z1 + 2)]:
            idx = self._bbox_idx((x - r - CELL, z - r - CELL, x + r + CELL, z + r + CELL))
            tr.ravel()[idx[np.hypot(self.P[idx, 0] - x, self.P[idx, 1] - z) <= r + CELL / 2]] = True
        self.cat["trunk"] = tr
        # water minus drivable decks
        W = lv.W
        i = np.floor((self.X - W["x0"]) / W["cell"]).astype(int)
        j = np.floor((-self.Z - W["n0"]) / W["cell"]).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < W["nx"]) & (j < W["nz"])
        wat = np.zeros((n, n), bool)
        wat[ok] = lv.water[j[ok], i[ok]] == 1
        for P in lv.decks:
            a0, b0 = P.min(0); a1, b1 = P.max(0)
            if a1 < self.x0 or a0 > x1 or b1 < self.z0 or b0 > z1:
                continue
            idx = self._bbox_idx((a0, b0, a1, b1))
            wat.ravel()[idx[Path(P).contains_points(self.P[idx])]] = False
        self.cat["water"] = wat
        self.cat["pit"] = self._polys(lv.pits)
        self.cat["nodrive"] = self._polys([p for _, p in lv.nodrive])
        rail = np.zeros((n, n), bool)
        if lv.rails:
            self._lines(rail, np.array(lv.rails, float))
        rail |= self._polys(lv.goals)
        for G in lv.goals:
            self._lines(rail, np.c_[G, np.roll(G, -1, 0)][:3])
        self.cat["rail"] = rail
        e = lv.ex
        self.border = np.minimum.reduce([self.X - e["minX"], e["maxX"] - self.X, self.Z - e["minZ"], e["maxZ"] - self.Z])
        self.edt = {k: ndimage.distance_transform_edt(~v) * CELL for k, v in self.cat.items()}

    def _bbox_idx(self, *b):
        a0, b0, a1, b1 = b[0] if len(b) == 1 else b
        i0, i1 = int(max(0, (a0 - self.x0) // CELL)), int(min(self.n, (a1 - self.x0) // CELL + 2))
        j0, j1 = int(max(0, (b0 - self.z0) // CELL)), int(min(self.n, (b1 - self.z0) // CELL + 2))
        if i1 <= i0 or j1 <= j0:
            return np.zeros(0, np.int64)
        J, I = np.mgrid[j0:j1, i0:i1]
        return (J * self.n + I).ravel()

    def _polys(self, polys):
        g = np.zeros((self.n, self.n), bool)
        for P in polys:
            a0, b0 = P.min(0); a1, b1 = P.max(0)
            if a1 < self.x0 or a0 > self.box[2] or b1 < self.z0 or b0 > self.box[3]:
                continue
            idx = self._bbox_idx((a0, b0, a1, b1))
            g.ravel()[idx[Path(P).contains_points(self.P[idx])]] = True
        return g

    def _lines(self, g, S):
        for x0, z0, x1, z1 in S:
            L = math.hypot(x1 - x0, z1 - z0)
            k = max(2, int(L / (CELL / 2)) + 2)
            t = np.linspace(0, 1, k)
            i = ((x0 + (x1 - x0) * t - self.x0) // CELL).astype(int)
            j = ((z0 + (z1 - z0) * t - self.z0) // CELL).astype(int)
            ok = (i >= 0) & (j >= 0) & (i < self.n) & (j < self.n)
            g[j[ok], i[ok]] = True

    def ij(self, x, z):
        return int((z - self.z0) // CELL), int((x - self.x0) // CELL)

    def sample(self, grid, xs, zs):
        j = np.clip(((np.asarray(zs) - self.z0) // CELL).astype(int), 0, self.n - 1)
        i = np.clip(((np.asarray(xs) - self.x0) // CELL).astype(int), 0, self.n - 1)
        return grid[j, i]

    def free(self, ignore=()):
        f = np.ones((self.n, self.n), bool)
        for k, d in FREE.items():
            if k not in ignore:
                f &= self.edt[k] > d
        return f & (self.border > 5)


def car_points(x, z, h, step=0.5):
    fx, fz, lx, lz = math.sin(h), -math.cos(h), math.cos(h), math.sin(h)
    us = np.linspace(-CAR_HL, CAR_HL, int(2 * CAR_HL / step) + 2)
    vs = np.linspace(-CAR_HW, CAR_HW, int(2 * CAR_HW / step) + 2)
    U, V = np.meshgrid(us, vs)
    return x + U.ravel() * fx + V.ravel() * lx, z + U.ravel() * fz + V.ravel() * lz


def clearance(w, x, z, h):
    xs, zs = car_points(x, z, h)
    out = {k: float(w.sample(w.edt[k], xs, zs).min()) for k in w.edt}
    out["border"] = float(w.sample(w.border, xs, zs).min())
    return out


def bfs(free, seeds):
    """8-connected wavefront distance in cells from the seed cells over `free` (-1 = unreached)"""
    n = free.shape[0]
    dist = np.full(free.shape, -1, np.int32)
    cur = seeds & free
    if not cur.any():   # the target itself sits in an obstacle (bear at a wall): seed its free ring
        cur = ndimage.binary_dilation(seeds, iterations=6) & free
    dist[cur] = 0
    fl = free.ravel()
    D = dist.ravel()
    front = np.flatnonzero(cur.ravel())
    offs = np.array([dj * n + di for dj in (-1, 0, 1) for di in (-1, 0, 1) if dj or di])
    col = np.array([di for dj in (-1, 0, 1) for di in (-1, 0, 1) if dj or di])
    d = 0
    while front.size:
        d += 1
        nb = (front[:, None] + offs[None, :])
        c = (front % n)[:, None] + col[None, :]
        ok = (nb >= 0) & (nb < n * n) & (c >= 0) & (c < n)   # no wrap across rows
        nb = np.unique(nb[ok])
        nb = nb[fl[nb] & (D[nb] < 0)]
        D[nb] = d
        front = nb
    return dist


def visible(free, a, b):
    (j0, i0), (j1, i1) = a, b
    k = max(abs(j1 - j0), abs(i1 - i0)) + 1
    js = np.round(np.linspace(j0, j1, k)).astype(int)
    is_ = np.round(np.linspace(i0, i1, k)).astype(int)
    return bool(free[js, is_].all())


def path_heading(w, free, dist, x, z):
    """follow the descending wavefront from the start; heading toward the farthest path point in sight"""
    j, i = w.ij(x, z)
    if dist[j, i] < 0:
        return None, None
    path = [(j, i)]
    while dist[j, i] > 0 and len(path) < 400:
        best = None
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                jj, ii = j + dj, i + di
                if 0 <= jj < w.n and 0 <= ii < w.n and 0 <= dist[jj, ii] < dist[j, i]:
                    c = (dist[jj, ii], abs(dj) + abs(di))
                    if best is None or c < best[0]:
                        best = (c, (jj, ii))
        if best is None:
            break
        j, i = best[1]; path.append((j, i))
    far = path[min(len(path) - 1, 4)]
    for p in path[1::3]:
        if math.hypot(p[0] - path[0][0], p[1] - path[0][1]) * CELL > 80:
            break
        if visible(free, path[0], p):
            far = p
    px, pz = w.x0 + (far[1] + 0.5) * CELL, w.z0 + (far[0] + 0.5) * CELL
    length = 0.0
    for a, b in zip(path, path[1:]):
        length += math.hypot(a[0] - b[0], a[1] - b[1]) * CELL
    return math.atan2(px - x, -(pz - z)), length


# ---------------------------------------------------------------- per spot
def target_of(lv, tgt):
    """-> (x, z, ref, seed polygon or None, ignore categories for the drive)"""
    k = tgt[0]
    if k == "egg":
        it = lv.eggs[tgt[1]]
        return it["x"], it["z"], it["id"], None, ()
    if k == "ll":
        x, z = lv.xz(tgt[1], tgt[2]); return x, z, None, None, ()
    if k == "nodrive":
        name, P = lv.nodrive[0]
        return float(P[:, 0].mean()), float(P[:, 1].mean()), "nodrive:" + name, P, ("nodrive",)
    if k == "doorway":
        it = next(i for i in json.load(open(os.path.join(lv.dir, "doorway.json")))["items"] if i["id"] == tgt[1])
        return it["x"], it["z"], it["id"], None, ()
    if k == "sbahn":
        E = lv.sbahn[tgt[1]]; return E["door"][0], E["door"][1], E["id"], None, ()
    if k == "pit":
        P = [lv.pits[i] for i in tgt[1]]
        allp = np.vstack(P)
        return float(allp[:, 0].mean()), float(allp[:, 1].mean()), "pit:" + ",".join(map(str, tgt[1])), P, ("pit",)
    if k == "portal":
        p = lv.portals[tgt[1]]; return p["x"], p["z"], "tunnel:" + p["id"], None, ()
    if k == "bridge":
        b = next(b for b in lv.bridges if b["name"] == tgt[1])
        ln = np.array(b["line"])[:, :2]
        m = ln[len(ln) // 2]
        return float(m[0]), float(m[1]), "bridge:" + tgt[1], None, ()
    raise ValueError(k)


def seeds_for(w, x, z, poly, reach):
    if poly is not None:
        polys = poly if isinstance(poly, list) else [poly]
        g = w._polys(polys)
        return ndimage.binary_dilation(g, iterations=int(round(2.5 / CELL))) & ~g | g
    d = np.hypot(w.X - x, w.Z - z)
    return d <= max(reach, CELL)


def check_pose(w, free, dist, x, z, h):
    cl = clearance(w, x, z, h)
    probs = [f"{k} {cl[k]:.1f} m < {m}" for k, m in MARGIN.items() if cl[k] < m]
    j, i = w.ij(x, z)
    reached = dist[j, i] >= 0
    if not reached:
        probs.append("spot not reachable from the start")
    lab, _ = ndimage.label(free)
    L0 = lab[j, i]
    edge = L0 > 0 and (np.any(lab[0] == L0) or np.any(lab[-1] == L0) or np.any(lab[:, 0] == L0) or np.any(lab[:, -1] == L0))
    if not edge:
        probs.append("start is in a closed pocket (no way out to the city)")
    return cl, probs, reached, edge


# ---------------------------------------------------------------- ride height (L1 mesh)
# The start must be on open street, not under or against a structure. Where a street passes under
# a viaduct / station hall / bridge the photogrammetry has only the deck on top and no street under
# it (Alexanderstrasse under the Stadtbahn at Jannowitzbruecke: deck +6.3 m, no surface below), and
# a tree crown or canopy hides the car. On a 0.5 m lattice over the car box (js/vehicle.js size) the
# top mesh surface (L1, the level the game streams at the car) is taken; street = its 20th percentile.
#   - street - height grid must lie in [-RIDE_DOWN, +RIDE_UP] = js/ground.js acquire / acquireUp:
#     the band in which the game (re)acquires the mesh at a start (outside it the car rides the
#     height model under whatever the mesh shows);
#   - at most RIDE_OVER of the box points (box grown by RIDE_PAD) may have their top more than RIDE_TOL above the street
#     (deck edge, canopy, crown or object over / in the car).
RIDE_DOWN, RIDE_UP = 6.0, 3.5
RIDE_TOL, RIDE_OVER = 1.0, 0.10
RIDE_PAD = 0.5      # m, the box grown by this (the car's own probes reach 0.6 m / 0.35 m beyond it)
MESH_SRC = os.path.join(os.path.dirname(HERE), "berlin_mesh_2025_wab")
_MESH = {}


def _mesh_tris(level, x, z, r=6.0):
    """L1 mesh triangles (T x 3 x 3, game frame) near (x, z); tiles cached per path"""
    if "lv" not in _MESH:
        sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
        from build_pits import Level as PL
        _MESH["lv"] = PL(level, MESH_SRC)
    pl = _MESH["lv"]
    ext = (x - r, -z - r, x + r, -z + r)
    out = []
    for row in pl.l1:
        if not (row[3] + row[6] >= ext[0] and row[3] - row[6] <= ext[2] and -row[5] + row[6] >= ext[1] and -row[5] - row[6] <= ext[3]):
            continue
        T = _MESH.get(row[0])
        if T is None:
            prims, _ = pl.prims(ext, margin=0.0, rows=[row])
            T = np.concatenate([p["pos"][p["idx"].reshape(-1, 3)] for p in prims]).astype(np.float32) if prims else np.zeros((0, 3, 3), np.float32)
            if len(_MESH) > 400:   # keep memory bounded
                for k in [k for k in _MESH if k != "lv"][:200]:
                    del _MESH[k]
            _MESH[row[0]] = T
        m = (T[:, :, 0].max(1) >= ext[0]) & (T[:, :, 0].min(1) <= ext[2]) & (-T[:, :, 2].max(1) <= ext[3]) & (-T[:, :, 2].min(1) >= ext[1])
        out.append(T[m])
    return np.concatenate(out).astype(np.float64) if out else np.zeros((0, 3, 3))


def _tops(T, xs, zs):
    """highest non-vertical mesh surface over each point (NaN = none)"""
    xa, za, xb, zb, xc, zc = (T[:, k, c][None] for k in range(3) for c in (0, 2))
    d = (zb - zc) * (xa - xc) + (xc - xb) * (za - zc)
    ok = np.abs(d) > 1e-12
    d = np.where(ok, d, 1.0)
    X, Z = xs[:, None], zs[:, None]
    l1 = ((zb - zc) * (X - xc) + (xc - xb) * (Z - zc)) / d
    l2 = ((zc - za) * (X - xc) + (xa - xc) * (Z - zc)) / d
    l3 = 1 - l1 - l2
    inside = ok & (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
    y = l1 * T[:, 0, 1][None] + l2 * T[:, 1, 1][None] + l3 * T[:, 2, 1][None]
    y = np.where(inside, y, -np.inf).max(1)
    return np.where(np.isfinite(y), y, np.nan)


def ride_check(lv, x, z, h):
    """(info, problems): the mesh under the car box vs the height grid (see RIDE_*)"""
    fx, fz, lx, lz = math.sin(h), -math.cos(h), math.cos(h), math.sin(h)
    U, V = np.meshgrid(np.arange(-CAR_HL - RIDE_PAD, CAR_HL + RIDE_PAD + 0.01, 0.5), np.arange(-CAR_HW - RIDE_PAD, CAR_HW + RIDE_PAD + 0.01, 0.5))
    xs, zs = x + U.ravel() * fx + V.ravel() * lx, z + U.ravel() * fz + V.ravel() * lz
    T = _mesh_tris(lv.name, x, z)
    top = _tops(T, xs, zs) if len(T) else np.full(len(xs), np.nan)
    H = lv.L["height"]
    hg = _MESH.get("hgrid")
    if hg is None:
        hg = _MESH["hgrid"] = np.fromfile(os.path.join(lv.dir, H["file"]), np.float32).reshape(H["nz"], H["nx"])
    fi = np.clip((xs - H["x0"]) / H["cell"], 0, H["nx"] - 1.001); fj = np.clip((-zs - H["n0"]) / H["cell"], 0, H["nz"] - 1.001)
    g = ndimage.map_coordinates(hg.astype(np.float64), [fj, fi], order=1, mode="nearest")
    probs = []
    if np.isnan(top).mean() > 0.2:
        return {"mesh": round(float(1 - np.isnan(top).mean()), 2)}, ["ride: no mesh under the car"]
    street = float(np.nanpercentile(top, 20))
    rel = street - float(np.median(g))
    over = float(np.nanmean(top > street + RIDE_TOL))
    if not -RIDE_DOWN <= rel <= RIDE_UP:
        probs.append(f"ride: mesh top {rel:+.1f} m from the height grid (under a structure?)")
    if over > RIDE_OVER:
        probs.append(f"ride: {over * 100:.0f} % of the car box under / in something > {RIDE_TOL:g} m above the street")
    return {"street": round(rel, 2), "over": round(over, 2), "top": round(float(np.nanmax(top)) - street, 2)}, probs


def auto_pose(lv, w, free, dist, x, z, opt, poly):
    pref = opt["pref"]
    side = opt.get("side")
    rect = None
    cands = []
    for hw, nm, P in lv.load_roads():
        if P[:, 0].max() < w.box[0] or P[:, 0].min() > w.box[2] or P[:, 1].max() < w.box[1] or P[:, 1].min() > w.box[3]:
            continue
        for a, b in zip(P[:-1], P[1:]):
            L = float(np.hypot(*(b - a)))
            for t in np.arange(0, L, 2.0) / max(L, 1e-9):
                q = a + (b - a) * t
                e = math.hypot(q[0] - x, q[1] - z)
                if e > 3 * pref or e < 8:
                    continue
                if side and (q[0] - x) * side[0] + (q[1] - z) * side[1] < 10:
                    continue
                cands.append((float(q[0]), float(q[1]), hw, nm))
    # cheap pass: driving distance, straightness, road class, room around the centre
    pre = []
    room = np.minimum(w.edt["wall"], w.edt["clutter"] / 2)
    lab, _ = ndimage.label(free)   # only free space that leads out of the window (not a closed pocket)
    out_labels = set(np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]]).tolist()) - {0}
    for cx, cz, hw, nm in cands:
        if not (w.box[0] < cx < w.box[2] and w.box[1] < cz < w.box[3]):
            continue
        j, i = w.ij(cx, cz)
        if dist[j, i] < 0 or not free[j, i] or room[j, i] < 1.5 or lab[j, i] not in out_labels:
            continue
        drive = dist[j, i] * CELL
        if drive < 0.5 * pref or drive > 2.5 * pref:
            continue
        straight = math.hypot(cx - x, cz - z)
        score = abs(drive - pref) / pref + 0.6 * max(0.0, drive / max(straight, 1) - 1) + (0 if hw in CAR_ROADS else 0.35) \
            - 0.05 * min(float(room[j, i]), 6)
        pre.append((score, cx, cz, hw, nm))
    pre.sort(key=lambda r: r[0])
    ok = []
    for score, cx, cz, hw, nm in pre[:60]:   # full test (heading along the path, car-box clearance) for the best few
        h, plen = path_heading(w, free, dist, cx, cz)
        if h is None:
            continue
        cl = clearance(w, cx, cz, h)
        if any(cl[k] < m for k, m in MARGIN.items()):
            continue
        straight = math.hypot(cx - x, cz - z)
        score = abs(plen - pref) / pref + 0.6 * max(0.0, plen / max(straight, 1) - 1) + (0 if hw in CAR_ROADS else 0.35) \
            - 0.05 * min(cl["wall"], 6) - 0.03 * min(cl["clutter"], 8)
        ok.append((score, cx, cz, h, hw, nm))
    ok.sort(key=lambda r: r[0])
    for b in ok:   # best score whose ride height is street level (mesh, so only as many as needed)
        if not ride_check(lv, b[1], b[2], b[3])[1]:
            return b
    return None


def roof_spot(lv, kind, slug, name, rid, egg=None, start=None):
    """a roof spot: start = the route's start in roofs_deck.json (build_roofs.py); check = every point of
    the car box grown by 1 m is on the deck (index.html enters roof mode there, `roof` = route id).
    egg: a roof bear's eggs.json id (target = the bear, plus the drive to it must stay on the deck);
    start: (x, z, h) instead of the route's start"""
    doc = json.load(open(os.path.join(lv.dir, "roofs_deck.json")))
    R = next(r for r in doc["routes"] if r["id"] == rid)
    g = R["deck"]
    D = np.fromfile(os.path.join(lv.dir, doc["file"]), "<i2", g["count"], offset=g["off"]).reshape(g["nz"], g["nx"])
    st = R["start"]
    x, z, h = start if start else (st["x"], st["z"], st["h"])
    room = 0.0
    for pad in np.arange(0.0, 20.01, 0.5):
        xs, zs = car_points(x, z, h)
        c, s_ = math.cos(h), math.sin(h)
        ok = True
        for dx, dz in ((0, 0), (pad, 0), (-pad, 0), (0, pad), (0, -pad), (pad, pad), (-pad, -pad), (pad, -pad), (-pad, pad)):
            i = np.floor((xs + dx - g["x0"]) / g["cell"]).astype(int); j = np.floor((-(zs + dz) - g["n0"]) / g["cell"]).astype(int)
            if (i < 0).any() or (j < 0).any() or (i >= g["nx"]).any() or (j >= g["nz"]).any() or (D[j, i] == g["void"]).any():
                ok = False; break
        if not ok:
            break
        room = pad
    probs = [] if room >= 1.0 else [f"deck {room:.1f} m < 1.0"]
    sl, sn = lv.latlon(x, z)
    T = R["trigger"]
    ref, drive = "roof:" + rid, None
    if egg:   # the bear: target, and the straight drive start -> bear on the deck (car half width + 0.3 m either side)
        it = next(i for i in json.load(open(os.path.join(lv.dir, "eggs.json")))["items"] if i["id"] == egg)
        T, ref = {"x": it["x"], "z": it["z"]}, egg
        drive = round(math.hypot(it["x"] - x, it["z"] - z))
        for t in np.linspace(0, 1, 80):
            for off in (-CAR_HW - 0.3, 0.0, CAR_HW + 0.3):
                px = x + (it["x"] - x) * t + off * math.cos(h); pz = z + (it["z"] - z) * t + off * math.sin(h)
                i = int((px - g["x0"]) // g["cell"]); j = int((-pz - g["n0"]) // g["cell"])
                if not (0 <= i < g["nx"] and 0 <= j < g["nz"]) or D[j, i] == g["void"]:
                    probs.append(f"drive to the bear leaves the deck at ({px:.1f}, {pz:.1f})"); break
            else:
                continue
            break
    tl, tn = lv.latlon(T["x"], T["z"])
    y = st["y"] if not start else round(float(D[int((-z - g["n0"]) // g["cell"]), int((x - g["x0"]) // g["cell"])]) * g["unit"], 2)
    return {"slug": slug, "name": name, "kind": kind, "ref": ref, "roof": rid, **({"drive": drive} if drive else {}),
            "target": {"x": T["x"], "z": T["z"], "lat": round(tl, 6), "lon": round(tn, 6)},
            "start": {"x": round(x, 2), "z": round(z, 2), "heading": round(h, 4), "deg": round(math.degrees(h) % 360),
                      "lat": round(sl, 6), "lon": round(sn, 6), "y": y},
            "how": "known", "check": {"ok": not probs, "clear": {"deck": round(room, 1)}, **({"problems": probs} if probs else {})}}


def build(level, only=None, dry=False):
    lv = Level(level)
    out, bad = [], 0
    for kind, slug, name, tgt, o in SPOTS:
        if only and slug not in only:
            continue
        opt = {**DEFAULT.get(kind, {}), "pref": 40, "reach": 3.0, **DEFAULT.get(kind, {}), **o}
        if tgt[0] == "roof":   # on a roof deck (js/roofs.js): no street checks, the car box must be on the deck
            rec = roof_spot(lv, kind, slug, name, tgt[1], *tgt[2:3], start=opt.get("start"))
            out.append(rec); bad += not rec["check"]["ok"]
            print(f"  {'ok ' if rec['check']['ok'] else 'BAD'} {slug:34s} roof  start ({rec['start']['x']:8.1f}, {rec['start']['z']:8.1f}) "
                  f"{rec['start']['deg']:5.0f} deg  deck room {rec['check']['clear']['deck']} m" + ("  ! " + "; ".join(rec["check"]["problems"]) if not rec["check"]["ok"] else ""))
            continue
        x, z, ref, poly, ignore = target_of(lv, tgt)
        w = Window(lv, x, z)
        free = w.free(ignore)
        seeds = seeds_for(w, x, z, poly, opt["reach"])
        dist = bfs(free, seeds)
        how, road = "known", None
        ap = lv.sbahn[tgt[1]].get("approach") if opt.get("approach") and tgt[0] == "sbahn" else None
        if ap:
            sx, sz, sh = ap["x"], ap["z"], ap["h"]; how = "door"
        elif "start" in opt:
            sx, sz, sh = opt["start"]
        else:
            b = auto_pose(lv, w, free, dist, x, z, opt, poly)
            if b is None:
                print(f"  ! {slug}: no start found"); bad += 1; continue
            _, sx, sz, sh, hw, nm = b
            sx, sz, sh = round(sx, 1), round(sz, 1), round(sh, 3)
            how, road = "auto", f"{hw}{' ' + nm if nm else ''}"
        cl, probs, reached, edge = check_pose(w, free, dist, sx, sz, sh)
        ride, rp = ride_check(lv, sx, sz, sh)
        probs += rp
        corr = None
        if opt.get("corridor") and tgt[0] == "sbahn":   # straight start -> door zone, car half width + 1 m either side
            E = lv.sbahn[tgt[1]]
            L_ = math.hypot(E["x"] - sx, E["z"] - sz); n_ = max(2, int(L_ / 0.5) + 1)
            xs, zs = np.linspace(sx, E["x"], n_), np.linspace(sz, E["z"], n_)
            corr = {k: round(float(w.sample(w.edt[k], xs, zs).min()), 2) for k in ("wall", "clutter", "trunk") if k in w.edt}
            need = CAR_HW + 1.0
            bad_k = [f"{k} {v} m" for k, v in corr.items() if v < need]
            if bad_k:
                probs.append(f"straight corridor to the door blocked ({', '.join(bad_k)} < {need:.2f})")
        j, i = w.ij(sx, sz)
        _, plen = path_heading(w, free, dist, sx, sz)
        straight = math.hypot(sx - x, sz - z)
        tl, tn = lv.latlon(x, z)
        sl, sn = lv.latlon(sx, sz)
        rec = {"slug": slug, "name": name, "kind": kind, "ref": ref,
               "target": {"x": round(x, 2), "z": round(z, 2), "lat": round(tl, 6), "lon": round(tn, 6)},
               "start": {"x": round(sx, 2), "z": round(sz, 2), "heading": round(sh, 4), "deg": round(math.degrees(sh) % 360),
                         "lat": round(sl, 6), "lon": round(sn, 6)},
               "how": how, **({"road": road} if road else {}),
               "check": {"ok": not probs, "clear": {k: round(v, 1) for k, v in cl.items()}, "ride": ride,
                         "drive": None if plen is None else round(plen), "straight": round(straight),
                         **({"corridor": corr} if corr else {}),
                         **({"problems": probs} if probs else {})}}
        out.append(rec)
        flag = "ok " if not probs else "BAD"
        print(f"  {flag} {slug:34s} {how:5s} start ({sx:8.1f}, {sz:8.1f}) {math.degrees(sh) % 360:5.0f} deg  "
              f"drive {rec['check']['drive']} m / straight {straight:.0f} m  clear wall {cl['wall']:.1f} clutter {cl['clutter']:.1f} "
              f"water {cl['water']:.1f} ride {ride}" + (f" corridor {corr}" if corr else "") + (f"  {road}" if road else "") + ("  ! " + "; ".join(probs) if probs else ""))
        bad += bool(probs)
    path = os.path.join(lv.dir, "spots.json")
    if only and not dry and os.path.exists(path):   # --only: replace those rows in the existing file, keep the table order
        old = {r["slug"]: r for r in json.load(open(path))["spots"]}
        old.update({r["slug"]: r for r in out})
        out = [old[sl] for _, sl, *_ in SPOTS if sl in old]
        only = None
    if not dry and not only:
        res = {"level": level, "frame": "level x = east, z = -north (m); heading clockwise from north (rad), forward = (sin h, -cos h)",
               "note": "built by build_spots.py: easter-egg spots, index.html?spot=<slug> starts the car at `start`",
               "spots": out}
        json.dump(res, open(path, "w"), ensure_ascii=False, indent=1)
        print(f"{level}: {len(out)} spots -> {path}" + (f"  ({bad} problems)" if bad else "  (all checks passed)"))
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--level", default="mitte_all")
    ap.add_argument("--only", nargs="*", help="check these slugs only (their rows are replaced in an existing spots.json)")
    ap.add_argument("--dry-run", action="store_true", help="check, do not write spots.json")
    a = ap.parse_args()
    sys.exit(1 if build(a.level, a.only, a.dry_run) else 0)


if __name__ == "__main__":
    main()

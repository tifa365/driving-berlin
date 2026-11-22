#!/usr/bin/env python3
"""Easter eggs -> levels/<name>/eggs.json (football pitches + goals + balls, Berlin bears).

The lat/lon lists below are the source; this script converts them into the level frame
with the exact transform of build_level.py / build_stream.py (ENU around the level origin,
x = east, z = -north) and checks every item against the level data:
inside the level, not in water, not in a building (the OSM footprints in map.json; a level.json
with LoD2 `walls` / `obstacles` is checked against those too) and at least MEMORIAL_GAP m
from memorial sites (no playful things at or next to them).

  python3 racing/build_eggs.py                # all levels that exist
  python3 racing/build_eggs.py --level mitte_all  # one
(One level since 2026-11-19: the small level `mitte` and its 5 bears / Pariser Platz pitch were retired.)

Read by index.html (js/eggs.js), map.html and the minimap. Items:
  bear : id, name, hint, lat, lon, x, z, paint, area {x, z, lat, lon, radius} (fuzzed circle
         for the "area" hint mode; the bear lies inside it, not at its centre);
         a roof bear also has roof (route id in roofs_deck.json, build_roofs.py) and y (deck height m):
         it stands on that roof deck and is found only by a car in roof mode there (js/roofs.js)
  pitch: id, name, lat, lon, x, z, heading (rad, long axis, clockwise from north like the car),
         length, width, lines (draw white lines: true where the mesh shows none), corners [[x, z] x 4]
  goal : id, pitch, lat, lon, x, z (middle of the goal line), heading (from the line into the net),
         width, height, depth
  ball : id, pitch, lat, lon, x, z (centre spot)
Also writes levels/<name>/doorway.json from DOORWAYS / FOUNTAINS (js/doorway.js: a cartoon figure in a house door
and a garden fountain, kept
out of eggs.json so map.html and the minimap do not list it).
"""
import argparse, hashlib, json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import merge_tiles as MT                    # noqa: E402
from merge_hybrid import geo_to_ecef        # noqa: E402

GOAL = {"width": 8.5, "height": 2.8, "depth": 2.2}
AREA_R = 80.0          # m, hint circle radius
MEMORIAL_GAP = 100.0   # m
ROOF_EDGE = 1.0        # m: a roof bear's collider stays this far from the deck edge and the roof boxes
BEAR_COLLIDER = 0.8 * 2.05   # m: js/eggs.js BEAR_R x BEAR_SCALE
# memorial sites (owner: nothing playful at or next to them); centre lat, lon, radius of the site m
MEMORIALS = [   # from the OSM extract (historic=memorial), radius ~ half the site's extent
    ("Denkmal fuer die ermordeten Juden Europas", 52.51404, 13.37898, 100),
    ("Denkmal fuer die ermordeten Sinti und Roma", 52.51730, 13.37603, 15),
    ("Sinti und Roma Freiluftausstellung", 52.51733, 13.37546, 5),
    ("Denkmal fuer die verfolgten Homosexuellen", 52.51326, 13.37613, 5),
    ("Sowjetisches Ehrenmal Tiergarten", 52.51674, 13.37187, 60),
    ("Gedenkstein fuer die 96 ermordeten Reichstagsabgeordneten", 52.51796, 13.37462, 5),
    ("Weisse Kreuze", 52.51967, 13.37679, 10),
    ("Neue Wache", 52.51781, 13.39558, 15),
    ("Denkmal zur Erinnerung an die Buecherverbrennung", 52.51650, 13.39392, 10),
    ("Topographie des Terrors", 52.50635, 13.38385, 140),
    ("Checkpoint Charlie", 52.50750, 13.39040, 20),
    ("Gedenkstaette Berliner Mauer", 52.53698, 13.39495, 550),
    ("Mahnmal fuer die Maueropfer", 52.53965, 13.40030, 5),
    ("Gedenkstele Berliner Mauer (Spree)", 52.52040, 13.38807, 3),
    ("Gedenkstele Berliner Mauer (Invalidenstrasse)", 52.52330, 13.37392, 3),
    ("Mauerstueck", 52.52642, 13.37449, 3),
    ("erhaltener Teil der Berliner Mauer", 52.50560, 13.37730, 5),
    ("Block der Frauen", 52.52107, 13.40507, 10),
    ("Der verlassene Raum", 52.52852, 13.39775, 10),
    ("Herbert-Baum-Denkmal", 52.51838, 13.40057, 5),
    ("Ort der Herstellung der Judensterne", 52.51122, 13.40653, 3),
    ("Gedenkstein fuer die Opfer der Berliner Judenverbrennung", 52.52359, 13.42306, 3),
    ("Juedischer Friedhof Grosse Hamburger Strasse", 52.52500, 13.39900, 40),
    ("Ghost bike Unter den Linden", 52.51642, 13.38070, 2),
    ("Ghost bike Prenzlauer Berg", 52.52655, 13.41590, 2),
]

# ---------- the eggs ----------
# bears: (name, hint, lat, lon[, paint | options]); ids are <level>.bear.NN in this order.
# options (dict): paint; roof = route id in roofs_deck.json + x, z (level frame, exact; lat/lon are then
# derived): the bear stands ON that roof deck at the deck height; checked on the deck (>= ROOF_EDGE m from the
# deck edge and from roof obstacle boxes, collider included) instead of the street checks (building, water)
BEARS = {
    "mitte_all": [
        ("Republika am Platz der Republik", "am Rand einer großen Wiese im Westen", 52.51918, 13.37250),
        ("Paula am Pariser Platz", "wo das berühmteste Tor der Stadt steht", 52.51630, 13.37920),
        ("Gustav am Gendarmenmarkt", "zwischen zwei Domen", 52.51400, 13.39300),
        ("Luise im Lustgarten", "vor einem Museum auf einer Insel", 52.51905, 13.39880),
        ("Ursula an der Weltzeituhr", "wo man die Uhrzeit der ganzen Welt ablesen kann", 52.52130, 13.41300),
        ("Hacki am Hackeschen Markt", "an einem Bahnhof mit einem Markt im Namen", 52.52270, 13.40150),
        ("Leo am Leipziger Platz", "auf einem achteckigen Platz", 52.50970, 13.37990),
        ("Niko im Nikolaiviertel", "im ältesten Viertel der Stadt, nah am Wasser", 52.51630, 13.40640),
        ("Mona im Monbijoupark", "in einem Park an der Spree, gegenüber der Museumsinsel", 52.52240, 13.39720),
        ("Hugo am Hauptbahnhof", "vor einem großen gläsernen Bahnhof im Westen", 52.52420, 13.36940),
        ("Maxi im Köllnischen Park", "wo früher echte Bären wohnten", 52.51200, 13.41600),
        ("Wilma im Weinbergspark", "auf einem Hügel im Norden, wo einst Wein wuchs", 52.53200, 13.40100),
        # owner's courtyard: the enclosed block courtyard nearest 52.5100 N 13.4100 E (OSM footprints)
        ("Hilde im Hinterhof", "in einem Hinterhof südlich der Spree", 52.510566, 13.408218),
        # owner's spot (exact): behind the Kronprinzenpalais, between Niederlagstrasse and An der Kommandantur
        ("Fritzi am Kronprinzenpalais", "hinter einem Palais, nicht weit vom Schinkelplatz", 52.51699, 13.39723),
        # owner's spot (exact): service lane at S Jannowitzbruecke, under/next to the Stadtbahn viaduct (night-sky paint)
        ("Jana an der Jannowitzbrücke", "im Schatten der Stadtbahn, nicht weit vom Wasser", 52.51334, 13.42225, 3),
        # owner's spot (exact): HU Campus Nord, between Philippstrasse and Hannoversche Strasse
        ("Philippa am Campus Nord", "auf einem grünen Uni-Campus nördlich der Spree", 52.52677, 13.38288),
        # owner's spot (exact, 2026-11-22, his car on the roof route): the reward at the east end of the roof drive, on the
        # Marie-Elisabeth-Lueders-Haus (OSM building=government, Adele-Schreiber-Krieger-Strasse 1); moved 26 m east from
        # (-1217.50, 261.12), same id. Deck 60.56 m, 13.1 m from the deck edge, 12.7 m from the nearest roof box; roof mode only
        ("Lotte auf dem Lüders-Haus", "ganz oben am Ende der Fahrt über die Dächer, wo sonst nur Abgeordnete hinkommen",
         52.520136, 13.378947, {"roof": "bundestag", "x": -1191.50, "z": 262.91}),
        # owner (2026-11-21, standing there in the car): the garden in front of Albrechtstrasse 14 / 14B (the building
        # north of it; OSM address nodes 14, 14B on / in that footprint), set back from the street behind a fence.
        # Garden fountain at the owner's car position (FOUNTAINS); Lola stands 5.8 m north of its centre, off the line from the
        # `lola` spot start to the doorway figure on the east side (build_spots.py)
        ("Lola in der Albrechtstraße", "in einem Garten hinter einem Zaun, wo ein Brunnen plätschert und jemand gleich losrennt",
         52.5215074, 13.3853770),
        # owner's car position (exact, 2026-11-21, level x -589.76 z 1508.78): block interior between Mauerstrasse
        # (48 m, the nearest named street) and Krausenstrasse (52 m), on a service lane; ground (L1 mesh ~0.5 m below
        # the height grid), not a deck
        ("Maura an der Mauerstraße", "in einem stillen Hinterhof zwischen kleinen Museen über die Zeit der Mauer",
         52.508941, 13.387814),
    ],
}
# doorway figure (js/doorway.js, -> levels/<level>/doorway.json): a small cartoon homage standing in a house door,
# mid-stride. x, z = her feet (level frame), heading = out of the door (clockwise from north); height = figure m;
# door = plain dark door with a frame behind her (width, height m; back = m from her feet to the door plane).
# Checked: on dry ground outside the walls.bin footprints, with a footprint within 4 m behind her (recessed doors); no collider.
# (2026-11-21: moved from the recess in the north facade to the red house east of the garden, owner)
DOORWAYS = {
    "mitte_all": [
        # owner (2026-11-21): "the red one with the balconies", the house on the EAST side of the garden. OSM / ALKIS has
        # no footprint of its own: its garden facade is the edge (52.5215532 13.3854933) -> (52.5214705 13.3855552) of the
        # same 5-level building=commercial polygon (walls.bin ring 8471) that wraps the garden on the north. L1 mesh along
        # that edge: facade at 0 .. 0.4 m, balconies 1 - 1.8 m deep from ~3 m up (t 2 .. 8 m), a 2 - 3 m hedge 3 - 7 m out
        # with a low gap and a wider paved strip at t 6 - 8 m (taken as the way to the door). She stands at t = 7 m (the
        # edge point nearest the fountain is t = 6.5), 0.75 m out (~0.4 m in front of the mesh facade), facing the garden
        {"name": "Hauseingang am Garten Albrechtstraße 14", "x": -744.88, "z": 111.98, "heading": -1.9991,
         "height": 2.4, "door": {"width": 1.4, "height": 2.6, "back": 0.33}},
    ],
}
# garden fountains (js/doorway.js, same doorway.json): x, z = basin centre, radius / height m; no collider
FOUNTAINS = {
    "mitte_all": [
        # exactly where the owner's car stood (x -755.156, z 116.149), owner: "show a water fountain there"
        {"name": "Gartenbrunnen Albrechtstraße 14", "x": -755.156, "z": 116.149, "radius": 1.5, "height": 0.5},
    ],
}
FOUNTAIN_BEAR_GAP = 4.0  # m from a basin centre to a bear (basin radius + bear body)
# hint frames (js/doorway.js, same doorway.json): thin green outline of an entrance, shown while `bear` is unfound.
# x, z = bottom centre of the opening (just outside the facade), heading = out of the opening; width, height m
HINTS = {
    "mitte_all": [
        # owner (2026-11-21, car at x -559.81 z 1484.79): the way in to Maura (bear 19), OSM way 1283378540 (service
        # driveway, tunnel=building_passage, sett) from Mauerstrasse (-559.2, 1484.3) to (-576.0, 1494.9) under the
        # building; walls.bin carves it (corridor r 2.8, no wall across). No width tag: build_walls' default passage
        # width 3.5 m; the L1 mesh fills the passage (roof at 21 m), clear height taken 3.6 m (lowest facade hit over
        # the mouth). Frame 0.4 m outside the facade (t = -0.4 m along the way), facing out (NE)
        {"name": "Durchfahrt Mauerstraße", "x": -558.86, "z": 1484.09, "heading": 1.0079, "width": 3.5, "height": 3.6,
         "bear": "mitte_all.bear.19"},
    ],
}
# watchers (js/doorway.js, same doorway.json): a dark lone window high in a blank wall with a silhouette and binoculars.
# x, z = window centre on the wall face (level frame), yAbs = its world height (mesh), heading = out of the wall;
# width / height = drawn window m (at least 1.6 x 2.0 so it can be noticed). Secret: no spot, no README table row.
WATCHERS = {
    "mitte_all": [
        # owner (2026-11-21, car at x -452.34 z 1607.60): the gable end of walls.bin ring 1591, edge (-458.3, 1610.4) ->
        # (-447.7, 1599.0) (15.6 m, faces 133 deg over the little plaza). L1 texture projected onto that plane (0.1 m):
        # the painted spiral spans 7 - 12 m along the edge, 15.5 - 22 m up; at its lower-left rim two dark panes
        # 5.5 - 7.1 m along, 16.3 - 17.5 m up (~1.6 x 1.2 m) = the window. Mesh face at -0.06 m from the line; centre
        # 6.3 m along, 16.9 m above the height grid there (35.17 m) -> world 52.07 m
        # drawn 2.2 x 2.4 m (owner 2026-11-21: legible from the game camera), still centred on the real panes
        # out: the streamed (coarser) tiles put the wall up to ~0.37 m in front of this line (game raycast,
        # 2026-11-21: the whole window was hidden behind it, only the additive glow showed) -> window plane 0.7 m out
        {"name": "Fenster in der Brandwand", "x": -454.01, "z": 1605.79, "yAbs": 52.07, "heading": 2.3198,
         "width": 2.2, "height": 2.4, "out": 0.7},
    ],
}
# photo groups (js/doorway.js, same doorway.json): two costumed "soldiers" and two tourists with a selfie stick, one row
# facing `heading`; x, z = middle of the row (feet), width m (row), height = figure m. No collider. Not checked against
# MEMORIALS (it is a street scene the owner asked for at Checkpoint Charlie, not a bear or a game).
PHOTO_GROUPS = {
    "mitte_all": [
        # owner (2026-11-21, car at x -416.45 z 1669.72): in front of the guard hut on the island of Friedrichstrasse.
        # Hut = walls.bin ring 7186 (-416.7 1675.0 / -416.4 1679.0 / -414.3 1678.8 / -414.6 1674.8, 2.1 x 4 m; the
        # L1 mesh shows it ~2.3 m high, sandbags 0.3 - 1 m high on its north side z 1673 - 1674.8). The row stands
        # 2.7 m north of the hut front (clear of the sandbags), centred on it, facing north (toward cars coming
        # south); 2.8 m wide: ~3 m from the west carriageway's centre line, ~2.5 m from the east one's
        {"name": "Fotos am Wachhaus", "x": -415.65, "z": 1672.2, "heading": 0.0, "width": 2.8, "height": 2.4},
    ],
}
DOORWAY_BEAR_GAP = 8.0   # m: bears keep this far from a doorway figure (both stay visible)
# pitches: (name, lat, lon, bearing of the long axis deg, length m, width m, draw lines)
PITCHES = {
    "mitte_all": [
        # OSM leisure=pitch, minimum-area rectangle of the polygon (goal lines = short sides)
        ("Bolzplatz Stallschreiberstraße", 52.506481, 13.404122, 157.1, 94.3, 62.3, False, None),
        ("Bolzplatz an der Kleinen Hamburger Straße", 52.527558, 13.395815, 38.3, 89.9, 59.7, False, None),
        ("Bolzplatz an der Holzmarktstraße", 52.515340, 13.421840, 118.7, 60.3, 39.9, False, None),
        ("Wiese vor dem Reichstag", 52.51860, 13.37220, 90.0, 100.0, 60.0, True, None),
    ],
}


def frame(level):
    L = json.load(open(os.path.join(HERE, "levels", level, "level.json")))
    lat0, lon0 = L["origin"]["lat"], L["origin"]["lon"]
    o = geo_to_ecef(lat0, lon0, 0.0)
    R = MT.enu_basis(lat0, lon0)

    def xz(lat, lon):
        v = R @ (geo_to_ecef(lat, lon, 0.0) - o)
        return float(v[0]), float(-v[1])

    kx, kz = 111320 * math.cos(math.radians(lat0)), 111132.0

    def latlon(x, z):   # inverse (fixed point on xz)
        lat, lon = lat0 - z / kz, lon0 + x / kx
        for _ in range(4):
            e, zz = xz(lat, lon)
            lon += (x - e) / kx; lat -= (z - zz) / kz
        return lat, lon
    return L, xz, latlon


def in_poly(x, z, p):
    p = np.asarray(p, float)
    a, b = p, np.roll(p, -1, axis=0)
    m = (a[:, 1] > z) != (b[:, 1] > z)
    with np.errstate(divide="ignore", invalid="ignore"):
        xi = (b[:, 0] - a[:, 0]) * (z - a[:, 1]) / (b[:, 1] - a[:, 1]) + a[:, 0]
    return bool(np.count_nonzero(m & (x < xi)) % 2)


def hdist(lat, lon, lat2, lon2):
    return math.hypot((lat - lat2) * 111200, (lon - lon2) * 111320 * math.cos(math.radians(lat)))


class Checker:
    def __init__(self, level, L):
        d = os.path.join(HERE, "levels", level)
        self.L, self.ex = L, L["extent"]
        W = self.W = L["water"]
        self.water = np.fromfile(os.path.join(d, W["file"]), np.uint8).reshape(W["nz"], W["nx"])
        self.walls = L.get("walls") or []
        self.obst = [o["p"] for o in L.get("obstacles") or []]
        self.bldg = []
        mp = os.path.join(d, "map.json")
        if not self.walls and os.path.exists(mp):
            self.bldg = [np.array(b, float).reshape(-1, 2) for b in json.load(open(mp))["buildings"]]

    def is_water(self, x, z):
        W = self.W
        i, j = int((x - W["x0"]) // W["cell"]), int((-z - W["n0"]) // W["cell"])
        return 0 <= i < W["nx"] and 0 <= j < W["nz"] and self.water[j, i] == 1

    def problems(self, x, z, lat, lon, clear=2.0, gap=MEMORIAL_GAP):
        out, ex = [], self.ex
        if not (ex["minX"] + 15 < x < ex["maxX"] - 15 and ex["minZ"] + 15 < z < ex["maxZ"] - 15):
            out.append("outside the level")
        if any(self.is_water(x + dx, z + dz) for dx in (-clear, 0, clear) for dz in (-clear, 0, clear)):
            out.append("water")
        if self.walls and sum(in_poly(x, z, w) for w in self.walls) % 2:
            out.append("inside a LoD2 building")
        if any(in_poly(x, z, o) for o in self.obst):
            out.append("inside a mesh obstacle")
        for b in self.bldg:
            if abs(b[:, 0].mean() - x) < 300 and abs(b[:, 1].mean() - z) < 300 and in_poly(x, z, b):
                out.append("inside an OSM building"); break
        for name, la, lo, r in MEMORIALS:
            d = hdist(lat, lon, la, lo) - r
            if d < gap:
                out.append(f"{d:.0f} m from {name}")
        return out


class roof_deck:
    """one route of levels/<level>/roofs_deck.json (build_roofs.py): deck height as js/roofs.js reads it
    (bilinear where all four cells are deck, else the nearest cell), distance to the deck edge / roof boxes"""
    def __init__(self, level, rid):
        from scipy import ndimage
        d = os.path.join(HERE, "levels", level)
        doc = json.load(open(os.path.join(d, "roofs_deck.json")))
        self.R = R = next(r for r in doc["routes"] if r["id"] == rid)
        g = self.g = R["deck"]
        self.D = np.fromfile(os.path.join(d, doc["file"]), "<i2", g["count"], offset=g["off"]).reshape(g["nz"], g["nx"])
        self.edt = ndimage.distance_transform_edt(self.D != g["void"]) * g["cell"]

    def height(self, x, z):
        g, D, V = self.g, self.D, self.g["void"]
        fi, fj = (x - g["x0"]) / g["cell"] - 0.5, (-z - g["n0"]) / g["cell"] - 0.5
        i, j = int(math.floor(fi + 0.5)), int(math.floor(fj + 0.5))   # Math.round
        if not (0 <= i < g["nx"] and 0 <= j < g["nz"]) or D[j, i] == V:
            return None
        i0, j0 = math.floor(fi), math.floor(fj); u, w = fi - i0, fj - j0
        if 0 <= i0 and 0 <= j0 and i0 + 1 < g["nx"] and j0 + 1 < g["nz"]:
            a, b, c, e = (int(v) for v in (D[j0, i0], D[j0, i0 + 1], D[j0 + 1, i0], D[j0 + 1, i0 + 1]))
            if V not in (a, b, c, e):
                return ((a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + e * u) * w) * g["unit"]
        return int(D[j, i]) * g["unit"]

    def check(self, x, z):
        g = self.g
        y = self.height(x, z)
        if y is None:
            return 0.0, ["not on the roof deck"]
        i, j = int((x - g["x0"]) // g["cell"]), int((-z - g["n0"]) // g["cell"])
        edge = float(self.edt[j, i])
        B = np.array(self.R["boxes"], float).reshape(-1, 4)
        box = float(np.hypot(np.maximum(np.maximum(B[:, 0] - x, x - B[:, 2]), 0), np.maximum(np.maximum(B[:, 1] - z, z - B[:, 3]), 0)).min()) if len(B) else 1e9
        need = BEAR_COLLIDER + ROOF_EDGE
        probs = [f"{edge:.1f} m from the deck edge < {need:.1f}"] if edge < need else []
        probs += [f"{box:.1f} m from a roof box < {need:.1f}"] if box < need else []
        print(f"  roof bear at ({x}, {z}): deck {y:.2f} m, {edge:.1f} m from the deck edge, {box:.1f} m from the nearest roof box")
        return y, probs


def fuzz(id_, x, z):
    """deterministic hint circle: centre 15..55 m off the bear, radius AREA_R"""
    h = hashlib.sha1(id_.encode()).digest()
    a = h[0] / 255 * 2 * math.pi
    r = 15 + h[1] / 255 * 40
    return x + r * math.cos(a), z + r * math.sin(a)


def build(level):
    L, xz, latlon = frame(level)
    chk = Checker(level, L)
    items, bad = [], 0
    r6 = lambda v: round(v, 6)
    r2 = lambda v: round(v, 2)

    def report(id_, probs):
        nonlocal bad
        if probs:
            bad += 1
            print(f"  ! {id_}: " + "; ".join(probs))

    for k, (name, hint, lat, lon, *paint) in enumerate(BEARS.get(level, []), 1):   # optional 5th: paint index or options
        id_ = f"{level}.bear.{k:02d}"
        opt = paint[0] if paint and isinstance(paint[0], dict) else {"paint": paint[0]} if paint else {}
        roof = None
        if opt.get("roof"):
            x, z = opt["x"], opt["z"]
            lat, lon = latlon(x, z)
            roof = roof_deck(level, opt["roof"])
            y, probs = roof.check(x, z)
            report(id_, probs + [p for p in chk.problems(x, z, lat, lon, clear=0.0) if p != "water" and not p.startswith("inside an OSM")])
        else:
            x, z = xz(lat, lon)
            report(id_, chk.problems(x, z, lat, lon, clear=3.0))
        ax, az = fuzz(id_, x, z)
        alat, alon = latlon(ax, az)
        items.append({"id": id_, "kind": "bear", "name": name, "hint": hint, "lat": r6(lat), "lon": r6(lon),
                      "x": r2(x), "z": r2(z), "paint": opt["paint"] if "paint" in opt else (k - 1 + 5) % 18,
                      **({"roof": opt["roof"], "y": round(y, 2)} if roof else {}),
                      "area": {"x": r2(ax), "z": r2(az), "lat": r6(alat), "lon": r6(alon), "radius": AREA_R}})
    for k, (name, lat, lon, bearing, length, width, lines, xz0) in enumerate(PITCHES.get(level, []), 1):
        pid = f"{level}.pitch.{k}"
        if xz0:
            x, z = xz0; lat, lon = latlon(x, z)
        else:
            x, z = xz(lat, lon)
        h = math.radians(bearing)
        ux, uz = math.sin(h), -math.cos(h)           # long axis (level frame)
        vx, vz = -uz, ux
        corners = [[r2(x + su * length / 2 * ux + sv * width / 2 * vx), r2(z + su * length / 2 * uz + sv * width / 2 * vz)]
                   for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        report(pid, chk.problems(x, z, lat, lon, clear=3.0))
        for cx, cz in corners:   # corners: only level / water / memorials matter (lines may cross a kerb)
            clat, clon = latlon(cx, cz)
            report(pid + " corner", [p for p in chk.problems(cx, cz, clat, clon, clear=0.0)
                                     if not p.startswith("inside an OSM")])
        items.append({"id": pid, "kind": "pitch", "name": name, "lat": r6(lat), "lon": r6(lon), "x": r2(x), "z": r2(z),
                      "heading": round(h, 5), "length": length, "width": width, "lines": lines, "corners": corners})
        for s, tag in ((1, "a"), (-1, "b")):
            gx, gz = x + s * length / 2 * ux, z + s * length / 2 * uz
            glat, glon = latlon(gx, gz)
            gh = h if s > 0 else h + math.pi
            report(f"{pid}.goal.{tag}", chk.problems(gx, gz, glat, glon, clear=0.0))
            items.append({"id": f"{pid}.goal.{tag}", "kind": "goal", "pitch": pid, "lat": r6(glat), "lon": r6(glon),
                          "x": r2(gx), "z": r2(gz), "heading": round(math.atan2(math.sin(gh), math.cos(gh)), 5), **GOAL})
        items.append({"id": f"{pid}.ball", "kind": "ball", "pitch": pid, "lat": r6(lat), "lon": r6(lon), "x": r2(x), "z": r2(z)})
    out = {"level": level, "frame": "level x = east, z = -north (metres); heading clockwise from north (rad)",
           "note": "built by build_eggs.py; easter eggs: football pitches and the Berlin bear hunt", "items": items}
    path = os.path.join(HERE, "levels", level, "eggs.json")
    json.dump(out, open(path, "w"), ensure_ascii=False, indent=1)
    nb = sum(it["kind"] == "bear" for it in items); np_ = sum(it["kind"] == "pitch" for it in items)
    print(f"{level}: {nb} bears, {np_} pitches -> {path}" + (f"  ({bad} problems)" if bad else "  (all checks passed)"))
    return bad + build_doorways(level, xz, latlon, chk, [it for it in items if it["kind"] == "bear"])


def wall_rings(level):
    """walls.bin footprint rings (build_walls.py: outer > 0, courtyard < 0) as [(ring N x 2 (x, z), hole)]"""
    d = os.path.join(HERE, "levels", level)
    wj = json.load(open(os.path.join(d, "walls.json")))
    raw = open(os.path.join(d, wj["file"]), "rb").read()
    rl = np.frombuffer(raw, "<i4", wj["ringLen"]["count"], wj["ringLen"]["offset"])
    rp = np.frombuffer(raw, "<i2", wj["rings"]["count"] * 2, wj["rings"]["offset"]).reshape(-1, 2).astype(float) * wj["scale"]
    out, o = [], 0
    for n in rl:
        m = abs(int(n)); out.append((rp[o:o + m], n < 0)); o += m
    return out


def in_rings(rings, p):
    """inside a walls.bin footprint (outer rings minus courtyards)"""
    c = 0
    for r, hole in rings:
        if r[:, 0].min() <= p[0] <= r[:, 0].max() and r[:, 1].min() <= p[1] <= r[:, 1].max() and in_poly(p[0], p[1], r):
            c += -1 if hole else 1
    return c > 0


def build_doorways(level, xz, latlon, chk, bears):
    """DOORWAYS + FOUNTAINS -> levels/<level>/doorway.json (js/doorway.js); checked: in the level, dry, outside the
    walls.bin footprints (a doorway with one right behind it), clear of the bears"""
    if not any(level in T for T in (DOORWAYS, FOUNTAINS, HINTS, PHOTO_GROUPS, WATCHERS)):
        return 0
    rings = wall_rings(level)
    out, bad = [], 0

    def common(id_, x, z, gap):
        lat, lon = latlon(x, z)
        probs = [p for p in chk.problems(x, z, lat, lon, clear=0.0) if not p.startswith("inside an OSM")]
        probs += ["inside a building footprint (walls.bin)"] if in_rings(rings, (x, z)) else []
        near = [(math.hypot(b["x"] - x, b["z"] - z), b["id"]) for b in bears]
        probs += [f"{dd:.1f} m from {bid} < {gap}" for dd, bid in near if dd < gap]
        return lat, lon, probs, min(near)[0] if near else None

    for k, D in enumerate(DOORWAYS.get(level, []), 1):
        id_ = f"{level}.doorway.{k}"
        x, z, h = D["x"], D["z"], D["heading"]
        lat, lon, probs, nb = common(id_, x, z, DOORWAY_BEAR_GAP)
        if not any(in_rings(rings, (x - s * math.sin(h), z + s * math.cos(h))) for s in (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0)):   # a recessed door: up to 4 m
            probs.append("no building footprint (walls.bin) within 4 m behind her")
        if probs:
            bad += 1; print(f"  ! {id_}: " + "; ".join(probs))
        print(f"  {id_}: ({x:.2f}, {z:.2f}) heading {math.degrees(h) % 360:.0f} deg, nearest bear {nb:.1f} m")
        out.append({"id": id_, "kind": "doorway", "name": D["name"], "lat": round(lat, 6), "lon": round(lon, 6),
                    "x": x, "z": z, "heading": round(h, 4), "height": D["height"], "door": D["door"]})
    for k, F in enumerate(FOUNTAINS.get(level, []), 1):
        id_ = f"{level}.fountain.{k}"
        x, z = F["x"], F["z"]
        lat, lon, probs, nb = common(id_, x, z, FOUNTAIN_BEAR_GAP + F["radius"])
        if any(in_rings(rings, (x + F["radius"] * math.cos(a), z + F["radius"] * math.sin(a))) for a in np.linspace(0, 2 * math.pi, 16)):
            probs.append("basin overlaps a building footprint")
        if probs:
            bad += 1; print(f"  ! {id_}: " + "; ".join(probs))
        print(f"  {id_}: ({x:.2f}, {z:.2f}) radius {F['radius']} m, nearest bear {nb:.1f} m")
        out.append({"id": id_, "kind": "fountain", "name": F["name"], "lat": round(lat, 6), "lon": round(lon, 6),
                    "x": x, "z": z, "radius": F["radius"], "height": F["height"]})
    ids = {b["id"] for b in bears}
    for k, Hf in enumerate(HINTS.get(level, []), 1):
        id_ = f"{level}.hint.{k}"
        x, z = Hf["x"], Hf["z"]
        lat, lon, probs, nb = common(id_, x, z, 0.0)
        probs += [] if Hf["bear"] in ids else [f"unknown bear {Hf['bear']}"]
        if probs:
            bad += 1; print(f"  ! {id_}: " + "; ".join(probs))
        print(f"  {id_}: ({x:.2f}, {z:.2f}) heading {math.degrees(Hf['heading']) % 360:.0f} deg, {Hf['width']} x {Hf['height']} m -> {Hf['bear']}")
        out.append({"id": id_, "kind": "hint-frame", "name": Hf["name"], "lat": round(lat, 6), "lon": round(lon, 6), "x": x, "z": z,
                    "heading": Hf["heading"], "width": Hf["width"], "height": Hf["height"], "bear": Hf["bear"]})
    for k, Wt in enumerate(WATCHERS.get(level, []), 1):
        id_ = f"{level}.watcher.{k}"
        x, z, h = Wt["x"], Wt["z"], Wt["heading"]
        lat, lon = latlon(x, z)
        probs = [] if any(in_rings(rings, (x - s * math.sin(h), z + s * math.cos(h))) for s in (0.3, 0.6, 1.0)) else ["no building footprint behind the window"]
        probs += [] if not in_rings(rings, (x + 0.5 * math.sin(h), z - 0.5 * math.cos(h))) else ["the space in front of the window is inside a footprint"]
        if probs:
            bad += 1; print(f"  ! {id_}: " + "; ".join(probs))
        print(f"  {id_}: ({x:.2f}, {z:.2f}) y {Wt['yAbs']} m, heading {math.degrees(h) % 360:.0f} deg, {Wt['width']} x {Wt['height']} m")
        out.append({"id": id_, "kind": "watcher", "name": Wt["name"], "lat": round(lat, 6), "lon": round(lon, 6), "x": x, "z": z,
                    "yAbs": Wt["yAbs"], "heading": h, "width": Wt["width"], "height": Wt["height"], "out": Wt.get("out", 0.0)})
    for k, G in enumerate(PHOTO_GROUPS.get(level, []), 1):
        id_ = f"{level}.photo.{k}"
        x, z, h, half = G["x"], G["z"], G["heading"], G["width"] / 2
        lat, lon = latlon(x, z)
        probs = [p for p in chk.problems(x, z, lat, lon, clear=0.0, gap=-1e9) if not p.startswith("inside an OSM")]
        ends = [(x + e * half * math.cos(h), z + e * half * math.sin(h)) for e in (-1, 0, 1)]   # along the row (perpendicular to heading)
        probs += [f"row point ({px:.1f}, {pz:.1f}) inside a building footprint (walls.bin)" for px, pz in ends if in_rings(rings, (px, pz))]
        if probs:
            bad += 1; print(f"  ! {id_}: " + "; ".join(probs))
        print(f"  {id_}: ({x:.2f}, {z:.2f}) heading {math.degrees(h) % 360:.0f} deg, row {G['width']} m, figures {G['height']} m")
        out.append({"id": id_, "kind": "photo-group", "name": G["name"], "lat": round(lat, 6), "lon": round(lon, 6), "x": x, "z": z,
                    "heading": h, "width": G["width"], "height": G["height"]})
    path = os.path.join(HERE, "levels", level, "doorway.json")
    json.dump({"level": level, "frame": "level x = east, z = -north (metres); heading clockwise from north (rad), forward = (sin h, -cos h)",
               "note": "built by build_eggs.py (DOORWAYS, FOUNTAINS, HINTS, PHOTO_GROUPS, WATCHERS); js/doorway.js: cartoon figures, garden fountain, hint frames; no colliders",
               "items": out}, open(path, "w"), ensure_ascii=False, indent=1)
    print(f"{level}: {len(out)} doorway / fountain item(s) -> {path}" + (f"  ({bad} problems)" if bad else "  (all checks passed)"))
    return bad

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--level", action="append", help="level name (default: every level in BEARS/PITCHES that exists)")
    a = ap.parse_args()
    levels = a.level or [l for l in sorted(set(BEARS) | set(PITCHES) | set(DOORWAYS) | set(FOUNTAINS) | set(HINTS) | set(PHOTO_GROUPS) | set(WATCHERS)) if os.path.exists(os.path.join(HERE, "levels", l, "level.json"))]
    bad = sum(build(l) for l in levels)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

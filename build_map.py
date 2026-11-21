#!/usr/bin/env python3
"""Minimap data for a level: levels/<name>/map.json (js/minimap.js loads it lazily).

  roads     : OSM highways as polylines in the level frame, with class + name
  rail      : surface railways (rail, light_rail, tram) - S-Bahn viaduct etc.
  water     : OSM natural=water / riverbank areas (outer + inner rings, even-odd)
  parks     : leisure=park areas (same ring format)
  buildings : OSM building footprints (simplified 0.5 m), if the response had them
  places    : named places (quarter / neighbourhood / suburb) and landmarks
              (tourism=attraction/museum, historic=monument/memorial) as points

Frame as in build_level.py: ENU around level.json["origin"], x = east, z = -north
(three.js / Box2D coordinates), metres rounded to 0.1.

OSM comes from ONE Overpass request, cached as levels/<name>/osm_map.json. A level
whose bbox lies inside another level's bbox reuses that level's cache, so no request
is made for it (used by the small level `mitte`, retired 2026-11-19).

  python3 racing/build_map.py                      # --name mitte_all: one Overpass request (cached)
Options: --no-buildings (leave footprints out of the query and the output).
"""
import argparse, glob, json, math, os, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import numpy as np                       # noqa: E402
import merge_tiles as MT                 # noqa: E402
from merge_hybrid import geo_to_ecef     # noqa: E402
from osm_semantic import OVERPASS, ROAD_WIDTH, PATH_WIDTH   # noqa: E402

UA = "berlin-mesh-tools"
MAX_BUILDINGS_MB = 40      # raw response above this: buildings are dropped from map.json
PLACE_KINDS = ("suburb", "quarter", "neighbourhood")


def query(bbox, buildings):
    W, S, E, N = bbox
    b = f"({S},{W},{N},{E})"
    q = (f"[out:json][timeout:180];("
         f'way["highway"]{b};'
         f'way["railway"~"^(rail|light_rail|tram)$"]{b};'
         f'way["natural"="water"]{b};relation["natural"="water"]{b};way["waterway"="riverbank"]{b};'
         f'way["leisure"="park"]{b};relation["leisure"="park"]{b};'
         f");out geom;"
         f'(node["place"~"^({"|".join(PLACE_KINDS)})$"]{b};'
         f'nwr["tourism"~"^(attraction|museum)$"]["name"]{b};'
         f'nwr["historic"~"^(monument|memorial)$"]["name"]{b};);out center;')
    if buildings:
        q += f'way["building"]{b};out skel geom;'   # no tags: geometry only, smaller
    return q


def fetch(bbox, cache, buildings):
    """one Overpass request; on failure the next endpoint once, then give up"""
    q = query(bbox, buildings)
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            json.loads(body)
            open(cache, "wb").write(body)
            print(f"osm: fetched {len(body) / 1e6:.1f} MB from {url} -> {cache}")
            return
        except Exception as e:
            print(f"  overpass {url}: {e}")
    sys.exit("all Overpass endpoints failed - re-run later")


def find_cache(name, bbox):
    """own cache, else the cache of a level whose bbox contains ours"""
    own = os.path.join(HERE, "levels", name, "osm_map.json")
    if os.path.exists(own):
        return own
    W, S, E, N = bbox
    for lj in sorted(glob.glob(os.path.join(HERE, "levels", "*", "level.json"))):
        c = os.path.join(os.path.dirname(lj), "osm_map.json")
        if not os.path.exists(c):
            continue
        b = json.load(open(lj)).get("bbox")
        if b and b[0] <= W and b[1] <= S and b[2] >= E and b[3] >= N:
            return c
    return None


def stitch(ways):
    """join open member ways (lists of (lat, lon) keys) into rings by matching end points"""
    ways = [list(w) for w in ways if len(w) > 1]
    rings = []
    while ways:
        ring = ways.pop(0)
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == ring[-1]: ring += w[1:]
                elif w[-1] == ring[-1]: ring += w[::-1][1:]
                elif w[-1] == ring[0]: ring = w[:-1] + ring
                elif w[0] == ring[0]: ring = w[::-1][:-1] + ring
                else: continue
                ways.pop(i); changed = True; break
        rings.append(ring)
    return rings


def simplify(pts, tol):
    """Douglas-Peucker on an (n, 2) array"""
    if len(pts) < 3 or tol <= 0:
        return pts
    keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        d = q - p; L = math.hypot(*d)
        seg = pts[a + 1:b] - p
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L > 1e-9 else np.hypot(seg[:, 0], seg[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = a + 1 + k; keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--no-buildings", action="store_true")
    a = ap.parse_args()
    out = os.path.join(HERE, "levels", a.name)
    level = json.load(open(os.path.join(out, "level.json")))
    bbox = level["bbox"]; W, S, E, N = bbox
    lat0, lon0 = level["origin"]["lat"], level["origin"]["lon"]
    origin = geo_to_ecef(lat0, lon0, 0.0)
    R = MT.enu_basis(lat0, lon0)

    def to_xz(geom):
        """[{lat, lon}, ...] -> (n, 2) array of level (x, z)"""
        en = np.array([(R @ (geo_to_ecef(g["lat"], g["lon"], 0.0) - origin))[:2] for g in geom])
        return np.column_stack([en[:, 0], -en[:, 1]])

    cache = find_cache(a.name, bbox)
    if cache is None:
        cache = os.path.join(out, "osm_map.json")
        fetch(bbox, cache, not a.no_buildings)
    else:
        print(f"osm: cached {cache}")
    raw_mb = os.path.getsize(cache) / 1e6
    osm = json.load(open(cache))
    ex = level["extent"]; pad = 60.0
    bx0, bx1, bz0, bz1 = ex["minX"] - pad, ex["maxX"] + pad, ex["minZ"] - pad, ex["maxZ"] + pad

    def inside(p):   # any point within the padded level box
        return bool(np.any((p[:, 0] >= bx0) & (p[:, 0] <= bx1) & (p[:, 1] >= bz0) & (p[:, 1] <= bz1)))

    flat = lambda p: [round(float(v), 1) for v in p.reshape(-1)]
    names, name_id = [], {}

    def nid(n):
        if not n:
            return -1
        if n not in name_id:
            name_id[n] = len(names); names.append(n)
        return name_id[n]

    roads, rail, water, parks, buildings, places = [], [], [], [], [], []

    def area_rings(el):
        """way or multipolygon relation -> list of rings (outer first, then inner)"""
        if el["type"] == "way":
            return [to_xz(el["geometry"])] if el.get("geometry") else []
        key = lambda g: (round(g["lat"], 7), round(g["lon"], 7))
        rings = []
        for role in ("outer", "inner"):
            mem = [[key(g) for g in m["geometry"]] for m in el.get("members", [])
                   if m.get("role") == role and m.get("geometry")]
            rings += [to_xz([{"lat": la, "lon": lo} for la, lo in r]) for r in stitch(mem)]
        return [r for r in rings if len(r) > 2]

    for el in osm.get("elements", []):
        t = el.get("tags")
        if el["type"] == "way" and not t and el.get("geometry"):     # out skel: building
            if a.no_buildings or raw_mb > MAX_BUILDINGS_MB:
                continue
            p = to_xz(el["geometry"])
            if len(p) > 2 and inside(p):
                buildings.append(flat(simplify(p, 0.5)))
            continue
        t = t or {}
        if "center" in el or el["type"] == "node":                   # out center: places / landmarks
            c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
            if c.get("lat") is None or not t.get("name"):
                continue
            p = to_xz([c])
            kind = t["place"] if t.get("place") in PLACE_KINDS else "landmark"
            if kind == "landmark" and (t.get("memorial") in ("stolperstein", "plaque", "stele")
                                       or t.get("memorial:type") == "stolperstein"):
                continue                 # thousands of small plaques: not landmarks
            far = 1500.0 if kind != "landmark" else 0.0   # quarters: their node may lie outside a small level
            if not (bx0 - far <= p[0, 0] <= bx1 + far and bz0 - far <= p[0, 1] <= bz1 + far):
                continue
            places.append([kind, t["name"], round(float(p[0, 0]), 1), round(float(p[0, 1]), 1)])
            continue
        if "highway" in t and el["type"] == "way" and el.get("geometry"):
            hw = t["highway"]
            if hw not in ROAD_WIDTH and hw not in PATH_WIDTH and hw not in ("living_street", "track", "bridleway"):
                continue
            if t.get("area") == "yes" and hw != "pedestrian":
                continue
            p = to_xz(el["geometry"])
            if inside(p):
                tun = t.get("tunnel", "no") not in ("no",) or t.get("layer", "0").startswith("-")
                roads.append([hw, nid(t.get("name", "")), 1 if tun else 0, flat(simplify(p, 0.3))])
        elif "railway" in t and el["type"] == "way" and el.get("geometry"):
            if t.get("tunnel", "no") != "no":
                continue
            p = to_xz(el["geometry"])
            if inside(p):
                rail.append([t["railway"], flat(simplify(p, 0.5))])
        elif t.get("natural") == "water" or t.get("waterway") == "riverbank" or t.get("leisure") == "park":
            rings = [r for r in area_rings(el)]
            if not rings or not any(inside(r) for r in rings):
                continue
            (parks if t.get("leisure") == "park" else water).append([flat(simplify(r, 0.5)) for r in rings])

    # draw order: footways first, big roads on top
    order = {k: i for i, k in enumerate(("footway", "path", "steps", "cycleway", "pedestrian", "track",
                                          "bridleway", "service", "living_street", "unclassified",
                                          "residential", "tertiary_link", "secondary_link", "primary_link",
                                          "trunk_link", "motorway_link", "tertiary", "secondary", "primary",
                                          "trunk", "motorway"))}
    roads.sort(key=lambda r: (-r[2], order.get(r[0], 0)))
    if raw_mb > MAX_BUILDINGS_MB and not a.no_buildings:
        print(f"buildings skipped: raw response {raw_mb:.0f} MB > {MAX_BUILDINGS_MB} MB")
    doc = {
        "level": a.name, "frame": "level x = east, z = -north (metres)",
        "extent": ex, "attribution": "© OpenStreetMap contributors (ODbL)",
        "names": names, "roads": roads, "rail": rail, "water": water, "parks": parks,
        "buildings": buildings, "places": places,
        "format": {"roads": "[highway, nameIndex (-1 none), tunnel 0/1, [x, z, ...]]",
                   "rail": "[railway, [x, z, ...]]",
                   "water/parks": "[[ring x, z, ...], ...] even-odd",
                   "buildings": "[x, z, ...] closed ring",
                   "places": "[kind, name, x, z]"},
    }
    path = os.path.join(out, "map.json")
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{path}: {os.path.getsize(path) / 1e6:.2f} MB - {len(roads)} roads ({len(names)} names), "
          f"{len(rail)} rail, {len(water)} water, {len(parks)} parks, {len(buildings)} buildings, "
          f"{len(places)} places")


if __name__ == "__main__":
    main()

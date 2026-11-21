#!/usr/bin/env python3
"""Easter egg data: the Stadtbahn viaduct as a drivable route (js/sbahn.js).

  levels/<name>/sbahn.json : route (reference S-Bahn track, 2 m steps, level frame),
                             corridor (left / right offset of the viaduct deck per
                             station), deck height profile, secret entrances (one door
                             per station, ENTRANCES), exits

Frame as in build_stream.py: ENU around level.json["origin"], x = east, z = -north.

Sources (local only, no network):
  - OSM rail ways from levels/<name>/osm_map.json (the build_map.py cache):
    railway=light_rail / rail on the viaduct (bridge or layer >= 1, no tunnel);
  - the mesh tiles of the streamed level (tiles.json, L1 finest) rasterised from
    above (build_level.raster_top) for the deck height along the route.

Deck height: per station the mesh top sampled on each OSM track (platform shelters
cover the platforms, not the rails), median per track, then the 2nd lowest track
(a parked train raises one, a gap drops one). Under a train shed the mesh top is
the roof (the photos never saw the tracks): stretches more than ROOF_DZ off a
100 m running median are bridged by straight lines between the open deck on both
sides, then smoothed. The game probes
the mesh only within a narrow band around this profile, so the roof is never hit.

  python3 racing/build_sbahn.py --name mitte_all       # ~3 min (mesh rasterising)
  python3 racing/build_sbahn.py --name mitte_all --png # + debug plots in levels/<name>/
"""
import argparse, heapq, json, math, os, sys, time
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)
import merge_tiles as MT                 # noqa: E402
from merge_hybrid import geo_to_ecef     # noqa: E402
from build_level import raster_top       # noqa: E402

# ---- definitions (lon, lat) ----
# Route ends (snapped to the reference S-Bahn track): east of Jannowitzbruecke (the
# level's east edge 13.4290 E is ~330 m further) and just before the Hauptbahnhof
# hall roof (the west edge 13.3640 E is ~500 m further).
ROUTE_EAST = (13.4240, 52.51245)
ROUTE_WEST = (13.37146, 52.52524)   # 10 m before the Hauptbahnhof hall roof
# The secret door: the S-Bahn entrance "Brueckenstrasse" of Jannowitzbruecke in the
# viaduct's south face at the north end of the bridge (OSM railway=train_station_entrance
# 13.41826 E 52.51450 N). The owner's note gave 52.51343 N 13.41822 E: same longitude,
# but that point is ~120 m south across the Spree in a courtyard of Rolandufer.
ENTRANCE = {"id": "sbahn-jannowitzbruecke", "name": "Jannowitzbrücke",
            "lonlat": (13.41826, 52.51450)}
# More doors, one per station on the route (OSM entrance nodes on the station building,
# local extract). `in`: compass bearing (deg) into the building, perpendicular to the wall
# face at the door (walls.bin / OSM outline); without it (Jannowitzbruecke) the direction
# toward the deck's middle. The bear lifts the car onto the open deck nearest the door's
# point of the route (not under a station hall roof: the camera sees the set-down);
# `lift: "west-end"` = at the route's west end facing east (Hauptbahnhof).
ENTRANCES = [
    ENTRANCE,
    # node 3733305310, train_station_entrance + S sign, NE facade toward the Alexanderplatz square
    {"id": "sbahn-alexanderplatz", "name": "Alexanderplatz", "lonlat": (13.411870, 52.521329), "in": 225.0},
    # node 610319158, S sign, north facade (east end) toward the Hackescher Markt square / tram stop
    {"id": "sbahn-hackescher-markt", "name": "Hackescher Markt", "lonlat": (13.403288, 52.522954), "in": 159.0},
    # north facade (Reichstagufer side) of the station building way 20144872, 2.5 m from entrance node
    # 11034242431 (entrance=yes, access=yes, level 0); door_sides 2026-11-21 (the 2026-11-21 morning pick
    # had landed on the NH hotel way 65598154 across Friedrichstrasse). Before: node 2601268812 "Eingang
    # zum Hauptgebaeude" (DB) on Georgenstrasse (13.387520, 52.519920, in 11) - clutter at its zone.
    {"id": "sbahn-friedrichstrasse", "name": "Friedrichstraße", "lonlat": (13.386402, 52.520670), "in": 198.4},
    # node 2739626375 "Eingang Washingtonplatz" (entrance=main), south facade of the north-south building
    {"id": "sbahn-hauptbahnhof", "name": "Hauptbahnhof", "lonlat": (13.369911, 52.524367), "in": 0.0,
     "lift": "west-end"},
]
# The station building each door must be on (owner 2026-11-21: the Friedrichstrasse door had been moved
# onto the NH hotel across Friedrichstrasse). OSM ways / relations of the local extract; `footprints` in
# sbahn.json (--footprints --pbf) keeps their outlines + entrance nodes in the level frame, and
# check_doors() fails the build when a door is not on its own station's footprint.
STATION_BUILDING = {
    "sbahn-jannowitzbruecke": "w345162606",    # building=station (the hall on the viaduct at Brueckenstrasse)
    "sbahn-alexanderplatz": "w20144781",       # building=train_station "Bahnhof Alexanderplatz"
    "sbahn-hackescher-markt": "w170063224",    # building=train_station "S-Bahnhof Hackescher Markt"
    "sbahn-friedrichstrasse": "w20144872",     # building=train_station Georgenstr. 14-18 (Bahnhof Berlin Friedrichstrasse)
    "sbahn-hauptbahnhof": "r3600565",          # building=train_station "Berlin Hauptbahnhof"
}
FOOT_DOOR = 1.5     # m: the door point at most this far from the footprint outline (or inside it)
FOOT_ROLL = 1.5     # m: the roll-in end (10 m in) inside the footprint, or at most this far from it
FOOT_ENT = 4.0      # m: a door face point this close to an OSM entrance node of the station counts as that entrance
DOOR_ENT_BONUS = 40.0   # cost bonus for a door at a real OSM entrance node (door_sides)

LIFT_END = 32.0     # m before the west end (the end exit strip is the last 14 m)
OPEN_CLEAR = 3      # samples (6 m) of open deck on both sides of a lift point
# Exits: a marked spot on the track in the station (at `lonlat`, snapped onto the
# nearest S-Bahn track) -> the bear sets the car down on the street at `street`
# (lon, lat, bearing deg). `end`: route end - the exit spans the whole deck.
EXITS = [
    {"id": "sbahn-exit-jannowitzbruecke", "name": "Jannowitzbrücke", "end": "east",
     "street": (13.41760, 52.51462, 200.0)},
    {"id": "sbahn-exit-alexanderplatz", "name": "Alexanderplatz", "lonlat": (13.41120, 52.52150),
     "street": (13.41250, 52.52175, 120.0)},
    {"id": "sbahn-exit-hackescher-markt", "name": "Hackescher Markt", "lonlat": (13.40234, 52.52268),
     "street": (13.40235, 52.52230, 270.0)},
    {"id": "sbahn-exit-friedrichstrasse", "name": "Friedrichstraße", "lonlat": (13.38682, 52.52050),
     "street": (13.38800, 52.52030, 180.0)},
    {"id": "sbahn-exit-hauptbahnhof", "name": "Hauptbahnhof", "end": "west",
     "street": (13.37055, 52.52385, 160.0)},   # Washingtonplatz, south of the hall
]

STEP = 2.0          # m, route sampling
TRACK_HALF = 2.4    # m, deck beyond the outermost track centre line
MAX_OFF = 30.0      # m, tracks further from the reference are not this viaduct
CELL = 0.5          # m, mesh top raster
ROOF_DZ = 1.5       # m off the deck baseline -> roof / shelter / train / gap: bridged
SMOOTH = 6.0        # m, sigma of the final height smoothing

# "Runter von den Gleisen" (js/sbahn.js bail(), key G / the bear button): checked street spots
# along the whole route; the game takes the one nearest to the car. Candidates = lane centres of
# the drivable OSM surface roads (audit_roads.roads / lane_offsets, osm_semantic.ROAD_WIDTH), every
# BAIL_SAMPLE m; one spot per BAIL_EVERY m of route (the cheapest candidate near that route point).
BAIL_EVERY = 25.0        # m of route per spot
BAIL_REACH = 150.0       # m, farthest candidate from its route point
BAIL_SAMPLE = 3.0        # m between candidates along a lane
BAIL_CAR = (2.25, 0.91)  # m, half length / width of the car box (js/vehicle.js car 4.495 x 1.81)
BAIL_BUS = (6.35, 1.25)  # m, the bus (12.7 x 2.5): preferred, not required
BAIL_CLEAR = 0.8         # m, car box to the nearest wall / obstacle face / trunk
BAIL_BUS_CLEAR = 0.3     # m, the same for the bus box
BAIL_DECK = 6.0          # m beyond the corridor edge: not under the viaduct deck
BAIL_RAIL = 9.0          # m from every viaduct track centre line (also beyond the route ends)
BAIL_DOOR = 3.5 + 8.0 + 4.0   # m from a door zone centre: its radius + the 8 m re-arm + 4 m
BAIL_WATER = 4.0         # m to the OSM water mask
BAIL_BLD = 1.0           # m around the car box free of every OSM building / part / man_made=bridge
BAIL_EDGE = 25.0         # m from the level border
BAIL_TUBE = 15.0         # m from a road tunnel tube (tunnels.json: portals, ramps)
BAIL_PIT = 10.0          # m around a pit window
BAIL_NODRIVE = 6.0       # m outside the memorial (js/nodrive.js NO_DRIVE)
BAIL_FLAT = 0.5          # m, street height model spread under the car box
BAIL_COST = {"service": 15.0, "living_street": 5.0}   # m extra carry: prefer real streets

# "Tiefgarage" (spatial joke, js/sbahn.js portal): the underground-garage entrance on Am
# Friedrichshain (OSM node 2971353420 amenity=parking_entrance parking=underground, the driveway
# "Am Schweizer Garten" way 293528464 ends there). A line across the driveway at the entrance node
# (PORTAL_IN m past it): the game takes over, the car rolls on PORTAL_ROLL m along the driveway axis
# and sinks PORTAL_DROP m down the ramp until it is gone (the apartment facade ahead is ~12.5 m past
# the node; walls.bin / clutter.bin leave the driveway and the mouth free: nearest wall face 3.8 m,
# nearest obstacle outline 1.8 m from the centre line), a short black blink, then the car is on the
# open S-Bahn deck just east of the Friedrichstrasse hall, rolling east (the long ride: 3 km to
# Jannowitzbruecke), the hall roof right behind it.
PORTAL = {"id": "tiefgarage", "name": "Tiefgarage Am Friedrichshain",
          "node": (13.4271242, 52.5286101), "from": (13.4271700, 52.5285810)}   # entrance node, previous driveway node
PORTAL_IN = 0.0       # m past the entrance node along the driveway (the roll-in starts here)
PORTAL_HALF = 3.0     # m, half width of the trigger line
PORTAL_ROLL = 10.0    # m of roll-in past the line
PORTAL_DROP = 3.5     # m the car sinks over the roll-in (down the ramp, out of sight)
PORTAL_S = 3065.0     # m of route: open deck east of the Friedrichstrasse hall roof (3090-3240), heading east
PORTAL_CLEAR = 100.0  # m ahead (east) that must be open deck

# Station lifts (owner 2026-11-21: "a grey platform instead" of the bear): per station door one
# lift with two stops, a grey slab on the street and one on the deck beside the tracks (js/sbahn.js:
# drive onto a slab, the platform carries the car up / down, it rolls off). Street stops come from the
# checked `bailouts` spots (free of walls / clutter / water / outlines, off the deck): the one near
# the door with the shortest sideways ride, then checked on the L1 mesh (open sky over the slab).
LIFT_LEN, LIFT_LEN_BUS, LIFT_W = 8.0, 14.0, 4.5   # m, slab length (car / where the bus fits) and width
LIFT_REACH = 260.0     # m from the door for a street stop (Hauptbahnhof: the door is ~170 m from the open deck)
LIFT_SIDE_MAX = 40.0   # m, longest sideways ride
LIFT_EDGE_IN = 2.7     # m from the corridor edge to the deck slab centre (beside the tracks)
LIFT_OPEN = 4          # samples (8 m) of open deck (no roof) on both sides of the deck slab
LIFT_END_GAP = 12.0    # m from the end exit strips
LIFT_OFF = (7.0, 25.0) # m outside the corridor edge for the street slab centre


def frame(level):
    lat0, lon0 = level["origin"]["lat"], level["origin"]["lon"]
    O = geo_to_ecef(lat0, lon0, 0.0)
    R = MT.enu_basis(lat0, lon0)

    def to_xz(lon, lat):
        v = R @ (geo_to_ecef(lat, lon, 0.0) - O)
        return float(v[0]), float(-v[1])
    return to_xz


def viaduct_ways(osm):
    """railway=light_rail / rail on the viaduct (not in a tunnel, layer >= 1 or bridge)"""
    out = []
    for e in osm["elements"]:
        t = e.get("tags") or {}
        if e["type"] != "way" or t.get("railway") not in ("light_rail", "rail"):
            continue
        if t.get("tunnel") or t.get("location") == "underground":
            continue
        try:
            layer = float(t.get("layer", "0").split(";")[0])
        except ValueError:
            layer = 0
        if layer < 1 and not t.get("bridge"):
            continue
        out.append(e)
    return out


def ref_path(ways, to_xz, a, b):
    """shortest path over S-Bahn main tracks (light_rail, no service) from a to b"""
    adj, pos = {}, {}
    for e in ways:
        t = e["tags"]
        if t["railway"] != "light_rail" or t.get("service"):
            continue
        nd = e["nodes"]
        for k, g in enumerate(e["geometry"]):
            pos[nd[k]] = to_xz(g["lon"], g["lat"])
        for u, v in zip(nd, nd[1:]):
            d = math.dist(pos[u], pos[v])
            adj.setdefault(u, []).append((v, d)); adj.setdefault(v, []).append((u, d))
    # each S-Bahn track is its own graph (crossovers carry `service`): start on the
    # track nearest to a, end at the node of that same track nearest to b
    pa, pb = to_xz(*a), to_xz(*b)
    na = min(adj, key=lambda n: math.dist(pos[n], pa))
    dist, prev, q = {na: 0.0}, {}, [(0.0, na)]
    while q:
        d, u = heapq.heappop(q)
        if d > dist.get(u, 1e18):
            continue
        for v, w in adj[u]:
            if d + w < dist.get(v, 1e18):
                dist[v] = d + w; prev[v] = u; heapq.heappush(q, (d + w, v))
    # nodes are sparse on long ways: go to the node beyond b, then cut at b on the line
    far = max(dist, key=lambda n: np.dot(np.subtract(pos[n], pa), np.subtract(pb, pa)))
    path = [far]
    while path[-1] != na:
        path.append(prev[path[-1]])
    P, s = resample(np.array([pos[n] for n in reversed(path)]), 0.5)
    ia, ib = (int(np.argmin(np.hypot(*(P - p).T))) for p in (pa, pb))
    if min(np.hypot(*(P - pb).T)) > 60 or ib <= ia:
        sys.exit("no S-Bahn track path between the route ends")
    return P[ia:ib + 1]


def resample(P, step):
    seg = np.hypot(*np.diff(P, axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    t = np.arange(0, s[-1] + 1e-6, step)
    return np.c_[np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], t


def normals(P):
    d = np.gradient(P, axis=0)
    d /= np.hypot(d[:, 0], d[:, 1])[:, None]
    return d, np.c_[-d[:, 1], d[:, 0]]     # tangent, left normal (x, z frame: left of travel)


def offsets(P, N, ways, to_xz):
    """per sample: lateral offsets (along N) where the perpendicular cuts a viaduct track"""
    segs = []
    for e in ways:
        q = np.array([to_xz(g["lon"], g["lat"]) for g in e["geometry"]])
        segs.append(np.c_[q[:-1], q[1:]])
    S = np.concatenate(segs)                       # x0 z0 x1 z1
    lo = np.full(len(P), np.nan); hi = np.full(len(P), np.nan); allo = []
    for i, (p, n) in enumerate(zip(P, N)):
        # line p + t n  vs  segment a + u (b - a)
        a, b = S[:, :2], S[:, 2:]
        d = b - a
        den = n[0] * d[:, 1] - n[1] * d[:, 0]
        ok = np.abs(den) > 1e-9
        w = a - p
        t = np.where(ok, (w[:, 0] * d[:, 1] - w[:, 1] * d[:, 0]) / np.where(ok, den, 1), np.nan)
        u = np.where(ok, (w[:, 0] * n[1] - w[:, 1] * n[0]) / np.where(ok, den, 1), np.nan)
        hit = ok & (u >= 0) & (u <= 1) & (np.abs(t) <= MAX_OFF)
        allo.append(np.sort(t[hit]))
        if hit.any():
            lo[i], hi[i] = t[hit].min(), t[hit].max()
    return lo, hi, allo


def tiles_near(tiles, P, margin):
    rows = []
    for r in tiles["tiles"]:
        if r[1] != 1:
            continue
        d = np.hypot(P[:, 0] - r[3], P[:, 1] - r[5]).min()
        if d < r[6] + margin:
            rows.append(r)
    return rows


def prims_of(row, base):
    gj, bn = MT.gltf_from_b3dm(open(os.path.join(base, row[0]), "rb").read())
    nw = MT.node_world_matrices(gj)
    M = np.eye(4); M[:3] = np.array(row[7:19], float).reshape(3, 4)
    out = []
    for ni, n in enumerate(gj.get("nodes", [])):
        if "mesh" not in n:
            continue
        for p in gj["meshes"][n["mesh"]]["primitives"]:
            pos = MT.read_accessor(gj, bn, p["attributes"]["POSITION"]).astype(np.float64)
            w = ((M @ nw[ni]) @ np.c_[pos, np.ones(len(pos))].T).T[:, :3]
            idx = (MT.read_accessor(gj, bn, p["indices"]).reshape(-1).astype(np.uint32)
                   if "indices" in p else np.arange(len(pos), dtype=np.uint32))
            out.append({"pos": w.astype(np.float32), "idx": idx})
    return out


def portal_entry(doc, to_xz):
    """sbahn.json `portal`: the trigger line + roll-in on the street, the landing pose on the deck"""
    n = np.array(to_xz(*PORTAL["node"])); f = np.array(to_xz(*PORTAL["from"]))
    u = (n - f) / np.hypot(*(n - f))
    c = n + u * PORTAL_IN
    roll = c + u * PORTAL_ROLL
    step = doc["step"]
    k = int(round(PORTAL_S / step))
    k0 = int(round((PORTAL_S - PORTAL_CLEAR) / step))
    if any(doc["roof"][k0:k + 2]):
        sys.exit(f"tiefgarage: roof / bridged deck within {PORTAL_CLEAR:.0f} m ahead of s {PORTAL_S}")
    edge = next((j * step for j in range(k, len(doc["roof"])) if doc["roof"][j]), None)   # hall roof behind the car
    nx, nz = doc["nx"][k], doc["nz"][k]
    h = math.atan2(nz, nx) + math.pi                            # route forward is west: + pi = east
    tx, tz = doc["x"][k], doc["z"][k]
    ex = min(math.hypot(tx - e["x"], tz - e["z"]) - e.get("r", 0) for e in doc["exits"] if not e.get("end"))
    if ex < 15:
        sys.exit(f"tiefgarage: the landing is only {ex:.1f} m from an exit disc")
    lifts = [math.hypot(tx - D["lift"]["x"], tz - D["lift"]["z"]) for D in doc["entrances"]]
    ahead = [e for e in doc["exits"] if not e.get("end") and e["s0"] < PORTAL_S]
    print(f"tiefgarage: line at {c.round(2)} across the driveway ({math.degrees(math.atan2(u[0], -u[1])) % 360:.0f} deg in), "
          f"roll-in {PORTAL_ROLL:.0f} m to {roll.round(2)}, sinking {PORTAL_DROP} m; landing s {PORTAL_S:.0f} ({tx:.1f}, {tz:.1f}) "
          f"y {doc['deck'][k]:.2f} heading {math.degrees(h) % 360:.0f} deg (east), hall roof edge {edge - PORTAL_S:.0f} m behind, "
          f"open deck {PORTAL_CLEAR:.0f} m ahead, nearest exit disc {ex:.1f} m, nearest door set-down point {min(lifts):.1f} m, "
          f"next exit ahead {ahead[-1]['name'] if ahead else '-'}")
    lon, lat = PORTAL["node"]
    return {"id": PORTAL["id"], "name": PORTAL["name"], "lon": lon, "lat": lat,
            "x": round(float(c[0]), 2), "z": round(float(c[1]), 2), "ux": round(float(u[0]), 4), "uz": round(float(u[1]), 4),
            "half": PORTAL_HALF, "roll": [round(float(roll[0]), 2), round(float(roll[1]), 2)], "drop": PORTAL_DROP,
            "to": {"x": round(float(tx), 2), "z": round(float(tz), 2), "h": round(float(math.atan2(math.sin(h), math.cos(h))), 4),
                   "y": round(float(doc["deck"][k]), 2), "s": PORTAL_S},
            "vmin": 8.0, "vmax": 30.0}


# Door sides (owner 2026-11-21: "always the side that can be easily reached and is less busy with
# trees, cars, Marktstaende"): per station every viaduct face point within DOOR_WIN m of the station
# (both sides, every DOOR_STEP m) is a door candidate (the first walls.bin face on the ray out from the
# track, the zone 3 m in front of it); its approach = the straight line from a drivable lane point to
# the zone (DOOR_APP_MIN..MAX m, at most DOOR_ANGLE deg off the face normal). Cost: walls / obstacle
# outlines / trunks inside the approach corridor (6 m wide for clutter and trunks, 4 m for walls) and
# obstacles + trunks within 30 m of the door. The best door per station is kept, the old one stays when
# it is as good.
DOOR_WIN, DOOR_STEP = 160.0, 4.0
DOOR_APP_MIN, DOOR_APP_MAX, DOOR_ANGLE = 12.0, 80.0, 75.0
DOOR_NEAR_W = 5.0   # cost per obstacle / trunk within 30 m of the door (busy squares, tree rows, stalls)
DOOR_S_W = 0.2      # cost per m of route away from the old door (stay at the station)
DOOR_LAT = 20.0     # m beyond the corridor edge: the viaduct arches and the station buildings beside it
DOOR_HALF_CLUTTER, DOOR_HALF_WALL = 3.0, 2.0


def mesh_ground(name, mesh_src, x, z, _cache={}):
    """mesh top around (x, z): (median over 4 x 4 m, 20th percentile of 30 x 30 m); open sky over the
    spot when the two agree (no deck, roof, arcade or crown over it)"""
    if name not in _cache:
        _cache[name] = json.load(open(os.path.join(HERE, "levels", name, "tiles.json")))
    tiles = _cache[name]
    R_, C_ = 15.0, 0.5
    x0, n0, nn = x - R_, -z - R_, int(2 * R_ / C_)
    top = np.full((nn, nn), -np.inf, np.float32)
    for r in tiles_near(tiles, np.array([[x, z]]), 20):
        t, _ = raster_top(prims_of(r, mesh_src), x0, n0, nn, nn, C_, colour=False)
        np.fmax(top, np.where(np.isfinite(t), t, -np.inf), out=top)
    top[~np.isfinite(top)] = np.nan
    c = nn // 2
    return float(np.nanmedian(top[c - 4:c + 4, c - 4:c + 4])), float(np.nanpercentile(top, 20))


DOOR_SKY = 1.5   # m: zone median mesh top at most this over the local ground (p20) = open sky


def door_sides(name, doc, mesh_src, log=print, only=None):
    """-> (entrances, report rows): every station judged by its approach corridor. Candidates are faces
    of that station's own building (sbahn.json `footprints`, STATION_BUILDING): the outline edges every
    DOOR_STEP m plus the OSM entrance nodes on it (DOOR_ENT_BONUS); `only`: judge just these door ids."""
    from types import SimpleNamespace
    from scipy.spatial import cKDTree
    import audit_roads as AR
    import build_clutter as BC
    lvd = os.path.join(HERE, "levels", name)
    lv = BC.Level(name)
    col = AR.load_colliders(SimpleNamespace(dir=lvd), os.path.join(lvd, "clutter"))
    W = col["wall"]["segs"]; wt = cKDTree((W[:, :2] + W[:, 2:]) / 2)
    opts = col["obstacle"]; ops, oid = opts["pts"], np.array([m["obj"] for m in opts["meta"]])[opts["sid"]] if len(opts["pts"]) else np.zeros(0, int)
    otree = cKDTree(ops)
    tr = col["trunk"]; ttree = tr["tree"]
    P = np.c_[doc["x"], doc["z"]]; Nr = np.c_[doc["nx"], doc["nz"]]; step = doc["step"]
    eL, eR = np.array(doc["left"]), np.array(doc["right"])
    s_ = np.arange(len(P)) * step
    # drivable lane points (surface roads), 2 m
    lanes = []
    for wid, t, mode, en in AR.roads(lv, None):
        if mode != "surface" or t.get("highway") not in ("primary", "secondary", "tertiary", "unclassified", "residential",
                                                          "living_street", "primary_link", "secondary_link", "tertiary_link", "service"):
            continue
        q = np.c_[en[:, 0], -en[:, 1]]
        if np.hypot(*(q.mean(0) - P.mean(0))) > 4000:
            continue
        _, offs = AR.lane_offsets(t, t["highway"])
        for a, b in zip(q[:-1], q[1:]):
            d = b - a; L_ = float(np.hypot(*d))
            if L_ < 0.5:
                continue
            d /= L_; nl = np.array([-d[1], d[0]])
            for u in np.arange(0, L_, 2.0):
                for o in offs:
                    lanes.append((*(a + d * u + nl * o), wid))
    lanes = np.array(lanes); ltree = cKDTree(lanes[:, :2])
    rtree = cKDTree(P)

    def seg_hits(px, pz, sg):
        d = AR.point_seg(px, pz, sg)[0]
        return d

    def corridor(A, Z):
        """counts in the straight corridor A -> Z: (walls, obstacles, trunks)"""
        v = Z - A; L_ = float(np.hypot(*v)); u = v / L_
        mid = (A + Z) / 2; R_ = L_ / 2 + 4
        nw = 0
        for j in wt.query_ball_point(mid, R_ + 6):
            x0, z0, x1, z1 = W[j]
            # wall segment vs corridor: sample the segment
            for t_ in np.linspace(0, 1, max(2, int(np.hypot(x1 - x0, z1 - z0) / 0.5) + 1)):
                p_ = np.array([x0 + (x1 - x0) * t_, z0 + (z1 - z0) * t_]) - A
                al = p_ @ u; lat = abs(p_ @ np.array([-u[1], u[0]]))
                if 0 <= al <= L_ and lat < DOOR_HALF_WALL + AR.WH:
                    nw += 1; break
        obs = set()
        for j in otree.query_ball_point(mid, R_ + 3):
            p_ = ops[j] - A; al = p_ @ u; lat = abs(p_ @ np.array([-u[1], u[0]]))
            if 0 <= al <= L_ and lat < DOOR_HALF_CLUTTER + AR.WH:
                obs.add(int(oid[j]))
        nt = 0
        for j in ttree.query_ball_point(mid, R_ + 3):
            p_ = tr["xy"][j] - A; al = p_ @ u; lat = abs(p_ @ np.array([-u[1], u[0]]))
            if -1 <= al <= L_ + 1 and lat < DOOR_HALF_CLUTTER + tr["r"][j]:
                nt += 1
        return nw, len(obs), nt

    def around(Z, r=30.0):
        o = len({int(oid[j]) for j in otree.query_ball_point(Z, r)})
        return o, len(ttree.query_ball_point(Z, r))

    def judge(door, inward):
        """best approach to a door (door point, unit inward) -> dict or None"""
        Z = door - inward * 3.0
        # the zone itself: no wall within 1.5 m (the face is 3 m away), no clutter / trunk within 3.5 m
        judge.why = ""
        if wt.query_ball_point(Z, 8) and min(AR.point_seg(Z[0], Z[1], W[wt.query_ball_point(Z, 8)])[0]) < 1.5 + AR.WH:
            judge.why = "a wall within 1.8 m of the zone"; return None
        if otree.query_ball_point(Z, 2.5) or ttree.query_ball_point(Z, 2.5):
            judge.why = "clutter / a trunk within 2.5 m of the zone"; return None
        if lv.sample(lv.water, lv.wx0, lv.wn0, lv.wcell, np.array([Z[0]]), np.array([-Z[1]]))[0]:
            judge.why = "water"; return None
        best = None
        jl = ltree.query_ball_point(Z, DOOR_APP_MAX)
        jl.sort(key=lambda j: float(np.hypot(*(lanes[j, :2] - Z))))
        for j in jl:
            if best is not None and best["walls"] + best["obst"] + best["trunks"] == 0:
                break                                       # nearest clean approach found
            A = lanes[j, :2]; v = Z - A; L_ = float(np.hypot(*v))
            if L_ < DOOR_APP_MIN:
                continue
            ang = math.degrees(math.acos(max(-1, min(1, float((v / L_) @ inward)))))
            if ang > DOOR_ANGLE:
                continue
            nw, no, nt = corridor(A, Z)
            cost = 100 * (nw + no + nt) + L_ + 0.3 * ang
            if best is None or cost < best["cost"]:
                best = {"cost": cost, "A": A, "len": L_, "ang": ang, "walls": nw, "obst": no, "trunks": nt}
        if not best:
            judge.why = "no lane point 12-70 m away within 60 deg of the face normal"
        if best:
            best["near_obst"], best["near_trunks"] = around(Z)
            best["cost"] += DOOR_NEAR_W * (best["near_obst"] + best["near_trunks"])
            wd = AR.point_seg(Z[0], Z[1], W[wt.query_ball_point(Z, 30)])[0] if wt.query_ball_point(Z, 30) else [99]
            best["zone_wall"] = float(np.min(wd))
        return best

    out, rows = [], []
    for D in doc["entrances"]:
        if only and D["id"] not in only:
            out.append((D, None, None))                 # not re-judged: kept exactly as it is
            continue
        F = doc["footprints"][D["id"]]
        door0 = np.array(D["door"]); inw0 = np.array([math.sin(D["heading"]), -math.cos(D["heading"])])
        old = judge(door0, inw0); why_old = judge.why
        off_foot = door_on_footprint(F, D["door"], D["roll"], (D["x"], D["z"]))
        if off_foot:
            old = None; why_old = f"not on the station building ({off_foot})"
            ring = np.vstack([np.array(r, float) for r in F["outer"]])
            _, k0 = rtree.query(ring.mean(0))           # cost reference: the station, not the stray door
        else:
            _, k0 = rtree.query(door0)
        ents = np.array([[n["x"], n["z"]] for n in F["entrances"]], float).reshape(-1, 2)
        # candidates: points every DOOR_STEP m on every edge of the station's own footprint (+ the OSM
        # entrance nodes projected onto their edge), inward = into the footprint; the zone 3 m out must be
        # outside it, the roll-in end 10 m in inside it (door_on_footprint)
        cands, seen = [], set()
        pts = []
        for r in F["outer"]:
            r = np.array(r, float)
            for (x0, z0), (x1, z1) in zip(r[:-1], r[1:]):
                Ls = math.hypot(x1 - x0, z1 - z0)
                if Ls < 3.0:
                    continue
                tdir = np.array([x1 - x0, z1 - z0]) / Ls; nrm = np.array([-tdir[1], tdir[0]])
                mid = np.array([x0, z0]) + tdir * Ls / 2
                if not foot_inside(F, *(mid + nrm * 0.5)):
                    nrm = -nrm                              # inward = into the station building
                us = []
                for e in ents:                              # entrance nodes near this edge: exactly there (first)
                    u = float((e - (x0, z0)) @ tdir)
                    if 1.0 <= u <= Ls - 1.0 and abs(float((e - (x0, z0)) @ nrm)) <= FOOT_ENT:
                        us.append(u)
                us += list(np.arange(1.5, Ls - 1.5 + 1e-6, DOOR_STEP))
                for u in us:
                    pts.append((np.array([x0, z0]) + tdir * u, nrm))
        for pt, nrm in pts:
            key = (round(pt[0] / 2), round(pt[1] / 2))
            if key in seen:
                continue
            seen.add(key)
            if door_on_footprint(F, pt, pt + nrm * 10.0, pt - nrm * 3.0) or foot_dist(F, *(pt - nrm * 3.0)) == 0.0:
                continue
            dm, km = rtree.query(pt)
            sd = 1 if float((pt - P[km]) @ Nr[km]) > 0 else -1
            j = judge(pt, nrm)
            if j:
                ent_d = float(np.hypot(*(ents - pt).T).min()) if len(ents) else 99.0
                j["entrance"] = ent_d <= FOOT_ENT
                j["cost"] += DOOR_S_W * abs(s_[km] - s_[k0]) - (DOOR_ENT_BONUS if j["entrance"] else 0.0)
                cands.append((j["cost"], sd, float(s_[km]), pt, nrm, j))
        def open_sky(door, inward):
            Z = door - inward * 3.0; Rl = door + inward * 10.0
            y, g = mesh_ground(name, mesh_src, float(Z[0]), float(Z[1]))
            yr, _ = mesh_ground(name, mesh_src, float(Rl[0]), float(Rl[1]))
            return (y - g <= DOOR_SKY and yr - g >= 3.0), y, g
        old_full = old                                  # its approach, even when the sky test fails (kept door)
        if old:
            okd, y_, g_ = open_sky(door0, inw0)
            if not okd:
                old = None; why_old = f"zone under something ({y_ - g_:.1f} m over the ground) or the roll-in end not covered"
        by_side, tried = {}, 0
        for c in sorted(cands, key=lambda c: c[0]):
            if c[1] in by_side or tried > 70:
                continue
            tried += 1
            okd, y_, g_ = open_sky(c[3], c[4])
            if okd:
                c[5]["y"] = y_
                by_side[c[1]] = c
        best = min(by_side.values(), key=lambda c: c[0]) if by_side else None
        keep_old = best is None or (old is not None and old["cost"] <= best[0] + 5)
        fmt = lambda j: (f"corridor {j['len']:.0f} m ({j['ang']:.0f} deg off the face normal): walls {j['walls']}, "
                         f"obstacles {j['obst']}, trunks {j['trunks']}; within 30 m: obstacles {j['near_obst']}, "
                         f"trunks {j['near_trunks']}; nearest wall to the zone {j['zone_wall']:.1f} m; "
                         f"{'at an OSM entrance node; ' if j.get('entrance') else ''}cost {j['cost']:.0f}")
        rows.append(f"{D['name']}: {len(cands)} candidates ({sum(c[1] > 0 for c in cands)} / {sum(c[1] < 0 for c in cands)} per side), sky-checked {tried}")
        rows.append(f"{D['name']}: old door ({door0[0]:.1f}, {door0[1]:.1f}): " + (fmt(old) if old else why_old))
        for sd, c in sorted(by_side.items()):
            ob = math.degrees(math.atan2(-c[4][0], c[4][1])) % 360   # outward compass bearing (x east, z = -north)
            rows.append(f"  side facing {ob:.0f} deg best: s {c[2]:.0f} door ({c[3][0]:.1f}, {c[3][1]:.1f}) {fmt(c[5])}")
        if keep_old:
            rows.append("  -> keeps the old door")
            out.append((D, None, old or old_full))
        else:
            rows.append(f"  -> MOVES to the side facing {math.degrees(math.atan2(-best[4][0], best[4][1])) % 360:.0f} deg, s {best[2]:.0f} "
                        f"({math.hypot(*(best[3] - door0)):.0f} m from the old door)")
            out.append((D, best, best[5]))
    for r in rows:
        log(r)
    return out


def doors_apply(name, doc, mesh_src, judged):
    """new `entrances` from door_sides(): moved doors get door / heading / zone / roll / y / lon-lat;
    every door gets `approach` (the straight start pose for the spot link)"""
    lvd = os.path.join(HERE, "levels", name)
    level = json.load(open(os.path.join(lvd, "level.json")))
    to_xz = frame(level)
    tiles = json.load(open(os.path.join(lvd, "tiles.json")))

    def inv(x, z):
        lon, lat = level["origin"]["lon"], level["origin"]["lat"]
        for _ in range(8):
            ax, az = to_xz(lon, lat)
            lon += (x - ax) / (111320 * math.cos(math.radians(lat))); lat -= (z - az) / 111132
        return round(lon, 6), round(lat, 6)

    ground = lambda x, z: mesh_ground(name, mesh_src, float(x), float(z))

    out = []
    for D, best, j in judged:
        E = dict(D)
        if best is not None:
            _, sd, sk_, door, inward, _ = best
            Z = door - inward * 3.0; Rl = door + inward * 10.0
            y, g20 = ground(*Z)
            E.update({"door": [round(float(door[0]), 2), round(float(door[1]), 2)],
                      "heading": round(float(math.atan2(inward[0], -inward[1])), 4),
                      "x": round(float(Z[0]), 2), "z": round(float(Z[1]), 2), "y": round(y, 2),
                      "roll": [round(float(Rl[0]), 2), round(float(Rl[1]), 2)], "moved": f"s {sk_:.0f}, {'right' if sd > 0 else 'left'} side"})
            E["lon"], E["lat"] = inv(float(door[0]), float(door[1]))
            print(f"door {D['name']}: moved to {E['door']} (zone {E['x']}, {E['z']} y {y:.2f}, local ground p20 {g20:.2f}), "
                  f"{math.hypot(door[0] - D['door'][0], door[1] - D['door'][1]):.0f} m from the old door")
        if j:
            A = j["A"]; Z = np.array([E["x"], E["z"]]); v = Z - A
            E["approach"] = {"x": round(float(A[0]), 2), "z": round(float(A[1]), 2), "h": round(float(math.atan2(v[0], -v[1])), 4),
                             "len": round(float(np.hypot(*v)), 1)}
        out.append(E)
    return out


def station_footprints(name, doc, pbf):
    """sbahn.json `footprints`: per door id the outline of its station building (STATION_BUILDING, level
    frame) + the station's OSM entrance nodes (entrance=* / railway=*_entrance within FOOT_ENT of the
    outline or inside). Local extract only: osmium extract -s simple of the doors' box (+600 m)."""
    import subprocess, tempfile
    lvd = os.path.join(HERE, "levels", name)
    to_xz = frame(json.load(open(os.path.join(lvd, "level.json"))))
    if not pbf or not os.path.exists(pbf):
        sys.exit("footprints: no OSM extract: pass --pbf <berlin-latest.osm.pbf> or set OSM_PBF")
    lon = [E["lon"] for E in doc["entrances"]]; lat = [E["lat"] for E in doc["entrances"]]
    m = 0.008
    with tempfile.TemporaryDirectory() as td:
        box, gj = os.path.join(td, "b.osm.pbf"), os.path.join(td, "b.geojsonl")
        q = dict(check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["osmium", "extract", "-b", f"{min(lon) - m},{min(lat) - m},{max(lon) + m},{max(lat) + m}",
                        pbf, "-o", box, "-O", "-s", "simple"], **q)
        subprocess.run(["osmium", "export", box, "-f", "geojsonseq", "-o", gj, "-O", "-a", "type,id"], **q)
        feats = [json.loads(l.lstrip("\x1e")) for l in open(gj) if l.strip()]
    want = {v: k for k, v in STATION_BUILDING.items()}
    out, nodes = {}, []
    for f in feats:
        p, g = f.get("properties") or {}, f.get("geometry") or {}
        ref = f"{(p.get('@type') or '?')[0]}{p.get('@id')}"
        if g.get("type") == "Point" and (p.get("entrance") or str(p.get("railway", "")).endswith("_entrance")):
            nodes.append((to_xz(*g["coordinates"][:2]), {k: v for k, v in p.items() if not k.startswith("@")}, ref))
        if ref in want and g.get("type") in ("Polygon", "MultiPolygon"):
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            out[want[ref]] = {"osm": ref, "tags": {k: v for k, v in p.items() if not k.startswith("@")},
                              "outer": [[[round(c, 2) for c in to_xz(*v[:2])] for v in pl[0]] for pl in polys],
                              "holes": [[[round(c, 2) for c in to_xz(*v[:2])] for v in r] for pl in polys for r in pl[1:]]}
    miss = [k for k in STATION_BUILDING if k not in out]
    if miss:
        sys.exit(f"footprints: station building(s) not in the extract: {', '.join(f'{k} ({STATION_BUILDING[k]})' for k in miss)}")
    for k, F in out.items():
        F["entrances"] = [{"x": round(x, 2), "z": round(z, 2), "osm": ref,
                           "tags": {t: v for t, v in tg.items() if t in ("entrance", "railway", "name", "designation", "level",
                                                                         "indoor", "operator", "ref", "door", "access")}}
                          for (x, z), tg, ref in nodes if foot_dist(F, x, z) <= FOOT_ENT]
        print(f"footprint {k}: {F['osm']} {F['tags'].get('building')} {F['tags'].get('name', F['tags'].get('wikimedia_commons', ''))}, "
              f"{sum(len(r) for r in F['outer'])} vertices, {len(F['entrances'])} entrance nodes")
    return out


def foot_inside(F, x, z):
    def pip(r):
        c = False
        for i in range(len(r)):
            (x1, z1), (x2, z2) = r[i], r[i - 1]
            if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
                c = not c
        return c
    return any(pip(r) for r in F["outer"]) and not any(pip(r) for r in F["holes"])


def foot_dist(F, x, z):
    """0 inside the footprint, else the distance to its outline (m)"""
    if foot_inside(F, x, z):
        return 0.0
    best = 1e9
    for r in F["outer"] + F["holes"]:
        a = np.array(r[:-1], float); d = np.array(r[1:], float) - a; p = np.array([x, z])
        u = np.clip(((p - a) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
        best = min(best, float(np.hypot(*(a + u[:, None] * d - p).T).min()))
    return best


def foot_edge_dist(F, x, z):
    """distance to the footprint outline (also from inside)"""
    best = 1e9
    for r in F["outer"] + F["holes"]:
        a = np.array(r[:-1], float); d = np.array(r[1:], float) - a; p = np.array([x, z])
        u = np.clip(((p - a) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
        best = min(best, float(np.hypot(*(a + u[:, None] * d - p).T).min()))
    return best


def door_on_footprint(F, door, roll, zone):
    """-> '' when the door is on this footprint, else why not"""
    dd, dr, dz = foot_dist(F, *door), foot_dist(F, *roll), foot_dist(F, *zone)
    if dd > FOOT_DOOR:
        return f"door point {dd:.1f} m off the station footprint"
    if dr > FOOT_ROLL:
        return f"roll-in end {dr:.1f} m off the station footprint"
    if dz == 0.0 and foot_edge_dist(F, *zone) > FOOT_DOOR:
        return "zone deep inside the footprint (not in front of a face)"
    return ""


def check_doors(doc, log=print):
    """hard check (owner 2026-11-21): every door is on its own station's building footprint"""
    F_ = doc.get("footprints")
    if not F_:
        sys.exit("check_doors: sbahn.json has no `footprints` (run build_sbahn.py --footprints --pbf <extract>)")
    bad = []
    for E in doc["entrances"]:
        F = F_.get(E["id"])
        if not F:
            bad.append(f"{E['name']}: no footprint"); continue
        why = door_on_footprint(F, E["door"], E["roll"], (E["x"], E["z"]))
        ent = min((math.hypot(n["x"] - E["door"][0], n["z"] - E["door"][1]) for n in F["entrances"]), default=None)
        t = F["tags"]
        log(f"check {E['name']}: door {E['door']} on {F['osm']} building={t.get('building')} "
            f"{t.get('name') or t.get('wikimedia_commons') or ''}: door {foot_dist(F, *E['door']):.1f} m, roll {foot_dist(F, *E['roll']):.1f} m "
            f"off; nearest OSM entrance node {'-' if ent is None else f'{ent:.1f} m'} -> {'OK' if not why else 'FAIL: ' + why}")
        if why:
            bad.append(f"{E['name']}: {why}")
    if bad:
        sys.exit("S-Bahn door not on its station: " + "; ".join(bad))


def carve_doors(name, doc, r=2.2, only=None):
    """open each door's doorway (zone -> door, car-wide capsule r) in walls.bin in place: wall segments
    are clipped against the capsule and a corridor record (never "inside") is added; rings unchanged.
    The same carve build_walls.py makes from `entrances` ("S-Bahn doorway"); its rebuild needs ~4 GB."""
    lvd = os.path.join(HERE, "levels", name)
    meta = json.load(open(os.path.join(lvd, "walls.json")))
    raw = open(os.path.join(lvd, meta["file"]), "rb").read()
    sc = meta["scale"]
    sec = lambda k, dt, w: np.frombuffer(raw, dt, meta[k]["count"] * w, meta[k]["offset"]).reshape(meta[k]["count"], w)
    S = sec("segments", "<i2", 4).astype(float) * sc
    RL = np.frombuffer(raw, "<i4", meta["ringLen"]["count"], meta["ringLen"]["offset"])
    RV = sec("rings", "<i2", 2)
    C = sec("corridors", "<i2", 5)
    caps = [(np.array([E["x"], E["z"]]), np.array(E["door"])) for E in doc["entrances"] if not only or E["id"] in only]
    have = {tuple(c) for c in C.tolist()}
    if only and any(tuple(np.round(np.array([*a_, *b_, r]) / sc).astype(int).tolist()) in have for a_, b_ in caps):
        sys.exit("carve_doors: that doorway is carved already")

    def in_cap(p):
        out = np.zeros(len(p), bool)
        for a, b in caps:
            d = b - a; L2 = d @ d
            u = np.clip(((p - a) @ d) / L2, 0, 1)
            out |= np.hypot(*(p - (a + u[:, None] * d)).T) < r
        return out
    lo = np.array([min(a[0], b[0]) for a, b in caps]) - r - 1; hi = np.array([max(a[0], b[0]) for a, b in caps]) + r + 1
    lz = np.array([min(a[1], b[1]) for a, b in caps]) - r - 1; hz = np.array([max(a[1], b[1]) for a, b in caps]) + r + 1
    keep, cut, added = [], 0, 0
    for x0, z0, x1, z1 in S:
        if not any((max(x0, x1) >= lo[i]) & (min(x0, x1) <= hi[i]) & (max(z0, z1) >= lz[i]) & (min(z0, z1) <= hz[i]) for i in range(len(caps))):
            keep.append((x0, z0, x1, z1)); continue
        n = max(2, int(math.hypot(x1 - x0, z1 - z0) / 0.1) + 1)
        t = np.linspace(0, 1, n); p = np.c_[x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]
        inside = in_cap(p)
        if not inside.any():
            keep.append((x0, z0, x1, z1)); continue
        cut += 1
        i = 0
        while i < n:                                   # the runs outside the capsule stay
            if inside[i]:
                i += 1; continue
            j = i
            while j + 1 < n and not inside[j + 1]:
                j += 1
            if math.hypot(*(p[j] - p[i])) >= 0.2:
                keep.append((*p[i], *p[j])); added += 1
            i = j + 1
    S2 = np.round(np.array(keep) / sc).astype("<i2")
    C2 = np.vstack([C, np.round(np.array([[*a, *b, r] for a, b in caps]) / sc).astype("<i2")])
    blobs, offs, off, data = [S2, RL, RV, C2], [], 0, b""
    for bl in blobs:
        b_ = bl.tobytes(); offs.append(off); pad = (-len(b_)) % 4; data += b_ + b"\0" * pad; off += len(b_) + pad
    tmp = os.path.join(lvd, "walls.bin.tmp")
    open(tmp, "wb").write(data)
    os.replace(tmp, os.path.join(lvd, "walls.bin"))
    meta.update({"bytes": len(data), "segments": {"offset": offs[0], "count": int(len(S2))},
                 "ringLen": {"offset": offs[1], "count": int(len(RL))}, "rings": {"offset": offs[2], "count": int(len(RV))},
                 "corridors": {"offset": offs[3], "count": int(len(C2))}})
    cv = meta.setdefault("carved", {}).setdefault("S-Bahn doorway (build_sbahn --carve-doors)", {})
    if only:
        cv.setdefault("later", []).append({"doors": list(only), "segments cut": cut})
    else:
        cv.update({"doors": len(caps), "segments cut": cut})
    tmpj = os.path.join(lvd, "walls.json.tmp")
    json.dump(meta, open(tmpj, "w"), indent=1, ensure_ascii=False)
    os.replace(tmpj, os.path.join(lvd, "walls.json"))
    print(f"walls.bin: {len(S)} -> {len(S2)} segments ({cut} cut by {len(caps)} doorways, {added} pieces kept), "
          f"corridors {len(C)} -> {len(C2)}, rings unchanged ({len(RL)})")


def lift_pads(name, doc, mesh_src):
    """sbahn.json `lifts`: one per door (entrances order): street + deck stop, ride numbers"""
    lvd = os.path.join(HERE, "levels", name)
    tiles = json.load(open(os.path.join(lvd, "tiles.json")))
    P = np.c_[doc["x"], doc["z"]]; Nr = np.c_[doc["nx"], doc["nz"]]; step = doc["step"]; L = doc["length"]
    eL, eR, roof, deck = np.array(doc["left"]), np.array(doc["right"]), np.array(doc["roof"]), np.array(doc["deck"])
    s = np.arange(len(P)) * step
    ok_k = np.array([k >= LIFT_OPEN and k < len(P) - LIFT_OPEN and not roof[k - LIFT_OPEN:k + LIFT_OPEN + 1].any()
                     and LIFT_END_GAP + 14 <= s[k] <= L - 14 - LIFT_END_GAP for k in range(len(P))])
    # deck stops: beside the tracks on both edges
    side_pts = {+1: P + Nr * (eR - LIFT_EDGE_IN)[:, None], -1: P + Nr * (eL + LIFT_EDGE_IN)[:, None]}
    Tq = np.c_[Nr[:, 1], -Nr[:, 0]]      # route tangent (west)
    # street stops: candidates on the ground beside the viaduct (LIFT_OFF m outside the corridor edge,
    # slab parallel to the deck), checked like the bailouts with the game's own data
    from types import SimpleNamespace
    from scipy.spatial import cKDTree
    import audit_roads as AR
    lvj = json.load(open(os.path.join(lvd, "level.json")))
    col = AR.load_colliders(SimpleNamespace(dir=lvd), os.path.join(lvd, "clutter"))
    WT = lvj["water"]; water = np.fromfile(os.path.join(lvd, WT["file"]), np.uint8).reshape(WT["nz"], WT["nx"])
    bj = json.load(open(os.path.join(lvd, "buildings.json")))
    braw = np.fromfile(os.path.join(lvd, bj["file"]), np.uint8)
    bld = np.unpackbits(braw.reshape(bj["nz"], (bj["nx"] + 7) // 8), axis=1)[:, :bj["nx"]]
    tj = json.load(open(os.path.join(lvd, "tunnels.json")))
    tp = np.array([(px, pz) for T in tj["tubes"] for e in T["edges"] for px, pz in zip(e["x"], e["z"])], float).reshape(-1, 2)
    tubes = cKDTree(tp) if len(tp) else None
    rtree = cKDTree(P)

    def grid_hit(grid, g, px, pz):
        i = np.floor((px - g["x0"]) / g["cell"]).astype(int); j = np.floor((-pz - g["n0"]) / g["cell"]).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < grid.shape[1]) & (j < grid.shape[0])
        return bool(grid[j[ok], i[ok]].any())

    def slab_pts(x, z, h, ln, w, m=0.0, st=1.0):
        f, l_ = np.array([math.sin(h), -math.cos(h)]), np.array([math.cos(h), math.sin(h)])
        u, v = np.meshgrid(np.arange(-ln / 2 - m, ln / 2 + m + 0.01, st), np.arange(-w / 2 - m, w / 2 + m + 0.01, st))
        return x + u.ravel() * f[0] + v.ravel() * l_[0], z + u.ravel() * f[1] + v.ravel() * l_[1]

    def clearance(x, z, h, hl, hw_):
        f, l_ = np.array([math.sin(h), -math.cos(h)]), np.array([math.cos(h), math.sin(h)])
        best = 1e9
        for kind in ("wall", "obstacle", "trunk", "rail", "tunnel"):
            c = col[kind]
            if c.get("tree") is None:
                continue
            pts = c["xy"] if kind == "trunk" else c["pts"]
            ii = c["tree"].query_ball_point([x, z], math.hypot(hl, hw_) + 5)
            if not ii:
                continue
            q = pts[ii] - (x, z)
            du, dv = np.abs(q @ f) - hl, np.abs(q @ l_) - hw_
            dist = np.hypot(np.maximum(du, 0), np.maximum(dv, 0)) + np.minimum(np.maximum(du, dv), 0)
            dist -= c["r"][ii] if kind == "trunk" else AR.WH
            best = min(best, float(dist.min()))
        return best

    def street_ok(x, z, h, ln):
        px, pz = slab_pts(x, z, h, ln, LIFT_W, m=2.0)
        _, kk = rtree.query(np.c_[px, pz])
        lat_ = ((np.c_[px, pz] - P[kk]) * Nr[kk]).sum(1)
        if ((lat_ > eL[kk] - 4.0) & (lat_ < eR[kk] + 4.0)).any():          # under / at the deck
            return False
        if grid_hit(water, WT, *slab_pts(x, z, h, ln, LIFT_W, m=3.0)):
            return False
        if grid_hit(bld, {"x0": bj["x0"], "n0": bj["n0"], "cell": bj["cell"]}, *slab_pts(x, z, h, ln, LIFT_W)):
            return False
        if any(col["on_deck"](a, b) for a, b in zip(*slab_pts(x, z, h, ln, LIFT_W, m=1.0, st=2.0))):
            return False
        if tubes is not None and tubes.query([x, z])[0] < 15:
            return False
        return clearance(x, z, h, ln / 2, LIFT_W / 2) >= 0.8

    def mesh_check(x, z, h, ln, w):
        """mesh top under the slab vs the local ground: open sky, flat; -> (ok, y, spread)"""
        rows = tiles_near(tiles, np.array([[x, z]]), 25)
        CELL_ = 0.5; R_ = 20.0
        x0, n0 = x - R_, -z - R_; nn = int(2 * R_ / CELL_)
        top = np.full((nn, nn), -np.inf, np.float32)
        for r in rows:
            t, _ = raster_top(prims_of(r, mesh_src), x0, n0, nn, nn, CELL_, colour=False)
            np.fmax(top, np.where(np.isfinite(t), t, -np.inf), out=top)
        top[~np.isfinite(top)] = np.nan
        f, l_ = np.array([math.sin(h), -math.cos(h)]), np.array([math.cos(h), math.sin(h)])
        u, v = np.meshgrid(np.arange(-ln / 2, ln / 2 + 0.01, 0.5), np.arange(-w / 2, w / 2 + 0.01, 0.5))
        px, pz = x + u.ravel() * f[0] + v.ravel() * l_[0], z + u.ravel() * f[1] + v.ravel() * l_[1]
        ii = np.floor((px - x0) / CELL_).astype(int); jj = np.floor((-pz - n0) / CELL_).astype(int)
        vals = top[np.clip(jj, 0, nn - 1), np.clip(ii, 0, nn - 1)]
        g = np.nanpercentile(top, 20)
        if not np.isfinite(vals).all():
            return False, None, None
        med = float(np.median(vals)); spread = float(np.percentile(vals, 95) - np.percentile(vals, 5))
        mesh_check.p95 = float(np.percentile(vals, 95))   # the slab top goes over this (never under the pavement)
        return bool(abs(med - g) < 0.8 and spread < 0.6), med, spread

    out, log = [], []
    for D in doc["entrances"]:
        dx, dz = D["door"]
        cands = []
        for k in np.flatnonzero(ok_k)[::2]:
            if math.hypot(P[k, 0] - dx, P[k, 1] - dz) > LIFT_REACH:
                continue
            hk = float(math.atan2(Tq[k, 0], -Tq[k, 1]))
            for sd in (1, -1):
                edge = eR[k] if sd > 0 else eL[k]
                for off in np.arange(LIFT_OFF[0], LIFT_OFF[1] + 0.01, 2.0):
                    x, z = P[k] + Nr[k] * (edge + sd * off)
                    side = float(np.hypot(*(side_pts[sd][k] - (x, z))))
                    if side > LIFT_SIDE_MAX:
                        continue
                    dd = math.hypot(x - dx, z - dz)
                    cands.append((dd + 1.5 * side, dd, {"x": round(float(x), 2), "z": round(float(z), 2), "h": round(hk, 4),
                                                         "road": f"beside the deck s {s[k]:.0f}"}, (side, int(k), sd)))
        cands.sort(key=lambda c: c[0])
        good, tried = [], 0
        for c in cands:
            q = c[2]
            if any(math.hypot(q["x"] - g[2]["x"], q["z"] - g[2]["z"]) < 3 for g in good):
                continue
            tried += 1
            if street_ok(q["x"], q["z"], q["h"], LIFT_LEN):
                q["bus"] = int(street_ok(q["x"], q["z"], q["h"], LIFT_LEN_BUS))
                good.append(c)
            if len(good) >= 8 or tried > 400:
                break
        cands = good
        pick = None
        for score, dd, q, (side, k, sd) in cands[:8]:
            ln = LIFT_LEN_BUS if q["bus"] else LIFT_LEN
            okm, y, spr = mesh_check(q["x"], q["z"], q["h"], ln, LIFT_W)
            if not okm and ln > LIFT_LEN:   # bus slab not open: try the car slab
                ln = LIFT_LEN; okm, y, spr = mesh_check(q["x"], q["z"], q["h"], ln, LIFT_W)
            log.append(f"  {D['name']}: cand {q['road']} ({q['x']:.0f}, {q['z']:.0f}) door {dd:.0f} m side {side:.0f} m "
                       f"mesh {'ok' if okm else 'no'} y {y if y is None else round(y, 2)} spread {spr if spr is None else round(spr, 2)}")
            if okm:
                pick = (dd, q, side, k, sd, ln, y, mesh_check.p95)
                break
        if not pick:
            print("\n".join(log))
            sys.exit(f"lifts: no open street stop for {D['name']} ({len(cands)} candidates)")
        dd, q, side, k, sd, ln, y, p95 = pick
        dpt = side_pts[sd][k]
        hk = math.atan2(doc["nz"][k], doc["nx"][k])                  # route forward = west
        east = s[k] > L / 2                                           # roll off toward the longer ride
        hr = math.atan2(math.sin(hk + (math.pi if east else 0)), math.cos(hk + (math.pi if east else 0)))
        ex = min(math.hypot(dpt[0] - e["x"], dpt[1] - e["z"]) for e in doc["exits"])
        out.append({"id": D["id"], "name": D["name"],
                    "street": {"x": q["x"], "z": q["z"], "h": q["h"], "y": round(y, 2), "top": round(max(y, p95) + 0.05, 2), "len": ln, "w": LIFT_W,
                               "bus": int(ln >= LIFT_LEN_BUS), "door": round(dd, 1), "road": q["road"]},
                    "deck": {"x": round(float(dpt[0]), 2), "z": round(float(dpt[1]), 2), "h": round(hr, 4),
                             "y": round(float(deck[k]), 2), "s": round(float(s[k]), 1), "len": LIFT_LEN, "w": LIFT_W,
                             "side": sd},
                    "rise": round(float(deck[k]) - y, 2), "slide": round(side, 1)})
        log.append(f"lift {D['name']}: street {q['road']} ({q['x']:.1f}, {q['z']:.1f}) y {y:.2f}, {dd:.0f} m from the door, "
                   f"slab {ln:.0f} m ({'bus fits' if ln >= LIFT_LEN_BUS else 'car only'}); deck s {s[k]:.0f} "
                   f"({dpt[0]:.1f}, {dpt[1]:.1f}) y {deck[k]:.2f} {'right' if sd > 0 else 'left'} edge, roll-off "
                   f"{'east' if east else 'west'}; rise {deck[k] - y:.1f} m, sideways {side:.1f} m; nearest old exit {ex:.0f} m")
    print("\n".join(log))
    return out


def bailout_spots(name, doc, pbf=None):
    """Drop-off spots for the "off the tracks" bear (sbahn.json `bailouts`): every check below is
    against the data the game itself uses (walls.bin, clutter.bin, water.bin, bridges.json, the pit
    windows, tunnels.json, js/nodrive.js) plus every OSM building / building:part / man_made=bridge
    outline of the local extract (viaduct arches, station halls and roofs are not walls in the game:
    the car must not be set down under them). Local data only."""
    import tempfile
    from scipy.spatial import cKDTree
    from PIL import Image, ImageDraw
    import audit_roads as AR
    import build_clutter as BC
    import build_walls as BW
    from osm_semantic import ROAD_WIDTH
    t0 = time.time()
    lv = BC.Level(name)
    L = lv.L
    ext = L["extent"]

    def en_of(lon, lat):          # vectorised lv.to_en (WGS84 -> ECEF -> ENU around the level origin)
        A, E2 = 6378137.0, 6.69437999014e-3
        la, lo = np.radians(np.asarray(lat, float)), np.radians(np.asarray(lon, float))
        Nn = A / np.sqrt(1 - E2 * np.sin(la) ** 2)
        v = np.stack([Nn * np.cos(la) * np.cos(lo), Nn * np.cos(la) * np.sin(lo), Nn * (1 - E2) * np.sin(la)], -1)
        return (v - lv.origin) @ lv.R.T                       # rows: E, N, U
    xz_of = lambda lon, lat: (lambda v: (float(v[0]), float(-v[1])))(en_of(lon, lat))

    P = np.c_[doc["x"], doc["z"]]; Nr = np.c_[doc["nx"], doc["nz"]]; Tr = np.c_[Nr[:, 1], -Nr[:, 0]]
    eL, eR, step = np.array(doc["left"]), np.array(doc["right"]), doc["step"]
    route = cKDTree(P)

    # ---- candidates: lane centres of drivable surface roads near the route ----
    C = []                                            # x, z, h, oneway, cost, way id
    names = {}
    for wid, t, mode, en in AR.roads(lv, None):
        hw = t["highway"]
        if mode != "surface" or hw not in ROAD_WIDTH or t.get("tunnel", "no") != "no" or t.get("covered", "no") != "no":
            continue
        try:
            if float(t.get("layer", "0").split(";")[0]) != 0:
                continue
        except ValueError:
            continue
        q = np.c_[en[:, 0], -en[:, 1]]
        if route.query(q, distance_upper_bound=BAIL_REACH + 60)[0].min() == np.inf:
            continue
        ow = t.get("oneway", "no")
        one = 1 if ow in ("yes", "1", "true") else -1 if ow == "-1" else 0
        _, offs = AR.lane_offsets(t, hw)
        names[wid] = t.get("name") or hw
        for a, b in zip(q[:-1], q[1:]):
            d = b - a; Ls = float(np.hypot(*d))
            if Ls < 0.5:
                continue
            d /= Ls; nl = np.array([-d[1], d[0]])
            h = math.atan2(d[0], -d[1]) + (math.pi if one < 0 else 0.0)
            for u in np.arange(BAIL_SAMPLE / 2, Ls, BAIL_SAMPLE):
                for o in offs:
                    p = a + d * u + nl * o
                    C.append((p[0], p[1], h, abs(one), BAIL_COST.get(hw, 0.0), wid))
    C = np.array(C, float)
    x, z = C[:, 0], C[:, 1]
    keep = route.query(C[:, :2], distance_upper_bound=BAIL_REACH)[0] < np.inf
    stats = {"candidates": int(keep.sum())}

    def cut(mask, why):
        nonlocal keep
        before = int(keep.sum()); keep &= mask; stats[why] = before - int(keep.sum())

    # level border
    cut((x > ext["minX"] + BAIL_EDGE) & (x < ext["maxX"] - BAIL_EDGE) & (z > ext["minZ"] + BAIL_EDGE) & (z < ext["maxZ"] - BAIL_EDGE), "border")
    # under the viaduct: inside the corridor + BAIL_DECK (where the point projects onto the route)
    _, k = route.query(C[:, :2])
    rel = C[:, :2] - P[k]
    lat_, along = (rel * Nr[k]).sum(1), (rel * Tr[k]).sum(1)
    cut(~((np.abs(along) <= step) & (lat_ > eL[k] - BAIL_DECK) & (lat_ < eR[k] + BAIL_DECK)), "under the deck")
    # every viaduct track (long-distance tracks, beyond the route ends)
    osm = json.load(open(os.path.join(lv.dir, "osm_map.json")))
    rp = []
    for e in viaduct_ways(osm):
        q = en_of([g["lon"] for g in e["geometry"]], [g["lat"] for g in e["geometry"]])
        q = np.c_[q[:, 0], -q[:, 1]]
        for a, b in zip(q[:-1], q[1:]):
            n = max(1, int(np.hypot(*(b - a)) / 1.0))
            rp.append(a + (b - a) * (np.arange(n + 1) / n)[:, None])
    rails = cKDTree(np.vstack(rp))
    cut(rails.query(C[:, :2])[0] >= BAIL_RAIL, "near a viaduct track")
    # water (dilated mask), buildings.bin (footprint + 2 m buffer) at the centre
    W = L["water"]
    wet = ndimage.binary_dilation(lv.water, iterations=int(BAIL_WATER / W["cell"]))
    cut(~lv.sample(wet, W["x0"], W["n0"], W["cell"], x, -z), "water")
    cut(~lv.sample(lv.bld, lv.bx0, lv.bn0, lv.bcell, x, -z), "building raster")
    # doors (the 8 m re-arm rule and more), memorial, pits, tunnel tubes
    doors = np.array([[D["x"], D["z"]] for D in doc["entrances"]])
    cut(np.hypot(x[:, None] - doors[:, 0], z[:, None] - doors[:, 1]).min(1) >= BAIL_DOOR, "near a door")
    src = open(os.path.join(HERE, "js", "nodrive.js")).read()
    import re
    ring = [tuple(map(float, m)) for m in re.findall(r"\[(1[0-9]\.\d+),\s*(5[0-9]\.\d+)\]", src)]
    nd = np.array([xz_of(lo, la) for lo, la in ring])
    from matplotlib.path import Path as MPath
    ndp = MPath(nd)
    ndd = np.array([AR.point_seg(px, pz, np.c_[nd[:-1], nd[1:]]) [0].min() for px, pz in zip(x, z)]) if len(nd) else np.full(len(x), 1e9)
    cut(~ndp.contains_points(C[:, :2]) & (ndd >= BAIL_NODRIVE), "memorial")
    pit_ok = np.ones(len(x), bool)
    for w in (L.get("pit") or {}).get("windows", []):
        c = w.get("cell", 1.0)
        ex0, ex1, n0_, n1_ = w["x0"] - BAIL_PIT, w["x0"] + w["nx"] * c + BAIL_PIT, w["n0"] - BAIL_PIT, w["n0"] + w["nz"] * c + BAIL_PIT
        pit_ok &= ~((x > ex0) & (x < ex1) & (-z > n0_) & (-z < n1_))
    cut(pit_ok, "pit")
    tj = json.load(open(os.path.join(lv.dir, "tunnels.json")))
    tp = np.array([(px, pz) for T in tj["tubes"] for e in T["edges"] for px, pz in zip(e["x"], e["z"])], float).reshape(-1, 2)
    if len(tp):
        cut(cKDTree(tp).query(C[:, :2])[0] >= BAIL_TUBE, "tunnel")

    # ---- car box tests on the survivors ----
    def box(xc, zc, h, hl, hw_, m=0.0, n=5):
        f, l_ = np.array([math.sin(h), -math.cos(h)]), np.array([math.cos(h), math.sin(h)])
        u, v = np.meshgrid(np.linspace(-hl - m, hl + m, n), np.linspace(-hw_ - m, hw_ + m, 3))
        return xc + u.ravel() * f[0] + v.ravel() * l_[0], zc + u.ravel() * f[1] + v.ravel() * l_[1]
    col = AR.load_colliders(lv, os.path.join(lv.dir, "clutter"))
    decks = col["decks"]

    def clearance(xc, zc, h, hl, hw_):
        """m from the box (hl x hw_ half sizes, heading h) to the nearest wall / obstacle face / trunk"""
        f, l_ = np.array([math.sin(h), -math.cos(h)]), np.array([math.cos(h), math.sin(h)])
        best = 1e9
        R_ = math.hypot(hl, hw_) + 4.0
        for kind in ("wall", "obstacle", "trunk", "rail", "tunnel"):
            c = col[kind]
            if c.get("tree") is None:
                continue
            pts = c["xy"] if kind == "trunk" else c["pts"]
            ii = c["tree"].query_ball_point([xc, zc], R_ + (1.0 if kind == "trunk" else 0.0))
            if not ii:
                continue
            q = pts[ii] - (xc, zc)
            du, dv = np.abs(q @ f) - hl, np.abs(q @ l_) - hw_
            dist = np.hypot(np.maximum(du, 0), np.maximum(dv, 0)) + np.minimum(np.maximum(du, dv), 0)
            dist -= c["r"][ii] if kind == "trunk" else AR.WH
            best = min(best, float(dist.min()))
        return best

    # OSM outlines (all buildings, parts, bridges): rasterised at 0.5 m around the candidates
    idx = np.flatnonzero(keep)
    RC = 0.5
    bx0, bx1 = x[idx].min() - 40, x[idx].max() + 40
    bn0, bn1 = -z[idx].max() - 40, -z[idx].min() + 40
    nxr, nyr = int((bx1 - bx0) / RC) + 1, int((bn1 - bn0) / RC) + 1
    img = Image.new("L", (nxr, nyr), 0); dr = ImageDraw.Draw(img)
    pbf = pbf or BW.PBF
    nfeat = 0
    if os.path.exists(pbf):
        with tempfile.TemporaryDirectory() as td:
            feats = BW.load_osm(pbf, L["bbox"], td)
        for ft in feats:
            pr, g = ft.get("properties") or {}, ft.get("geometry") or {}
            if g.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            if not (pr.get("building") or pr.get("building:part") or pr.get("man_made") == "bridge"):
                continue
            if pr.get("building") == "no":
                continue
            for poly in BW.polys_of(g):
                for ri, rg in enumerate(poly):
                    q = en_of([p[0] for p in rg], [p[1] for p in rg])
                    pix = [((e - bx0) / RC, (bn1 - nn) / RC) for e, nn in q[:, :2]]   # row 0 = north edge
                    if len(pix) >= 3:
                        dr.polygon(pix, fill=0 if ri else 1)
            nfeat += 1
    else:
        print(f"  ({pbf} missing: OSM outline test skipped; walls.bin / buildings.bin still apply)")
    obr = ndimage.binary_dilation(np.array(img, bool), iterations=int(BAIL_BLD / RC))

    def in_outline(px, pz):
        i = np.floor((px - bx0) / RC).astype(int); j = np.floor((bn1 + pz) / RC).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < nxr) & (j < nyr)
        return (~ok) | obr[np.clip(j, 0, nyr - 1), np.clip(i, 0, nxr - 1)]

    H = L["height"]
    hg = lv.hgt.astype(np.float64)

    def street(px, pz):
        return ndimage.map_coordinates(hg, [(-np.asarray(pz) - H["n0"]) / H["cell"], (np.asarray(px) - H["x0"]) / H["cell"]],
                                       order=1, mode="nearest")
    clr = np.full(len(x), np.nan); bus = np.zeros(len(x), bool); ys = np.full(len(x), np.nan)
    why = {"OSM outline": 0, "bridge deck": 0, "uneven": 0, "colliders": 0}
    for i in idx:
        xc, zc, h = C[i, 0], C[i, 1], C[i, 2]
        bxp, bzp = box(xc, zc, h, *BAIL_CAR, m=0.0)
        if in_outline(bxp, bzp).any():
            keep[i] = False; why["OSM outline"] += 1; continue
        if any(col["on_deck"](px, pz) for px, pz in zip(*box(xc, zc, h, *BAIL_CAR, m=2.0, n=3))):
            keep[i] = False; why["bridge deck"] += 1; continue
        hv = street(bxp, bzp)
        if hv.max() - hv.min() > BAIL_FLAT:
            keep[i] = False; why["uneven"] += 1; continue
        c = clearance(xc, zc, h, *BAIL_CAR)
        if c < BAIL_CLEAR:
            keep[i] = False; why["colliders"] += 1; continue
        clr[i] = c; ys[i] = float(street([xc], [zc])[0])
        bus[i] = clearance(xc, zc, h, *BAIL_BUS) >= BAIL_BUS_CLEAR and not in_outline(*box(xc, zc, h, *BAIL_BUS)).any()
    stats.update(why)
    ok = np.flatnonzero(keep)
    if not len(ok):
        sys.exit("no drop-off candidate survived the checks")

    # ---- one spot per BAIL_EVERY m of route: cheapest candidate near that route point ----
    ctree = cKDTree(C[ok, :2])
    L_ = doc["length"]
    chosen = {}
    for sv in np.arange(0, L_ + 1e-6, BAIL_EVERY):
        kk = min(len(P) - 1, int(round(sv / step)))
        jj = ctree.query_ball_point(P[kk], BAIL_REACH)
        if not jj:
            continue
        cand = ok[jj]
        dist = np.hypot(*(C[cand, :2] - P[kk]).T)
        cost = dist + C[cand, 4] + np.where(bus[cand], 0, 20.0) - 2.0 * np.minimum(clr[cand], 3.0)
        b = int(cand[np.argmin(cost)])
        chosen.setdefault(b, []).append(float(sv))
    spots = []
    for b, ss in sorted(chosen.items(), key=lambda kv: kv[1][0]):
        spots.append({"x": round(float(C[b, 0]), 2), "z": round(float(C[b, 1]), 2), "h": round(float(C[b, 2]), 4),
                      "one": int(C[b, 3]), "y": round(float(ys[b]), 2), "s": round(ss[0], 1),
                      "clear": round(float(min(clr[b], 9.99)), 2), "bus": int(bus[b]), "road": names.get(int(C[b, 5]), "")})

    # ---- offline check: what the game picks (the spot nearest the car) along the whole deck ----
    S = np.c_[[q["x"] for q in spots], [q["z"] for q in spots]]
    st = cKDTree(S)
    probe = np.vstack([P, P + Nr * eL[:, None], P + Nr * eR[:, None]])
    dcar, jcar = st.query(probe)
    worst = int(np.argmax(dcar))
    door_d = np.hypot(S[:, None, 0] - doors[:, 0], S[:, None, 1] - doors[:, 1]).min()
    print(f"bailouts: {len(spots)} spots ({sum(q['bus'] for q in spots)} fit the bus) from {len(ok)} of "
          f"{stats['candidates']} candidates ({time.time() - t0:.0f} s; {nfeat} OSM outlines); dropped: "
          + ", ".join(f"{k} {v}" for k, v in stats.items() if k != "candidates"))
    print(f"  carry (car anywhere on the deck -> nearest spot): p50 {np.median(dcar):.0f} m, p95 "
          f"{np.percentile(dcar, 95):.0f} m, max {dcar.max():.0f} m at {probe[worst].round(0)} -> "
          f"{spots[jcar[worst]]['road']}; worst clearance {min(q['clear'] for q in spots):.2f} m, "
          f"nearest door zone {door_d:.1f} m")
    return spots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--png", action="store_true", help="debug plots")
    ap.add_argument("--dump", help="write the raw arrays (npz) here")
    ap.add_argument("--top-cache", help="npz cache of the mesh top raster (re-runs skip the rasterising)")
    ap.add_argument("--doors-only", action="store_true",
                    help="only re-judge the door sides (door_sides) and rewrite `entrances` / `entrance` (+ `approach`)")
    ap.add_argument("--dry-run", action="store_true", help="with --doors-only: report, write nothing")
    ap.add_argument("--carve-doors", action="store_true",
                    help="open the doorways of `entrances` in walls.bin in place (no 4 GB build_walls rebuild)")
    ap.add_argument("--lifts-only", action="store_true",
                    help="only (re)compute `lifts` (station platforms) into the existing sbahn.json (a few L1 tiles; everything else kept)")
    ap.add_argument("--portal-only", action="store_true",
                    help="only (re)compute `portal` (Tiefgarage) into the existing sbahn.json (seconds; everything else kept)")
    ap.add_argument("--bailouts-only", action="store_true",
                    help="only (re)compute `bailouts` into the existing sbahn.json (no mesh; everything else kept)")
    ap.add_argument("--only", nargs="+", metavar="DOOR_ID",
                    help="with --doors-only / --carve-doors: only these doors (e.g. sbahn-friedrichstrasse); the others stay as they are")
    ap.add_argument("--pbf", default=os.environ.get("OSM_PBF"), help="local OSM extract (.osm.pbf), or env OSM_PBF")
    ap.add_argument("--footprints", action="store_true",
                    help="only (re)write `footprints` (station building outlines + entrance nodes, needs --pbf) and check the doors")
    ap.add_argument("--check-doors", action="store_true", help="only check that every door is on its own station's footprint")
    a = ap.parse_args()
    lv = os.path.join(HERE, "levels", a.name)
    if a.footprints or a.check_doors:
        fp = os.path.join(lv, "sbahn.json")
        doc = json.load(open(fp))
        if a.footprints:
            doc["footprints"] = station_footprints(a.name, doc, a.pbf)
            with open(fp, "w") as f:
                json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
            print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(fp)/1e3:.0f} kB")
        check_doors(doc)
        return
    if a.carve_doors:
        doc = json.load(open(os.path.join(lv, "sbahn.json")))
        check_doors(doc)
        carve_doors(a.name, doc, only=a.only)
        return
    if a.doors_only:
        fp = os.path.join(lv, "sbahn.json")
        doc = json.load(open(fp))
        if not doc.get("footprints"):
            sys.exit("--doors-only: sbahn.json has no `footprints` (run --footprints --pbf <extract> first)")
        judged = door_sides(a.name, doc, a.mesh_src, only=a.only)
        if a.dry_run:
            return
        doc["entrances"] = doors_apply(a.name, doc, a.mesh_src, judged)
        doc["entrance"] = doc["entrances"][0]
        check_doors(doc)
        with open(fp, "w") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(fp)/1e3:.0f} kB")
        return
    if a.lifts_only:
        fp = os.path.join(lv, "sbahn.json")
        doc = json.load(open(fp))
        doc["lifts"] = lift_pads(a.name, doc, a.mesh_src)
        with open(fp, "w") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(fp)/1e3:.0f} kB")
        return
    if a.portal_only:
        fp = os.path.join(lv, "sbahn.json")
        doc = json.load(open(fp))
        doc["portal"] = portal_entry(doc, frame(json.load(open(os.path.join(lv, "level.json")))))
        with open(fp, "w") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(fp)/1e3:.0f} kB")
        return
    if a.bailouts_only:
        fp = os.path.join(lv, "sbahn.json")
        doc = json.load(open(fp))
        doc["bailouts"] = bailout_spots(a.name, doc)
        with open(fp, "w") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(fp)/1e3:.0f} kB")
        return
    level = json.load(open(os.path.join(lv, "level.json")))
    to_xz = frame(level)
    ext = level["extent"]
    osm = json.load(open(os.path.join(lv, "osm_map.json")))
    ways = viaduct_ways(osm)
    print(f"{len(ways)} viaduct rail ways")

    ref = ref_path(ways, to_xz, ROUTE_EAST, ROUTE_WEST)
    P, s = resample(ref, 1.0)
    P = ndimage.gaussian_filter1d(P, 4.0, axis=0, mode="nearest")   # crossover kinks out
    P, s = resample(P, STEP)
    T, N = normals(P)
    print(f"route {s[-1]:.0f} m, {len(P)} samples")

    lo, hi, onT = offsets(P, N, ways, to_xz)
    print(f"track offsets found at {np.isfinite(lo).mean()*100:.0f} % of the samples")

    # ---- mesh top along the corridor ----
    t0 = time.time()
    tiles = json.load(open(os.path.join(lv, "tiles.json")))
    rows = tiles_near(tiles, P, MAX_OFF + 10)
    anchors = np.array([to_xz(*e["street"][:2]) for e in EXITS] + [to_xz(*ENTRANCE["lonlat"])])
    paths = {r[0] for r in rows}
    rows += [r for r in tiles_near(tiles, anchors, 60) if r[0] not in paths]   # exit targets on the street
    allp = np.vstack([P, anchors])
    x0, x1 = allp[:, 0].min() - MAX_OFF - 30, allp[:, 0].max() + MAX_OFF + 30
    n0, n1 = -allp[:, 1].max() - MAX_OFF - 30, -allp[:, 1].min() + MAX_OFF + 30
    nx, ny = int((x1 - x0) / CELL) + 1, int((n1 - n0) / CELL) + 1
    top = None
    if a.top_cache and os.path.exists(a.top_cache):
        c = np.load(a.top_cache)
        if c["top"].shape == (ny, nx) and abs(float(c["x0"]) - x0) < 1e-6 and abs(float(c["n0"]) - n0) < 1e-6:
            top = c["top"]
    if top is None:
        top = np.full((ny, nx), -np.inf, np.float32)
        for k, r in enumerate(rows):
            t, _ = raster_top(prims_of(r, a.mesh_src), x0, n0, nx, ny, CELL, colour=False)
            np.fmax(top, np.where(np.isfinite(t), t, -np.inf), out=top)
        top[~np.isfinite(top)] = np.nan
        if a.top_cache:
            np.savez(a.top_cache, top=top, x0=x0, n0=n0)
    print(f"mesh top: {len(rows)} L1 tiles, {nx}x{ny} @ {CELL} m ({time.time()-t0:.0f} s)")
    # the other doors: their tiles go into a separate copy (top_e, used for the door zones
    # only), so the route raster - and with it the route, deck and exits - stays as it was
    eanch = np.array([to_xz(*e["lonlat"]) for e in ENTRANCES[1:]]).reshape(-1, 2)
    if len(eanch):
        if (eanch[:, 0].min() < x0 + 5 or eanch[:, 0].max() > x1 - 5
                or -eanch[:, 1].max() < n0 + 5 or -eanch[:, 1].min() > n1 - 5):
            sys.exit("an S-Bahn door lies outside the mesh top raster")
        paths = {r[0] for r in rows}
        extra = [r for r in tiles_near(tiles, eanch, 60) if r[0] not in paths]
        top_e = np.where(np.isfinite(top), top, -np.inf).astype(np.float32)
        for r in extra:
            t, _ = raster_top(prims_of(r, a.mesh_src), x0, n0, nx, ny, CELL, colour=False)
            np.fmax(top_e, np.where(np.isfinite(t), t, -np.inf), out=top_e)
        top_e[~np.isfinite(top_e)] = np.nan
        print(f"door zones: {len(extra)} more L1 tiles (separate raster)")
    else:
        top_e = top

    H = level["height"]
    hgrid = np.fromfile(os.path.join(lv, H["file"]), np.float32).reshape(H["nz"], H["nx"])

    def street(x, z):
        i = np.clip((x - H["x0"]) / H["cell"], 0, H["nx"] - 1.001)
        j = np.clip((-z - H["n0"]) / H["cell"], 0, H["nz"] - 1.001)
        return ndimage.map_coordinates(hgrid, [np.atleast_1d(j), np.atleast_1d(i)], order=1, mode="nearest")

    def top_at(x, z, src=None):
        i = ((np.asarray(x) - x0) / CELL - 0.5); j = ((-np.asarray(z) - n0) / CELL - 0.5)
        ii, jj = np.round(i).astype(int), np.round(j).astype(int)
        ok = (ii >= 0) & (jj >= 0) & (ii < nx) & (jj < ny)
        v = np.full(ii.shape, np.nan, np.float32)
        v[ok] = (top if src is None else src)[jj[ok], ii[ok]]
        return v

    if a.dump:
        np.savez_compressed(a.dump, P=P, s=s, N=N, lo=lo, hi=hi, top=top, x0=x0, n0=n0, cell=CELL,
                            street=street(P[:, 0], P[:, 1]))
        print("dumped", a.dump)

    # ---- corridor: outermost tracks + TRACK_HALF, despiked (oblique sidings / crossovers) ----
    lo = ndimage.gaussian_filter1d(ndimage.median_filter(lo, 11, mode="nearest"), 2, mode="nearest")
    hi = ndimage.gaussian_filter1d(ndimage.median_filter(hi, 11, mode="nearest"), 2, mode="nearest")
    eL = np.maximum(lo - TRACK_HALF, -MAX_OFF); eR = np.minimum(hi + TRACK_HALF, MAX_OFF)

    # ---- deck height ----
    st = street(P[:, 0], P[:, 1])
    # sampled ON the tracks (platform shelters cover the platforms, not the rails): per
    # track the median over its 1.4 m bed, then the 2nd lowest track (a parked train
    # raises one track; a gap / light well drops one)
    p30 = np.full(len(P), np.nan)
    for k in range(len(P)):
        per = []
        for t0 in onT[k]:
            o = t0 + np.arange(-0.7, 0.71, CELL)
            v = top_at(P[k, 0] + o * N[k, 0], P[k, 1] + o * N[k, 1]); v = v[np.isfinite(v)]
            if len(v) >= 2:
                per.append(np.median(v))
        per.sort()
        if per:
            p30[k] = per[1] if len(per) >= 3 else per[0]
    idx = np.arange(len(P))

    def fill(v, good):
        return np.interp(idx, idx[good], v[good])
    good = np.isfinite(p30) & (p30 - st < 12)                  # roofs sit 16-25 m above the street
    base = ndimage.median_filter(fill(p30, good), 51, mode="nearest")
    for _ in range(4):
        roof = ~np.isfinite(p30) | (np.abs(p30 - base) > ROOF_DZ)
        roof = ndimage.binary_dilation(roof, iterations=3)   # 6 m: roof edges, eaves
        base = ndimage.median_filter(fill(p30, ~roof), 51, mode="nearest")
    deck = ndimage.median_filter(fill(p30, ~roof), 9, mode="nearest")   # masts, footbridges
    deck = ndimage.gaussian_filter1d(deck, SMOOTH / STEP, mode="nearest")

    # ---- trim the corridor to the deck: where the deck is open, an edge strip whose mesh
    # lies > 2 m under the deck (the viaduct ends there) is cut off (at most 6 m per side) ----
    tl = np.zeros(len(P)); tr = np.zeros(len(P))
    for k in np.flatnonzero(~roof):
        for side, e0, sgn, outv in ((0, eL[k], 1, tl), (1, eR[k], -1, tr)):
            cut = 0.0
            for c in np.arange(0, 6.01, CELL):
                o = e0 + sgn * (c + 0.6)          # car half width inside the edge
                v = top_at([P[k, 0] + o * N[k, 0]], [P[k, 1] + o * N[k, 1]])[0]
                if np.isfinite(v) and v > deck[k] - 2.0:
                    break
                cut = c + CELL
            outv[k] = cut
    tl = ndimage.gaussian_filter1d(ndimage.maximum_filter1d(tl, 7), 1.5)
    tr = ndimage.gaussian_filter1d(ndimage.maximum_filter1d(tr, 7), 1.5)
    eL = eL + tl; eR = eR - tr
    print(f"corridor trimmed to the deck at {np.mean((tl > 0.1) | (tr > 0.1))*100:.0f} % of the samples "
          f"(max {max(tl.max(), tr.max()):.1f} m)")

    # ---- S-Bahn tracks (each its own graph component) for snapping ----
    tracks, tway = [], []
    for e in ways:
        t = e["tags"]
        if t["railway"] == "light_rail" and not t.get("service"):
            tracks.append(np.array([to_xz(g["lon"], g["lat"]) for g in e["geometry"]])); tway.append(e["nodes"])
    par = {}                                   # union-find over shared nodes: one id per physical track

    def find(u):
        while par.setdefault(u, u) != u:
            par[u] = par[par[u]]; u = par[u]
        return u
    for nd in tway:
        for v in nd[1:]:
            ra, rb = find(nd[0]), find(v)
            if ra != rb:
                par[ra] = rb
    tcomp = [find(nd[0]) for nd in tway]

    def snap_track(p):
        """nearest point on any S-Bahn track -> (x, z), distance, track index"""
        best, bd, bi = None, 1e18, -1
        for ti, q in enumerate(tracks):
            a0, d = q[:-1], np.diff(q, axis=0)
            u = np.clip(((p - a0) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
            c = a0 + u[:, None] * d
            dd = np.hypot(*(c - p).T)
            i = int(np.argmin(dd))
            if dd[i] < bd:
                bd, best, bi = dd[i], c[i], ti
        return best, bd, bi

    def project(p):
        """(index of nearest route sample, lateral offset along N)"""
        k = int(np.argmin(np.hypot(*(P - p).T)))
        return k, float(np.dot(np.subtract(p, P[k]), N[k]))

    def heading(k):        # route direction (east -> west), three.js: forward = (sin h, -cos h)
        return float(math.atan2(T[k, 0], -T[k, 1]))

    def inv(x, z):          # level frame -> lon, lat (Newton on the exact forward frame)
        lon, lat = level["origin"]["lon"], level["origin"]["lat"]
        for _ in range(8):
            ax, az = to_xz(lon, lat)
            lon += (x - ax) / (111320 * math.cos(math.radians(lat))); lat -= (z - az) / 111132
        return round(lon, 6), round(lat, 6)

    # water + buildings (exit targets, entrance zone)
    WT = level["water"]
    water = np.fromfile(os.path.join(lv, WT["file"]), np.uint8).reshape(WT["nz"], WT["nx"])

    def wet(x, z, r=0.0):
        for dx in ((-r, 0, r) if r else (0,)):
            for dz in ((-r, 0, r) if r else (0,)):
                i = int((x + dx - WT["x0"]) // WT["cell"]); j = int((-(z + dz) - WT["n0"]) // WT["cell"])
                if 0 <= i < WT["nx"] and 0 <= j < WT["nz"] and water[j, i]:
                    return True
        return False
    mp = json.load(open(os.path.join(lv, "map.json")))
    blds = [np.array(b).reshape(-1, 2) for b in mp.get("buildings", [])]
    bbox = [(b[:, 0].min(), b[:, 1].min(), b[:, 0].max(), b[:, 1].max()) for b in blds]

    def in_building(x, z):
        for b, (a0, b0, a1, b1) in zip(blds, bbox):
            if a0 <= x <= a1 and b0 <= z <= b1:
                c = False
                for i in range(len(b)):
                    (x1, z1), (x2, z2) = b[i], b[i - 1]
                    if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
                        c = not c
                if c:
                    return True
        return False

    def open_ground(x, z, half=2.5, src=None):
        """mesh top flat under a car footprint and at the local ground (not a roof / deck / object)"""
        o = np.arange(-half, half + 0.01, 0.5)
        X, Z = np.meshgrid(x + o, z + o)
        v = top_at(X.ravel(), Z.ravel(), src)
        R = np.arange(-15, 15.1, 1.0)
        X2, Z2 = np.meshgrid(x + R, z + R)
        g = top_at(X2.ravel(), Z2.ravel(), src)
        if not np.isfinite(v).all() or np.isfinite(g).sum() < 50:
            return False, None
        g20 = np.nanpercentile(g, 20)
        return bool(abs(np.median(v) - g20) < 0.6 and v.std() < 0.25), float(np.median(v))

    def off_corridor(x, z, m):
        k, d = project((x, z))
        far = np.hypot(*(P[k] - (x, z))) > MAX_OFF + 5
        return far or d < eL[k] - m or d > eR[k] + m

    # ---- the secret door ----
    ex, ez = to_xz(*ENTRANCE["lonlat"])
    ke, de = project((ex, ez))
    inward = -np.sign(de - 0.5 * (eL[ke] + eR[ke])) * N[ke]        # toward the deck's middle
    h_in = float(math.atan2(inward[0], -inward[1]))
    zone = np.array([ex, ez]) - 3.0 * inward                       # on the pavement in front of the face
    roll = np.array([ex, ez]) + 10.0 * inward                      # under the deck, out of sight
    lift, ld, lift_track = snap_track(roll)
    kl, _ = project(lift)
    zg, zy = open_ground(*zone, half=1.5)    # 3 m from the face: a smaller footprint
    entrance = {"id": ENTRANCE["id"], "kind": "sbahn-entrance", "name": ENTRANCE["name"],
                "lon": ENTRANCE["lonlat"][0], "lat": ENTRANCE["lonlat"][1],
                "x": round(float(zone[0]), 2), "z": round(float(zone[1]), 2), "r": 3.5, "y": round(zy, 2),
                "door": [round(ex, 2), round(ez, 2)], "heading": round(h_in, 4),
                "roll": [round(float(roll[0]), 2), round(float(roll[1]), 2)],
                "lift": {"x": round(float(lift[0]), 2), "z": round(float(lift[1]), 2), "h": round(heading(kl), 4),
                         "y": round(float(deck[kl]), 2), "s": round(float(s[kl]), 1)}}

    # ---- exits ----
    start_track = tcomp[lift_track]   # the car is put on this one: station exits go on another (the ride carries on)
    exits, ends = [], []
    L = float(s[-1])
    for ex_ in EXITS:
        e = {"id": ex_["id"], "kind": "sbahn-exit", "name": ex_["name"]}
        if ex_.get("end"):
            k = 4 if ex_["end"] == "east" else len(P) - 5          # 8 m before the buffer stop
            e.update({"end": ex_["end"], "s0": 0.0 if ex_["end"] == "east" else round(L - 14, 1),
                      "s1": 14.0 if ex_["end"] == "east" else round(L, 1)})
            px, pz = P[k]
        else:
            p0 = np.array(to_xz(*ex_["lonlat"]))
            cand = []
            for q, qc in zip(tracks, tcomp):
                a0, d = q[:-1], np.diff(q, axis=0)
                u = np.clip(((p0 - a0) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
                c = a0 + u[:, None] * d
                dd = np.hypot(*(c - p0).T); i = int(np.argmin(dd))
                cand.append((dd[i] + (100 if qc == start_track else 0), c[i]))
            px, pz = min(cand, key=lambda c: c[0])[1]
            k, _ = project((px, pz))
            e.update({"r": 3.0, "s0": round(float(s[k]), 1)})
        e.update({"x": round(float(px), 2), "z": round(float(pz), 2), "y": round(float(deck[k]), 2)})
        e["lon"], e["lat"] = inv(px, pz)
        # street target: nearest open ground to the anchor (not water / building / under the viaduct)
        slon, slat, sb = ex_["street"]
        ax, az = to_xz(slon, slat)
        best = None
        for r in np.arange(0, 40.1, 1.0):
            for ang in np.linspace(0, 2 * math.pi, max(1, int(2 * math.pi * r / 1.0)), endpoint=False):
                x, z = ax + r * math.cos(ang), az + r * math.sin(ang)
                if wet(x, z, 3.0) or in_building(x, z) or not off_corridor(x, z, 4.0):
                    continue
                if math.hypot(x - zone[0], z - zone[1]) < entrance["r"] + 6:
                    continue
                okg, y = open_ground(x, z)
                if okg:
                    best = (x, z, y, r)
                    break
            if best:
                break
        if not best:
            sys.exit(f"no open street ground within 40 m of the exit target of {e['name']} ({slat}, {slon})")
        x, z, y, r = best
        lon_, lat_ = inv(x, z)
        e["street"] = {"x": round(x, 2), "z": round(z, 2), "h": round(math.radians(sb), 4), "y": round(y, 2),
                       "lon": lon_, "lat": lat_, "moved": round(float(r), 1)}
        exits.append(e)

    # ---- the other doors (ENTRANCES[1:]): same sequence, lift at that station's point ----
    entrances, door_log = [entrance], []
    for D in ENTRANCES[1:]:
        dx_, dz_ = to_xz(*D["lonlat"])
        b = math.radians(D["in"])
        inw = np.array([math.sin(b), -math.cos(b)])                 # x east, z = -north
        zn = np.array([dx_, dz_]) - 3.0 * inw
        rl = np.array([dx_, dz_]) + 10.0 * inw                      # inside the station, out of sight
        okg, zy_ = open_ground(*zn, half=1.5, src=top_e)
        if not okg:      # eaves / canopies over the door (Hauptbahnhof: the roof 27 m up): the street model
            zy_ = float(street(*zn)[0])
        if D.get("lift") == "west-end":
            kd = int(np.argmin(np.abs(s - (L - LIFT_END))))
            face = math.pi                                          # back east
        else:
            kd, _ = project(rl)
            face = 0.0
            # nearest sample with open deck (no station roof) for OPEN_CLEAR samples around it
            opn = [j for j in range(OPEN_CLEAR, len(P) - OPEN_CLEAR)
                   if not roof[j - OPEN_CLEAR:j + OPEN_CLEAR + 1].any()]
            kd = min(opn, key=lambda j: abs(j - kd))
        lp, ld_, _ = snap_track(P[kd])
        kl_, _ = project(lp)
        hl = float(math.atan2(math.sin(heading(kl_) + face), math.cos(heading(kl_) + face)))
        near_exit = min(math.hypot(lp[0] - e["x"], lp[1] - e["z"]) - e.get("r", 0) for e in exits if not e.get("end"))
        in_end = any(e.get("end") and e["s0"] - 4 <= s[kl_] <= e["s1"] + 4 for e in exits)
        if near_exit < 6 or in_end:
            sys.exit(f"S-Bahn door {D['name']}: the lift point is {near_exit:.1f} m from an exit (end strip {in_end})")
        street_clear = min(math.hypot(e["street"]["x"] - zn[0], e["street"]["z"] - zn[1]) for e in exits)
        if street_clear < 3.5 + 6:
            sys.exit(f"S-Bahn door {D['name']}: an exit drop-off is only {street_clear:.1f} m from the door zone")
        entrances.append({"id": D["id"], "kind": "sbahn-entrance", "name": D["name"],
                          "lon": D["lonlat"][0], "lat": D["lonlat"][1],
                          "x": round(float(zn[0]), 2), "z": round(float(zn[1]), 2), "r": 3.5, "y": round(float(zy_), 2),
                          "door": [round(dx_, 2), round(dz_, 2)], "heading": round(float(math.atan2(inw[0], -inw[1])), 4),
                          "roll": [round(float(rl[0]), 2), round(float(rl[1]), 2)],
                          "lift": {"x": round(float(lp[0]), 2), "z": round(float(lp[1]), 2), "h": round(hl, 4),
                                   "y": round(float(deck[kl_]), 2), "s": round(float(s[kl_]), 1)}})
        door_log.append(f"door {D['name']}: door {dx_:.1f},{dz_:.1f}, zone {zn.round(1)} open ground {okg} y {zy_:.2f}, "
                        f"water {wet(*zn, 3.5)}, in a footprint {in_building(*zn)}, heading in {D['in']:.0f} deg; "
                        f"roll {rl.round(1)} top {top_at([rl[0]], [rl[1]], top_e)[0]:.1f}; lift at s {s[kl_]:.0f} "
                        f"(door projects to s {s[project((dx_, dz_))[0]]:.0f}), {math.hypot(*(lp - rl)):.0f} m from the roll "
                        f"end, y {deck[kl_]:.1f}, heading {math.degrees(hl):.0f} deg, nearest exit disc {near_exit:.1f} m, "
                        f"nearest drop-off {street_clear:.0f} m")
    for k, side in ((0, -1), (len(P) - 1, 1)):     # buffer stops: across the deck at both ends
        a0 = P[k] + N[k] * eL[k]; b0 = P[k] + N[k] * eR[k]
        ends.append({"s": round(float(s[k]), 1), "a": [round(float(a0[0]), 2), round(float(a0[1]), 2)],
                     "b": [round(float(b0[0]), 2), round(float(b0[1]), 2)], "y": round(float(deck[k]), 2),
                     "facing": side})

    # ---- walls: one closed loop around the corridor (Box2D boxes in the game) ----
    from build_level import rdp
    A = P + N * eL[:, None]; B = P + N * eR[:, None]
    loop = np.vstack([rdp(A, 0.25), rdp(B[::-1], 0.25)])

    # ---- checks ----
    on = ~roof
    dev = np.abs(p30 - deck)[on]                 # on-track mesh vs profile where the deck is open
    lowfrac = []
    for k in np.flatnonzero(on):
        o = np.arange(eL[k] + 1.0, eR[k] - 1.0 + 1e-6, 1.0)
        v = top_at(P[k, 0] + o * N[k, 0], P[k, 1] + o * N[k, 1])
        lowfrac.append(np.mean(v < deck[k] - 2.0))
    lowfrac = np.array(lowfrac)
    slope = np.abs(np.diff(deck)) / STEP * 100
    curv = np.abs(np.diff(deck, 2))
    above = deck - st
    exts = level["extent"]
    margin = min(loop[:, 0].min() - exts["minX"], exts["maxX"] - loop[:, 0].max(),
                 loop[:, 1].min() - exts["minZ"], exts["maxZ"] - loop[:, 1].max())
    roof_runs = []
    k = 0
    while k < len(roof):
        if roof[k]:
            j = k
            while j < len(roof) and roof[j]:
                j += 1
            roof_runs.append((float(s[k]), float(s[j - 1])))
            k = j
        else:
            k += 1
    print(f"deck: {deck.min():.1f}..{deck.max():.1f} m, above street p5/50/95 "
          f"{np.percentile(above, [5, 50, 95]).round(1)} m, slope max {slope.max():.2f} %, "
          f"2nd diff max {curv.max()*100:.1f} cm")
    print(f"open deck: |mesh on the tracks - profile| p50/p95/max {np.nanpercentile(dev, [50, 95, 100]).round(2)} m; "
          f"corridor cells > 2 m under the deck: mean {lowfrac.mean()*100:.1f} %, worst {lowfrac.max()*100:.0f} % "
          f"at s {s[np.flatnonzero(on)[np.argmax(lowfrac)]]:.0f}")
    print(f"bridged (roof / shelter / no mesh): {', '.join(f'{a:.0f}-{b:.0f}' for a, b in roof_runs)} m")
    print(f"corridor width {np.percentile(eR - eL, [0, 50, 100]).round(1)} m, wall loop {len(loop)} pts, "
          f"min distance to the level border {margin:.0f} m")
    print(f"entrance: door {ex:.1f},{ez:.1f}, zone {zone.round(1)} open ground {zg} y {zy}, "
          f"water {wet(*zone, 3.5)}, heading in {math.degrees(h_in):.0f} deg; roll end top "
          f"{top_at([roll[0]], [roll[1]])[0]:.1f} vs deck {deck[ke]:.1f}; lift onto the S-Bahn track "
          f"{ld:.1f} m away at s {s[kl]:.0f}, y {deck[kl]:.1f}, heading {math.degrees(heading(kl)):.0f} deg")
    ox, oz = to_xz(13.41822, 52.51343)
    print(f"  (owner's note 52.51343 N 13.41822 E is {math.hypot(ox - ex, oz - ez):.0f} m from the door)")
    for ln in door_log:
        print(ln)
    for e in exits:
        st_ = e["street"]
        print(f"exit {e['name']}: track {e['x']:.0f},{e['z']:.0f} s {e['s0']} y {e['y']:.1f} -> street "
              f"{st_['x']:.0f},{st_['z']:.0f} y {st_['y']:.1f} ({st_['lat']}, {st_['lon']}), moved {st_['moved']} m")

    rnd = lambda v, d=2: [round(float(x), d) for x in v]
    doc = {
        "about": "Stadtbahn viaduct easter egg (build_sbahn.py, js/sbahn.js). Level frame: x = east, "
                 "z = -north; route samples every `step` m from east (Jannowitzbruecke) to west "
                 "(Hauptbahnhof); n = left normal per sample; corridor = [left, right] offsets along n; "
                 "deck = track-bed height; roof = 1 where the deck is bridged (roof / no mesh); "
                 "entrances = all secret doors (entrance = the first, Jannowitzbruecke, for old readers).",
        "step": STEP, "length": round(L, 1),
        "x": rnd(P[:, 0]), "z": rnd(P[:, 1]), "nx": rnd(N[:, 0], 4), "nz": rnd(N[:, 1], 4),
        "left": rnd(eL, 2), "right": rnd(eR, 2), "deck": rnd(deck, 2), "roof": [int(v) for v in roof],
        "walls": rnd(loop.ravel(), 2),
        "entrance": entrance, "entrances": entrances, "exits": exits, "ends": ends,
        "stations": [{"name": e["name"], "s": e["s0"]} for e in exits],
    }
    doc["lifts"] = None   # filled after the bailouts (they are its street candidates)
    doc["portal"] = portal_entry(doc, to_xz)   # "Tiefgarage": spatial joke, cut to the Friedrichstrasse hall
    doc["bailouts"] = bailout_spots(a.name, doc)   # "Runter von den Gleisen": checked street spots (js/sbahn.js bail)
    doc["lifts"] = lift_pads(a.name, doc, a.mesh_src)   # station platforms (street stop from the bailouts)
    old_fp = os.path.join(lv, "sbahn.json")
    if a.pbf and os.path.exists(a.pbf):
        doc["footprints"] = station_footprints(a.name, doc, a.pbf)
    elif os.path.exists(old_fp):
        doc["footprints"] = json.load(open(old_fp)).get("footprints")
    check_doors(doc)   # every door on its own station building, else no sbahn.json
    with open(os.path.join(lv, "sbahn.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    print(f"-> {os.path.join('levels', a.name, 'sbahn.json')} {os.path.getsize(os.path.join(lv, 'sbahn.json'))/1e3:.0f} kB")
    if a.png:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        fig, ax = plt.subplots(2, 1, figsize=(20, 9))
        ax[0].plot(s, p30, lw=0.6, label="mesh top p30"); ax[0].plot(s, deck, label="deck"); ax[0].plot(s, st, label="street grid")
        ax[0].legend(); ax[0].grid()
        ax[1].plot(s, eL); ax[1].plot(s, eR); ax[1].grid()
        plt.tight_layout(); plt.savefig(os.path.join(lv, "sbahn_profile.png"), dpi=60)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Street clutter for a streamed level: tree trunks + mesh obstacles, chunk by chunk.

  python3 build_clutter.py --name mitte_all [--workers 2] [--area X0 Z0 X1 Z1] [--debug-chunk I J]

The small levels get their trunks and obstacles from build_level.py in one piece. A
streamed level (build_stream.py, `?level=mitte_all`, 4.4 x 4.1 km) is far too big for
that (17,600 x 16,400 px at 0.25 m), so this script runs the same functions of
build_level.py on 500 m chunks with a 40 m margin and keeps from each chunk only what
lies in its core (objects by the centre of their outline, trunks by position):

  mesh      : the finest leaf tiles of tiles.json (L1, coarser only where L1 is missing),
              rasterised with build_level.raster_top (0.25 m top surface + colour)
  obstacles : build_level.obstacle_layer (local street ground = 16 m opening, > 0.5 m,
              vegetation / facade / texture filters), road clearing (--roads wfs:
              build_level.road_mask, Strassenbefahrung 2014 + OSM fill; on the road
              only objects > 2 m stay)
  buildings : OSM footprints + 2 m buffer from buildings.bin (build_buildings.py, read only)
  trees     : Baumkataster WFS (cached), a trunk only where the mesh shows a crown
              (within 2 m of the trunk >= 3 m above the height model)
  kept free : spawn, eggs (bears, pitches + goals + balls), the Weltballon platform,
              S-Bahn entrance / street drop-offs, the no-drive zones (js/nodrive.js),
              the S-Bahn viaduct corridor and every OSM bridge (street level only)

Output: levels/<name>/clutter.json + clutter.bin (cell index, see CLUTTER_NOTE). Per chunk
results go to levels/<name>/clutter_chunks/ (resumable: done chunks are skipped; the
folder is deleted after a complete run unless --keep-chunks).

Network: only when a cache is missing (levels/<name>/trees_wfs.json, roads_wfs.json),
one bbox request per WFS layer, sequential, User-Agent berlin-mesh-tools. OSM comes from
the level's osm_map.json (build_map.py cache); nothing goes to Overpass.
"""
import argparse, contextlib, glob, io, json, math, os, re, shutil, sys, time
import urllib.parse, urllib.request
from types import SimpleNamespace
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import merge_tiles as MT                       # noqa: E402
from merge_hybrid import geo_to_ecef           # noqa: E402
import build_level as BL                       # noqa: E402
from osm_semantic import ROAD_WIDTH            # noqa: E402

C = BL.MASK_CELL            # 0.5 m lattice of obstacle_layer
CHUNK = 500.0               # m, chunk core
MARGIN = 40.0               # m around the core (16 m ground window + objects up to ~60 m)
CELL = 64.0                 # m, cell grid of the output = js/walls.js CELL (absolute grid: cell i = floor(x / CELL))
TREE_MIN_VISIBLE = 3.0      # m, as build_level.py
UA = "berlin-mesh-tools"
TREE_WFS = "https://gdi.berlin.de/services/wfs/baumbestand"
TREE_LAYERS = ("baumbestand:strassenbaeume", "baumbestand:anlagenbaeume")
# drivable OSM classes for the centre-line check (no obstacle / trunk on them)
DRIVABLE = set(ROAD_WIDTH)
# special places kept free (m around the point)
R_SPAWN, R_BEAR, R_BALL, R_PITCH, R_GOAL = 15.0, 8.0, 6.0, 4.0, 6.0
R_BALLOON = 10.0 + 4.0      # js/balloon.js PLAT_R + margin
R_SBAHN = 10.0              # entrance, door, roll-out, street drop-offs
VIADUCT_M = 3.0             # m beyond the sbahn.json corridor
BRIDGE_M = 3.0              # m beyond half the OSM bridge width
CENTRE_KEEP_H = 2.3         # m, obstacles this tall stay even on a drivable OSM centre line
PIT_M = 2.0                 # m around a construction pit outline

CLUTTER_NOTE = (
    "clutter.bin little-endian sections (byte offsets in `sections`): cells uint32 "
    "[treeStart, treeCount, obstStart, obstCount] per cell, row-major (row = z, cell (i, j) "
    "covers x0 + i*cell .. +cell, z0 + j*cell .. +cell; x0, z0 multiples of cell, so cell (i, j) is the absolute "
    "cell floor(x / cell) - x0 / cell as in js/walls.js); trees float32 [x, z, r, vis] sorted by "
    "cell (trunk radius m, visible height above the road model m); obst float32 [ptStart, ptCount, "
    "h, a] sorted by cell (h = height above the street p90 m, a = area m2); pts float32 [x, z] "
    "closed outlines (first == last); ev float32 [side, kept] per obst row (car-height test: side-face "
    "m2 in the 0.3-2 m band per m of outline, share of the scanned object kept; NaN = built before the "
    "test, js/clutter.js then falls back to its size guess). An object or trunk sits in the cell of its outline centre / "
    "position; outlines may reach ~40 m into the neighbour cells.")


# ---------------------------------------------------------------- frame / data
class Level:
    def __init__(self, name):
        self.name = name
        self.dir = os.path.join(HERE, "levels", name)
        L = json.load(open(os.path.join(self.dir, "level.json")))
        self.L = L
        self.bbox = L["bbox"]
        lat0, lon0 = L["origin"]["lat"], L["origin"]["lon"]
        self.origin = geo_to_ecef(lat0, lon0, 0.0)
        self.R = MT.enu_basis(lat0, lon0)
        ex = L["extent"]
        self.ext = (ex["minX"], -ex["maxZ"], ex["maxX"], -ex["minZ"])   # E/N
        h = L["height"]
        self.hgt = np.fromfile(os.path.join(self.dir, h["file"]), np.float32).reshape(h["nz"], h["nx"])
        self.hcell, self.hx0, self.hn0 = h["cell"], h["x0"], h["n0"]
        w = L["water"]
        self.water = np.fromfile(os.path.join(self.dir, w["file"]), np.uint8).reshape(w["nz"], w["nx"]).astype(bool)
        self.wcell, self.wx0, self.wn0 = w["cell"], w["x0"], w["n0"]
        bj = json.load(open(os.path.join(self.dir, "buildings.json")))
        raw = np.fromfile(os.path.join(self.dir, bj["file"]), np.uint8)
        stride = (bj["nx"] + 7) // 8
        assert raw.size == stride * bj["nz"], "buildings.bin size mismatch (being rebuilt?) - re-run"
        self.bld = np.unpackbits(raw.reshape(bj["nz"], stride), axis=1)[:, :bj["nx"]].astype(bool)
        self.bcell, self.bx0, self.bn0, self.bbuf = bj["cell"], bj["x0"], bj["n0"], bj.get("buffer")

    def to_en(self, lon, lat):
        v = self.R @ (geo_to_ecef(lat, lon, 0.0) - self.origin)
        return v[0], v[1]

    def sample(self, grid, x0, n0, cell, E, N, centre=True):
        """nearest cell of a level raster at (E, N) arrays; outside -> False/0"""
        o = 0.0 if centre else 0.5
        i = np.floor((E - x0) / cell + o).astype(np.int64); j = np.floor((N - n0) / cell + o).astype(np.int64)
        ok = (i >= 0) & (i < grid.shape[1]) & (j >= 0) & (j < grid.shape[0])
        out = np.zeros(E.shape, grid.dtype)
        out[ok] = grid[j[ok], i[ok]]
        return out

    def height_at(self, E, N):
        return ndimage.map_coordinates(self.hgt.astype(np.float64),
                                       [(N - self.hn0) / self.hcell, (E - self.hx0) / self.hcell],
                                       order=1, mode="nearest")


def fetch_trees(lv):
    """Baumkataster (street + park trees) for the level bbox, one request per layer,
    cached with geometry + girth only in trees_wfs.json"""
    tcache = os.path.join(lv.dir, "trees_wfs.json")
    if os.path.exists(tcache):
        return json.load(open(tcache)), 0
    W, S, E, N = lv.bbox
    feats, nreq = [], 0
    for layer in TREE_LAYERS:
        q = urllib.parse.urlencode({
            "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": layer,
            "OUTPUTFORMAT": "application/json", "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
            "BBOX": f"{S},{W},{N},{E},urn:ogc:def:crs:EPSG::4326", "COUNT": "200000"})
        req = urllib.request.Request(TREE_WFS + "?" + q, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as r:
            fc = json.loads(r.read())
        nreq += 1
        for f in fc.get("features", []):
            pr = f.get("properties") or {}
            feats.append({"type": "Feature", "geometry": f["geometry"],
                          "properties": {"_layer": layer.split(":")[1], "stammumfg": pr.get("stammumfg")}})
        print(f"trees: {layer}: {len(fc.get('features', []))} features")
        time.sleep(1.0)
    doc = {"type": "FeatureCollection", "note": "Baumkataster Berlin (gdi.berlin.de, dl-de/zero-2.0); "
           "geometry + stammumfg only", "features": feats}
    json.dump(doc, open(tcache, "w"), separators=(",", ":"))
    print(f"trees: fetched {len(feats)} -> {tcache}")
    return doc, nreq


def prepare_osm_roads(lv):
    """build_level.road_mask reads <cache>/osm_roads.json (Overpass `way[highway]` out geom):
    write it from the level's OSM cache (osm_map.json, build_map.py) so it never queries."""
    p = os.path.join(lv.dir, "osm_roads.json")
    if os.path.exists(p):
        return
    src = os.path.join(lv.dir, "osm_map.json")
    if not os.path.exists(src):
        sys.exit(f"no {src}: run build_map.py first (no Overpass from here)")
    el = [e for e in json.load(open(src))["elements"]
          if e.get("type") == "way" and "highway" in e.get("tags", {}) and e.get("geometry")]
    json.dump({"note": "way[highway] from osm_map.json (OpenStreetMap contributors, ODbL)",
               "elements": el}, open(p, "w"), separators=(",", ":"))
    print(f"roads: {len(el)} OSM highway ways from osm_map.json -> {p}")


# ---------------------------------------------------------------- places kept free
def keep_free_shapes(lv):
    """[(kind, data)] in E/N: ('circle', (e, n, r)), ('poly', [(e, n), ...]),
    ('line', ([(e, n), ...], width))"""
    shapes, names = [], []
    sp = lv.L["spawn"]
    shapes.append(("circle", (sp["x"], -sp["z"], R_SPAWN))); names.append("spawn")
    ep = os.path.join(lv.dir, "eggs.json")
    if os.path.exists(ep):
        for it in json.load(open(ep))["items"]:
            k = it["kind"]
            if k == "pitch":
                c = np.array(it["corners"], float); cc = c.mean(0)
                d = c - cc; d *= 1 + R_PITCH / np.linalg.norm(d, axis=1, keepdims=True)
                shapes.append(("poly", [(x, -z) for x, z in cc + d])); names.append(it["id"])
            else:
                r = {"bear": R_BEAR, "ball": R_BALL, "goal": R_GOAL}.get(k, R_BEAR)
                shapes.append(("circle", (it["x"], -it["z"], r))); names.append(it["id"])
    # Weltballon platform (js/balloon.js BALLOON)
    src = open(os.path.join(HERE, "js", "balloon.js")).read()
    m = re.search(r"BALLOON\s*=\s*\{\s*lat:\s*([\d.]+),\s*lon:\s*([\d.]+)", src)
    e, n = lv.to_en(float(m.group(2)), float(m.group(1)))
    shapes.append(("circle", (e, n, R_BALLOON))); names.append("balloon")
    # construction pits (level.json pit, build_level.pit_layer / pit agent): the way in stays open,
    # no hoarding or fence within the pit outline + PIT_M
    for pt in (lv.L.get("pit") or {}).get("pits", []):
        ring = [(x, -z) for x, z in pt["p"]]
        shapes.append(("poly", ring)); names.append("pit")
        shapes.append(("line", (ring + ring[:1], 2 * PIT_M))); names.append("pit")
    # no-drive zones (js/nodrive.js rings in lon/lat)
    src = open(os.path.join(HERE, "js", "nodrive.js")).read()
    for ring in re.findall(r"ring:\s*\[(.*?)\]\s*,\s*\n\s*\}", src, re.S):
        pts = [lv.to_en(float(a), float(b)) for a, b in re.findall(r"\[([\d.]+),\s*([\d.]+)\]", ring)]
        shapes.append(("poly", pts)); names.append("nodrive")
    # S-Bahn: viaduct corridor, entrance, street drop-offs
    sp = os.path.join(lv.dir, "sbahn.json")
    if os.path.exists(sp):
        s = json.load(open(sp))
        P = np.c_[s["x"], s["z"]]; Nn = np.c_[s["nx"], s["nz"]]
        lf, rt = np.array(s["left"], float), np.array(s["right"], float)
        lo = P + Nn * (np.minimum(lf, rt) - VIADUCT_M)[:, None]
        hi = P + Nn * (np.maximum(lf, rt) + VIADUCT_M)[:, None]
        for k in range(0, len(P) - 1, 50):            # 100 m pieces (PIL polygon fill)
            sl = slice(k, min(k + 51, len(P)))
            ring = np.vstack([lo[sl], hi[sl][::-1]])
            shapes.append(("poly", [(x, -z) for x, z in ring])); names.append("viaduct")
        en = s["entrance"]
        for x, z in ([en["x"], en["z"]], en["door"], en["roll"]):
            shapes.append(("circle", (x, -z, R_SBAHN))); names.append("sbahn-entrance")
        for ex in s["exits"]:
            st = ex["street"]
            shapes.append(("circle", (st["x"], -st["z"], R_SBAHN))); names.append("sbahn-drop")
    # bridges (OSM): everything on them is off the street level
    for el in json.load(open(os.path.join(lv.dir, "osm_map.json")))["elements"]:
        t, g = el.get("tags", {}), el.get("geometry")
        if not g:
            continue
        if t.get("man_made") == "bridge" and g[0] == g[-1]:
            shapes.append(("poly", [lv.to_en(p["lon"], p["lat"]) for p in g])); names.append("bridge")
        elif t.get("bridge") and t["bridge"] != "no" and ("highway" in t or "railway" in t):
            if "railway" in t:
                w = 8.0
            else:
                hw = t["highway"]
                ln = t.get("lanes", "")
                w = float(ln) * 3.25 if ln.replace(".", "").isdigit() else ROAD_WIDTH.get(hw, 4.0)
            shapes.append(("line", ([lv.to_en(p["lon"], p["lat"]) for p in g], w + 2 * BRIDGE_M)))
            names.append("bridge")
    return shapes, names


def draw_shapes(shapes, ext, cell, mx, my):
    """bool (my x mx), row 0 = south, cells of `cell` m from ext (E0, N0)"""
    img = Image.new("L", (mx, my), 0); dr = ImageDraw.Draw(img)
    def px(e, n):
        return ((e - ext[0]) / cell, (n - ext[1]) / cell)
    for kind, d in shapes:
        if kind == "circle":
            e, n, r = d
            u, v = px(e, n); rr = r / cell
            if u + rr < 0 or v + rr < 0 or u - rr > mx or v - rr > my:
                continue
            dr.ellipse([u - rr, v - rr, u + rr, v + rr], fill=1)
        elif kind == "poly":
            dr.polygon([px(e, n) for e, n in d], fill=1)
        else:
            pts, w = d
            pp = [px(e, n) for e, n in pts]
            ww = max(1, int(round(w / cell)))
            dr.line(pp, fill=1, width=ww, joint="curve")
            for u, v in (pp[0], pp[-1]):
                dr.ellipse([u - ww / 2, v - ww / 2, u + ww / 2, v + ww / 2], fill=1)
    return np.array(img, bool)


# ---------------------------------------------------------------- one chunk
G = {}      # per-process globals (set before the pool forks)


def prims_of(row, base):
    """leaf tile of tiles.json -> primitives in the level frame (X=E, Y=U, Z=-N) with uv + texture"""
    gj, bn = MT.gltf_from_b3dm(open(os.path.join(base, row[0]), "rb").read())
    nw = MT.node_world_matrices(gj)
    M = np.eye(4); M[:3] = np.array(row[7:19], float).reshape(3, 4)
    out = []
    for ni, nd in enumerate(gj.get("nodes", [])):
        if "mesh" not in nd:
            continue
        for p in gj["meshes"][nd["mesh"]]["primitives"]:
            pa = p["attributes"].get("POSITION")
            if pa is None:
                continue
            pos = MT.read_accessor(gj, bn, pa).astype(np.float64)
            w = ((M @ nw[ni]) @ np.c_[pos, np.ones(len(pos))].T).T[:, :3]
            idx = (MT.read_accessor(gj, bn, p["indices"]).reshape(-1).astype(np.uint32)
                   if "indices" in p else np.arange(len(pos), dtype=np.uint32))
            uv = (MT.read_accessor(gj, bn, p["attributes"]["TEXCOORD_0"]).astype(np.float32)
                  if "TEXCOORD_0" in p["attributes"] else None)
            img = MT.basecolor_image_bytes(gj, bn, p.get("material"))
            out.append({"pos": w.astype(np.float32), "idx": idx, "uv": uv, "img": img[0] if img else None})
    return out


def chunk_ext(ci, cj):
    lv = G["lv"]
    e0, n0 = lv.ext[0] + ci * CHUNK, lv.ext[1] + cj * CHUNK
    core = (e0, n0, min(e0 + CHUNK, lv.ext[2]), min(n0 + CHUNK, lv.ext[3]))
    ext = (max(core[0] - MARGIN, lv.ext[0]), max(core[1] - MARGIN, lv.ext[1]),
           min(core[2] + MARGIN, lv.ext[2]), min(core[3] + MARGIN, lv.ext[3]))
    # whole 0.5 m cells
    ext = (ext[0], ext[1], ext[0] + math.ceil((ext[2] - ext[0]) / C) * C,
           ext[1] + math.ceil((ext[3] - ext[1]) / C) * C)
    return core, ext


def run_chunk(job):
    ci, cj, debug = job
    lv, a = G["lv"], G["args"]
    path = os.path.join(G["cdir"], f"c_{ci:02d}_{cj:02d}.json")
    if os.path.exists(path) and not debug:
        return path, None
    t0 = time.time()
    core, ext = chunk_ext(ci, cj)
    mx, my = int(round((ext[2] - ext[0]) / C)), int(round((ext[3] - ext[1]) / C))
    log = io.StringIO()
    res = {"chunk": [ci, cj], "core": [round(v, 2) for v in core], "trees": [], "obstacles": [], "stats": {}}
    rows = [r for r in G["leaves"] if r[3] + r[6] >= ext[0] and r[3] - r[6] <= ext[2]
            and -r[5] + r[6] >= ext[1] and -r[5] - r[6] <= ext[3]]
    if rows:
        prims = []
        for r in rows:
            try:
                prims += prims_of(r, G["base"])
            except Exception as e:
                print(f"  ! {r[0]}: {e}", file=log)
        top, ortho = BL.raster_top(prims, ext[0], ext[1], 2 * mx, 2 * my, C / 2)
        for pr in prims:                    # the car-height test needs the geometry only
            pr["uv"] = pr["img"] = None
        t_r = time.time() - t0
        # cell centres of the 0.5 m lattice
        E = ext[0] + (np.arange(mx) + 0.5) * C; N = ext[1] + (np.arange(my) + 0.5) * C
        EE, NN = np.meshgrid(E, N)
        mask = lv.sample(lv.bld, lv.bx0, lv.bn0, lv.bcell, EE, NN)
        water = lv.sample(lv.water, lv.wx0, lv.wn0, lv.wcell, EE, NN)
        free = draw_shapes(G["shapes"], ext, C, mx, my)
        # road model on obstacle_layer's 2 m nodes (ext[0] + i*H_CELL), from the level's 4 m grid
        hx = int(np.ceil((ext[2] - ext[0]) / BL.H_CELL)) + 1; hy = int(np.ceil((ext[3] - ext[1]) / BL.H_CELL)) + 1
        HE, HN = np.meshgrid(ext[0] + np.arange(hx) * BL.H_CELL, ext[1] + np.arange(hy) * BL.H_CELL)
        height = lv.height_at(HE, HN).astype(np.float32)
        # ---- trees: Baumkataster trunks the mesh shows ----
        te, tn, tg = G["tree_e"], G["tree_n"], G["tree_g"]
        sel = np.flatnonzero((te >= ext[0]) & (te < ext[2]) & (tn >= ext[1]) & (tn < ext[3]))
        with np.errstate(all="ignore"):
            tmax = np.nanmax(np.nanmax(np.where(np.isfinite(top), top, -np.inf).reshape(my, 2, mx, 2), axis=3), axis=1)
        tmax2 = ndimage.maximum_filter(tmax, size=9)                  # +-2 m around the trunk
        trees, tstat = [], {"in": 0, "blocked": 0, "hidden": 0, "free_zone": 0}
        for k in sel:
            e, n = te[k], tn[k]
            i, j = min(int((e - ext[0]) / C), mx - 1), min(int((n - ext[1]) / C), my - 1)
            tstat["in"] += 1
            if mask[j, i] or water[j, i]:
                tstat["blocked"] += 1; continue
            if free[j, i]:
                tstat["free_zone"] += 1; continue
            vis = tmax2[j, i] - float(lv.height_at(np.array([e]), np.array([n]))[0])
            if not vis >= TREE_MIN_VISIBLE:
                tstat["hidden"] += 1; continue
            r = max(0.3, tg[k] / (2 * np.pi) + 0.1)
            trees.append([round(float(e), 2), round(float(-n), 2), round(float(r), 2), round(float(vis), 1)])
        # ---- obstacles (build_level.obstacle_layer; kept-free places act as water there) ----
        # obstacle_layer's spawn-run report needs a start inside the chunk: core centre, heading north
        sp = {"x": (core[0] + core[2]) / 2, "z": -(core[1] + core[3]) / 2, "heading": 0.0}
        dbg = os.path.join(G["sdir"], f"obstacles_c{ci:02d}_{cj:02d}.png") if debug else None
        oa = SimpleNamespace(obst_min=BL.OBST_MIN, obst_max=12.0, obst_min_area=2.0, parked_cars="include",
                             road_min=a.road_min, debug_obstacles=dbg)
        with contextlib.redirect_stdout(log):
            roads = BL.road_mask(a.roads, lv.dir, lv.bbox, ext, lv.to_en, mx, my)
            obst = BL.obstacle_layer(oa, top, ortho, mask, water | free, height, trees, ext, G["sdir"],
                                     spawn=(sp["x"], -sp["z"], sp["heading"]), roads=roads, blocks=True,
                                     walls=True, prims=prims)
        del prims
        BL._DBG.clear()
        txt = log.getvalue()
        m = re.search(r"road clearance .*?objects (\d+) -> (\d+)", txt)
        mc = re.search(r"car height .*?: (\d+) objects dropped .*?, (\d+) cut .*?, (\d+) m2 removed", txt)
        res["stats"] = {"trees": tstat,
                        "car_height": [int(v) for v in mc.groups()] if mc else None, "objects_before_roads": int(m.group(1)) if m else None,
                        "objects": int(m.group(2)) if m else None,
                        "covered": round(float(np.isfinite(top).mean()), 3),
                        "raster_s": round(t_r, 1), "tiles": len(rows),
                        "road_ha": round(float(roads[0].sum()) * C * C / 1e4, 2) if roads[0] is not None else 0,
                        "road_note": roads[2]}
        # keep what lies in the core
        def in_core(e, n):
            return core[0] <= e < core[2] and core[1] <= n < core[3]
        res["trees"] = [t for t in trees if in_core(t[0], -t[1])]
        for o in obst:
            p = np.array(o["p"])
            ce, cn = (p[:, 0].min() + p[:, 0].max()) / 2, -(p[:, 1].min() + p[:, 1].max()) / 2
            if in_core(ce, cn):
                res["obstacles"].append(o)
        if debug:
            print(txt)
    res["stats"]["seconds"] = round(time.time() - t0, 1)
    tmp = path + ".tmp"
    json.dump(res, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, path)
    with open(path[:-5] + ".log", "w") as f:
        f.write(log.getvalue())
    return path, res["stats"]


def load_bin(prefix):
    """clutter.json/.bin -> (doc, trees [[x, z, r, vis]], obstacles [{p, h, a[, ev]}])"""
    doc = json.load(open(prefix + ".json")); raw = open(prefix + ".bin", "rb").read()
    def sec(nm):
        s = doc["sections"][nm]
        return np.frombuffer(raw, "<f4", s["count"] * s["stride"], s["offset"]).reshape(s["count"], s["stride"])
    tr, ob, pts = sec("trees"), sec("obst"), sec("pts")
    evs = sec("ev") if "ev" in doc["sections"] else np.full((len(ob), 2), np.nan, np.float32)
    trees = [[round(x, 2), round(z, 2), round(r, 2), round(v, 1)] for x, z, r, v in tr.tolist()]
    obst = []
    for (p0, pn, h, a), e in zip(ob.tolist(), evs.tolist()):
        o = {"p": [[round(float(u), 2), round(float(v), 2)] for u, v in pts[int(p0):int(p0) + int(pn)]],
             "h": round(h, 1), "a": round(a, 1)}
        if np.isfinite(e[0]):
            o["ev"] = [round(e[0], 2), round(e[1], 2)]
        obst.append(o)
    return doc, trees, obst


def seed_from_bin(lv, cdir, chunks, skip):
    """Write clutter_chunks/c_I_J.json for every chunk not in `skip` and not there yet from the
    current clutter.bin (objects by outline centre, trunks by position), so that --area can
    rebuild a few chunks and the assemble keeps the rest as it is. The assemble filters
    (centre lines, kept-free places) already ran on these objects; running them again keeps them."""
    jp, bp = os.path.join(lv.dir, "clutter.json"), os.path.join(lv.dir, "clutter.bin")
    doc = json.load(open(jp)); raw = open(bp, "rb").read()
    def sec(nm, dt):
        s = doc["sections"][nm]
        return np.frombuffer(raw, dt, s["count"] * s["stride"], s["offset"]).reshape(s["count"], s["stride"])
    tr, ob, pts = sec("trees", "<f4"), sec("obst", "<f4"), sec("pts", "<f4")
    evs = sec("ev", "<f4") if "ev" in doc["sections"] else np.full((len(ob), 2), np.nan, np.float32)
    nci = int(np.ceil((lv.ext[2] - lv.ext[0]) / CHUNK)); ncj = int(np.ceil((lv.ext[3] - lv.ext[1]) / CHUNK))
    def chunk_of(e, n):
        return (min(max(int((e - lv.ext[0]) // CHUNK), 0), nci - 1), min(max(int((n - lv.ext[1]) // CHUNK), 0), ncj - 1))
    per = {c: {"chunk": list(c), "trees": [], "obstacles": [], "stats": {"seeded_from_bin": True}} for c in chunks}
    for x, z, r, vis in tr.tolist():
        per[chunk_of(x, -z)]["trees"].append([round(x, 2), round(z, 2), round(r, 2), round(vis, 1)])
    for (p0, pn, h, a), e in zip(ob.tolist(), evs.tolist()):
        p = pts[int(p0):int(p0) + int(pn)]
        ce, cn = (p[:, 0].min() + p[:, 0].max()) / 2, -(p[:, 1].min() + p[:, 1].max()) / 2
        o = {"p": [[round(float(u), 2), round(float(v), 2)] for u, v in p], "h": round(h, 1), "a": round(a, 1)}
        if np.isfinite(e[0]):
            o["ev"] = [round(e[0], 2), round(e[1], 2)]
        per[chunk_of(ce, cn)]["obstacles"].append(o)
    n = 0
    for c in chunks:
        path = os.path.join(cdir, f"c_{c[0]:02d}_{c[1]:02d}.json")
        if c in skip or os.path.exists(path):
            continue
        json.dump(per[c], open(path, "w"), separators=(",", ":")); n += 1
    print(f"seeded {n} chunk files from {bp} ({len(tr)} trunks, {len(ob)} outlines); "
          f"rebuilding {len(skip)}: {sorted(skip)}")


# ---------------------------------------------------------------- lane rule (owner 2026-11-21)
LANE_WH = 0.3               # m, outline box half thickness (js/clutter.js WH): cut this far outside the lane
BARRIER_A = 50.0            # m2, a lane object at least this big ...
BARRIER_H = 2.3             # m ... and this tall (p90) is a barrier (site, hoarding, container row): it blocks
BARRIER_L = 8.0             # m, ... and at least this long (frozen lorries / buses are shorter or smaller)
LANE_RULE_TXT = (f"; lanes (owner 2026-11-21: on the road itself the car drives): inside the lane corridors of every "
                 f"drivable OSM road (audit_roads.py, + {LANE_WH:g} m) an outline is cut at the corridor edge, except "
                 f"barriers >= {BARRIER_A:g} m2, >= {BARRIER_H:g} m, >= {BARRIER_L:g} m long (sites, hoardings, container "
                 f"rows); trunks reaching into a corridor are dropped")


def lane_zone(lv, ext, cell, mx, my):
    """bool (my x mx), row 0 = south: the lane corridors of audit_roads.py (every lane of every
    drivable OSM road, car half width + margin either side) widened by LANE_WH; tunnel ways and
    underground ways are not on the surface and take no part. Returns (zone, km of road)."""
    import audit_roads as AR
    shapes, km = [], 0.0
    for wid, t, mode, en in AR.roads(lv, None):
        if mode == "tunnel":
            continue
        W, offs = AR.lane_offsets(t, t["highway"])
        half = max(abs(o) for o in offs) + AR.CAR_HALF + AR.MARGIN + LANE_WH
        shapes.append(("line", ([tuple(p) for p in en], 2 * half)))
        km += float(np.hypot(*np.diff(en, axis=0).T).sum()) / 1000
    # exact distance per segment (PIL's wide lines come out up to a cell narrow on diagonals):
    # a cell is in the zone when its centre lies within w / 2 of the centre line
    zone = np.zeros((my, mx), bool)
    for _, (pts, w) in shapes:
        h = w / 2
        P = np.asarray(pts, float)
        for (e0, n0), (e1, n1) in zip(P[:-1], P[1:]):
            i0 = max(int(math.floor((min(e0, e1) - h - ext[0]) / cell)), 0)
            i1 = min(int(math.ceil((max(e0, e1) + h - ext[0]) / cell)) + 1, mx)
            j0 = max(int(math.floor((min(n0, n1) - h - ext[1]) / cell)), 0)
            j1 = min(int(math.ceil((max(n0, n1) + h - ext[1]) / cell)) + 1, my)
            if i1 <= i0 or j1 <= j0:
                continue
            E = ext[0] + (np.arange(i0, i1) + 0.5) * cell; N = ext[1] + (np.arange(j0, j1) + 0.5) * cell
            dx, dn = e1 - e0, n1 - n0
            l2 = dx * dx + dn * dn
            u = np.clip(((E[None, :] - e0) * dx + (N[:, None] - n0) * dn) / max(l2, 1e-12), 0, 1)
            d = np.hypot(E[None, :] - e0 - u * dx, N[:, None] - n0 - u * dn)
            zone[j0:j1, i0:i1] |= d <= h
    return zone, km


def obj_shape(p):
    """length, width (m) of an outline along its main axis"""
    q = np.asarray(p, float)
    c = q - q.mean(0)
    if len(q) < 3:
        return 0.0, 0.0
    ev, evec = np.linalg.eigh(np.cov(c.T))
    r = c @ evec
    return float(np.ptp(r[:, 1])), float(np.ptp(r[:, 0]))


def lane_rule(lv, trees, obst, report=None):
    """Inside the driving lanes nothing blocks except barriers: an obstacle outline that reaches
    into a lane corridor is cut at the corridor edge (+ LANE_WH), pieces < CAR_MIN_AREA go; a
    barrier (>= BARRIER_A m2, >= BARRIER_H m, >= BARRIER_L m long: site, hoarding, container
    row) stays whole. Trunks whose circle (+ LANE_WH) reaches into a corridor are dropped (no tree
    stands in a lane: register or OSM position off). Returns (trees, obst, stats)."""
    import contourpy
    ext = lv.ext
    mx, my = int(np.ceil((ext[2] - ext[0]) / C)), int(np.ceil((ext[3] - ext[1]) / C))
    zone, km = lane_zone(lv, ext, C, mx, my)
    # one more cell: a cut outline is traced half a cell outside the kept cells and the drawn corridor
    # is up to half a cell short of its true edge; without this the boxes still graze the lane
    zone = ndimage.binary_dilation(zone)
    st = {"road_km": round(km, 1), "kept": 0, "barriers": 0, "cut": 0, "dropped": 0, "trunks_dropped": 0,
          "cut_m2": 0.0, "dropped_m2": 0.0}
    out, barriers = [], []
    for o in obst:
        p = np.asarray(o["p"], float)
        u, v = (p[:, 0] - ext[0]) / C, (-p[:, 1] - ext[1]) / C
        i0, i1 = max(int(u.min()) - 2, 0), min(int(u.max()) + 3, mx)
        j0, j1 = max(int(v.min()) - 2, 0), min(int(v.max()) + 3, my)
        if i1 <= i0 or j1 <= j0 or not zone[j0:j1, i0:i1].any():
            out.append(o); st["kept"] += 1; continue
        img = Image.new("L", (i1 - i0, j1 - j0), 0)
        ImageDraw.Draw(img).polygon([(a - i0 - 0.5, b - j0 - 0.5) for a, b in zip(u, v)], fill=1, outline=1)
        m = np.array(img, bool)
        z = zone[j0:j1, i0:i1]
        if not (m & z).any():
            out.append(o); st["kept"] += 1; continue
        L, Wd = obj_shape(p)
        if o["a"] >= BARRIER_A and o["h"] >= BARRIER_H and L >= BARRIER_L:
            out.append(o); st["barriers"] += 1
            barriers.append({"x": round(float(p[:, 0].mean()), 1), "z": round(float(p[:, 1].mean()), 1), "h": o["h"],
                             "a": o["a"], "L": round(L, 1)})
            continue
        rest = m & ~z
        a0 = float(m.sum()) * C * C
        if rest.sum() * C * C < BL.CAR_MIN_AREA:
            st["dropped"] += 1; st["dropped_m2"] += o["a"]; continue
        rest = ndimage.binary_opening(rest, structure=np.ones((2, 2))) if rest.sum() > 4 else rest
        lab, n = ndimage.label(rest, structure=np.ones((3, 3)))
        npieces = 0
        for k in range(1, n + 1):
            mk = lab == k
            ak = float(mk.sum()) * C * C
            if ak < BL.CAR_MIN_AREA:
                continue
            for ln in contourpy.contour_generator(z=np.pad(mk, 1).astype(np.float32)).lines(0.5):
                ln = (ln - 1 + [i0, j0]) * C + [ext[0], ext[1]] + C / 2
                if len(ln) < 4:
                    continue
                ln = BL.rdp(ln, 0.3)
                if len(ln) < 3:
                    continue
                q = {"p": [[round(e, 2), round(-n_, 2)] for e, n_ in ln], "h": o["h"], "a": round(ak, 1)}
                if o.get("ev"):
                    q["ev"] = o["ev"]
                out.append(q); npieces += 1
        if npieces:
            st["cut"] += 1; st["cut_m2"] += max(a0 - float(rest.sum()) * C * C, 0.0)
        else:
            st["dropped"] += 1; st["dropped_m2"] += o["a"]
    # trunks
    keep_t = []
    for t in trees:                                         # zone within r + half a cell of the trunk
        u, v = (t[0] - ext[0]) / C - 0.5, (-t[1] - ext[1]) / C - 0.5
        rr = t[2] / C + 0.5
        i0, i1 = max(int(math.floor(u - rr)), 0), min(int(math.ceil(u + rr)) + 1, mx)
        j0, j1 = max(int(math.floor(v - rr)), 0), min(int(math.ceil(v + rr)) + 1, my)
        J, I = np.mgrid[j0:j1, i0:i1]
        if (zone[j0:j1, i0:i1] & (np.hypot(I - u, J - v) <= rr)).any():
            st["trunks_dropped"] += 1; continue
        keep_t.append(t)
    st["cut_m2"] = round(st["cut_m2"]); st["dropped_m2"] = round(st["dropped_m2"])
    print(f"lane rule ({km:.0f} km of drivable road, lane corridors + {LANE_WH:g} m): {st['kept']} outlines clear of "
          f"the lanes, {st['barriers']} barriers kept whole (>= {BARRIER_A:g} m2, >= {BARRIER_H:g} m, >= {BARRIER_L:g} m "
          f"long), {st['cut']} cut at the lane edge ({st['cut_m2']} m2), {st['dropped']} dropped ({st['dropped_m2']} m2); "
          f"trunks in a lane dropped: {st['trunks_dropped']}")
    if report is not None:
        json.dump({"stats": st, "barriers": barriers}, open(report, "w"), indent=0)
    return keep_t, out, st


# ---------------------------------------------------------------- assemble + checks
def polygon_raster(polys, ext, cell, mx, my):
    img = Image.new("L", (mx, my), 0); dr = ImageDraw.Draw(img)
    for p in polys:
        dr.polygon([((x - ext[0]) / cell, (-z - ext[1]) / cell) for x, z in p], fill=1)
    return np.array(img, bool)


def write_bin(lv, trees, obst):
    """trees + obstacle outlines -> levels/<name>/clutter.bin (cell index, see CLUTTER_NOTE);
    returns the json fields that describe it"""
    ext = lv.ext
    i0, j0 = math.floor(ext[0] / CELL), math.floor(-ext[3] / CELL)      # absolute grid, as js/walls.js
    gx, gz = math.floor(ext[2] / CELL) - i0 + 1, math.floor(-ext[1] / CELL) - j0 + 1
    x0, z0 = i0 * CELL, j0 * CELL
    def cell_of(x, z):
        return (min(max(int((z - z0) // CELL), 0), gz - 1)) * gx + min(max(int((x - x0) // CELL), 0), gx - 1)
    tc = [cell_of(t[0], t[1]) for t in trees]
    oc = []
    for o in obst:
        p = np.array(o["p"]); oc.append(cell_of((p[:, 0].min() + p[:, 0].max()) / 2, (p[:, 1].min() + p[:, 1].max()) / 2))
    to, oo = np.argsort(tc, kind="stable"), np.argsort(oc, kind="stable")
    cells = np.zeros((gx * gz, 4), np.uint32)
    tcs = np.array(tc, np.int64)[to] if trees else np.zeros(0, np.int64)
    ocs = np.array(oc, np.int64)[oo] if obst else np.zeros(0, np.int64)
    cells[:, 0] = np.searchsorted(tcs, np.arange(gx * gz)); cells[:, 1] = np.bincount(tcs, minlength=gx * gz)
    cells[:, 2] = np.searchsorted(ocs, np.arange(gx * gz)); cells[:, 3] = np.bincount(ocs, minlength=gx * gz)
    tarr = np.array([trees[k] for k in to], np.float32).reshape(-1, 4)
    hdr, pts, evl = [], [], []
    npt = 0
    for k in oo:
        p = obst[k]["p"]
        if p[0] != p[-1]:
            p = p + [p[0]]
        hdr.append([npt, len(p), obst[k]["h"], obst[k]["a"]]); pts += p; npt += len(p)
        evl.append(obst[k].get("ev") or [np.nan, np.nan])
    harr = np.array(hdr, np.float32).reshape(-1, 4); parr = np.array(pts, np.float32).reshape(-1, 2)
    earr = np.array(evl, np.float32).reshape(-1, 2)
    secs, blob, off = {}, [], 0
    for nm, arr in (("cells", cells), ("trees", tarr), ("obst", harr), ("pts", parr), ("ev", earr)):
        b = arr.astype("<u4" if arr.dtype == np.uint32 else "<f4").tobytes()
        secs[nm] = {"offset": off, "count": int(arr.shape[0]), "stride": int(arr.shape[1])}
        blob.append(b); off += len(b)
    binp = os.path.join(lv.dir, "clutter.bin")
    with open(binp + ".tmp", "wb") as f:
        f.write(b"".join(blob))
    os.replace(binp + ".tmp", binp)
    return {"file": "clutter.bin", "cell": CELL, "x0": x0, "z0": z0, "nx": gx, "nz": gz, "sections": secs,
            "note": CLUTTER_NOTE, "trees": len(trees), "obstacles": len(obst)}, earr, binp


def assemble(lv, cdir, chunks, a):
    trees, obst, st = [], [], []
    for ci, cj in chunks:
        p = os.path.join(cdir, f"c_{ci:02d}_{cj:02d}.json")
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        trees += d["trees"]; obst += d["obstacles"]; st.append(d["stats"])
    ext = lv.ext
    # area covered by done chunks
    done_km2 = 0.0
    for ci, cj in chunks:
        if os.path.exists(os.path.join(cdir, f"c_{ci:02d}_{cj:02d}.json")):
            core, _ = chunk_ext(ci, cj)
            done_km2 += (core[2] - core[0]) * (core[3] - core[1]) / 1e6
    print(f"assemble: {len(st)} / {len(chunks)} chunks ({done_km2:.2f} km2), {len(trees)} trunks, "
          f"{len(obst)} obstacle outlines")

    # ---- checks on a 0.5 m raster of the whole level ----
    mx, my = int(np.ceil((ext[2] - ext[0]) / C)), int(np.ceil((ext[3] - ext[1]) / C))
    om = polygon_raster([o["p"] for o in obst], ext, C, mx, my)
    # drivable OSM centre lines (no tunnels / underground / bridges), sampled every 1 m
    osm = json.load(open(os.path.join(lv.dir, "osm_map.json")))["elements"]
    S = []
    cls = []
    for el in osm:
        t, g = el.get("tags", {}), el.get("geometry")
        hw = t.get("highway")
        if (hw not in DRIVABLE or not g or t.get("tunnel") in ("yes", "building_passage")
                or t.get("layer", "0").startswith("-") or t.get("area") == "yes"
                or (t.get("bridge") and t["bridge"] != "no")):
            continue
        en = np.array([lv.to_en(p["lon"], p["lat"]) for p in g])
        for (e0, n0), (e1, n1) in zip(en[:-1], en[1:]):
            L = math.hypot(e1 - e0, n1 - n0)
            s = np.arange(0, L, 1.0) / max(L, 1e-9)
            S.append(np.c_[e0 + (e1 - e0) * s, n0 + (n1 - n0) * s]); cls += [hw] * len(s)
    S = np.vstack(S); cls = np.array(cls)
    inside = (S[:, 0] >= ext[0]) & (S[:, 0] < ext[2]) & (S[:, 1] >= ext[1]) & (S[:, 1] < ext[3])
    S, cls = S[inside], cls[inside]
    ii = ((S[:, 0] - ext[0]) / C).astype(int); jj = ((S[:, 1] - ext[1]) / C).astype(int)
    hit = om[jj, ii]
    # objects hit by a centre line: their index
    lab = np.zeros((my, mx), np.int32)
    img = Image.new("I", (mx, my), 0); dr = ImageDraw.Draw(img)
    for k, o in enumerate(obst):
        dr.polygon([((x - ext[0]) / C, (-z - ext[1]) / C) for x, z in o["p"]], fill=k + 1)
    lab = np.array(img, np.int32)
    hit_ids = np.unique(lab[jj[hit], ii[hit]]); hit_ids = hit_ids[hit_ids > 0] - 1
    print(f"check centre lines: {len(S):,} samples (1 m) on {len(set(cls))} drivable OSM classes; "
          f"{int(hit.sum())} samples in {len(hit_ids)} obstacles")
    if len(hit_ids):
        hs = np.array([obst[k]["h"] for k in hit_ids]); ar = np.array([obst[k]["a"] for k in hit_ids])
        print(f"  hit obstacles: h p10/50/90 {np.percentile(hs, [10, 50, 90]).round(1)} m, "
              f"a p50/90 {np.percentile(ar, [50, 90]).round(0)} m2; by class "
              + ", ".join(f"{c} {int((cls[hit] == c).sum())}" for c in sorted(set(cls[hit]))))
    # owner's rule: centre lines of drivable roads stay clear -> drop those obstacles
    # owner's rule: low clutter never blocks a road; containers, site huts, hoardings, lorries and
    # buses (>= CENTRE_KEEP_H) do, also on the centre line (a site narrowing the street)
    tall = set(int(k) for k in hit_ids if obst[k]["h"] >= CENTRE_KEEP_H) if not a.clear_centre_lines else set()
    drop = set(int(k) for k in hit_ids) - tall if not a.keep_centre_hits else set()
    if tall:
        print(f"  kept on centre lines (>= {CENTRE_KEEP_H:g} m: containers, sites, lorries, buses): {len(tall)}")
    obst = [o for k, o in enumerate(obst) if k not in drop]
    from scipy.spatial import cKDTree
    tr = np.array(trees) if trees else np.zeros((0, 4))
    tdrop = np.zeros(len(tr), bool)
    if len(tr):
        kd = cKDTree(np.c_[tr[:, 0], -tr[:, 1]])
        for k, js in enumerate(kd.query_ball_point(S, r=tr[:, 2].max() + 0.5)):
            for j in js:
                if math.hypot(S[k, 0] - tr[j, 0], S[k, 1] + tr[j, 1]) < tr[j, 2] + 0.5:
                    tdrop[j] = True
    print(f"  trunks within r + 0.5 m of a drivable centre line: {int(tdrop.sum())} -> dropped")
    trees = [t for k, t in enumerate(trees) if not tdrop[k]]
    if drop:
        print(f"  obstacles on drivable centre lines: {len(drop)} -> dropped")
    # an outline cut by a kept-free place (they act as water in obstacle_layer) may still
    # reach into it by up to half a cell + rdp: drop objects whose interior touches one
    zone = draw_shapes(G["shapes"], ext, C, mx, my)
    img = Image.new("I", (mx, my), 0); dr = ImageDraw.Draw(img)
    for k, o in enumerate(obst):
        dr.polygon([((x - ext[0]) / C, (-z - ext[1]) / C) for x, z in o["p"]], fill=k + 1)
    lab = np.array(img, np.int32)
    lab[~ndimage.binary_erosion(lab > 0)] = 0
    zid = np.unique(lab[zone & (lab > 0)]) - 1
    del lab, img, zone
    if len(zid):
        zs = set(int(k) for k in zid)
        obst = [o for k, o in enumerate(obst) if k not in zs]
        print(f"  obstacles reaching into a kept-free place: {len(zs)} -> dropped")
    # buildings (OSM footprint + buffer) and kept-free places
    E = ext[0] + (np.arange(mx) + 0.5) * C; N = ext[1] + (np.arange(my) + 0.5) * C
    om = polygon_raster([o["p"] for o in obst], ext, C, mx, my)
    # outlines run through the outer cell centres (+ rdp 0.3 m): their rim pixel touches the
    # excluded area by construction; the checks count the object interior (1 px eroded)
    om = ndimage.binary_erosion(om)
    bl = np.zeros((my, mx), bool)
    for j0 in range(0, my, 1024):            # sample the 1 m mask row block by row block
        EE, NN = np.meshgrid(E, N[j0:j0 + 1024])
        bl[j0:j0 + 1024] = lv.sample(lv.bld, lv.bx0, lv.bn0, lv.bcell, EE, NN)
    print(f"check buildings: {int((om & bl).sum())} obstacle cells (0.5 m, interior) inside OSM footprints "
          f"(+{lv.bbuf} m buffer)")
    shapes, names = G["shapes"], G["names"]
    bad = {}
    for (kind, d), nm in zip(shapes, names):
        sub = draw_shapes([(kind, d)], ext, C, mx, my) if kind != "line" else None
        if sub is None:
            continue
        n = int((om & sub).sum())
        if len(tr):
            tt = np.array(trees) if trees else np.zeros((0, 4))
            ti = np.clip(((tt[:, 0] - ext[0]) / C).astype(int), 0, mx - 1)
            tj = np.clip(((-tt[:, 1] - ext[1]) / C).astype(int), 0, my - 1)
            n += int(sub[tj, ti].sum()) if len(tt) else 0
        if n:
            bad[nm] = bad.get(nm, 0) + n
    print("check kept-free places (spawn, eggs, balloon, sbahn, nodrive, viaduct): "
          + ("all clear" if not bad else f"HITS {bad}"))
    nob = sum(1 for o in obst)
    print(f"density: {nob / max(done_km2, 1e-9):.0f} obstacle outlines / km2, "
          f"{len(trees) / max(done_km2, 1e-9):.0f} trunks / km2 (small level mitte: ~560 / km2 obstacles)")

    lanes = None
    if not a.no_lane_rule:
        trees, obst, lanes = lane_rule(lv, trees, obst, report=os.path.join(lv.dir, "clutter_lanes.json"))
    head, earr, binp = write_bin(lv, trees, obst)
    x0, z0, gx, gz = head["x0"], head["z0"], head["nx"], head["nz"]
    sb = [s for s in st if s.get("objects") is not None]
    doc = dict(head)
    doc.update({"lanes": lanes, "coverage": {"chunks": len(st), "of": len(chunks), "km2": round(done_km2, 2),
                        "chunk": CHUNK, "complete": len(st) == len(chunks),
                        "seeded_from_previous_bin": sum(1 for s in st if s.get("seeded_from_bin"))},
           "carHeight": {"checked": int(np.isfinite(earr[:, 0]).sum()), "unchecked": int((~np.isfinite(earr[:, 0])).sum()),
                         "band": list(BL.CAR_BAND), "side": BL.CAR_SIDE, "reach": BL.CAR_REACH,
                         "dropped": sum((s.get("car_height") or [0, 0, 0])[0] for s in st),
                         "cut": sum((s.get("car_height") or [0, 0, 0])[1] for s in st)},
           "rules": (f"obstacles: mesh top surface (L1 leaves) > {BL.OBST_MIN:g} m above a local street "
                     f"ground (build_level.obstacle_layer), on the road surface ({a.roads}) only > "
                     f"{a.road_min:g} m, nothing under {CENTRE_KEEP_H:g} m on drivable OSM centre lines, outside OSM buildings "
                     f"(+{lv.bbuf} m), bridges, the viaduct and the kept-free places; only where the mesh is at car "
                     f"height ({BL.CAR_BAND[0]:g}-{BL.CAR_BAND[1]:g} m: the top itself or side faces within "
                     f"{BL.CAR_REACH:g} m; crowns, lamps, signs over the street do not block); trunks: Baumkataster "
                     f"where the mesh shows a crown (>= {TREE_MIN_VISIBLE:g} m)"),
           "stats": {"objects_before_roads": sum(s["objects_before_roads"] for s in sb),
                     "objects_after_roads": sum(s["objects"] for s in sb),
                     "centre_line_drops": len(drop), "centre_line_kept_tall": len(tall), "trunk_centre_line_drops": int(tdrop.sum())},
           "attribution": "3D mesh: Berlin Partner fuer Wirtschaft und Technologie GmbH; trees: Baumkataster "
                          "Berlin (dl-de/zero-2.0); " + BL.ROAD_ATTR + "; OpenStreetMap contributors (ODbL)"})
    if lanes:
        doc["rules"] += LANE_RULE_TXT
    jp = os.path.join(lv.dir, "clutter.json")
    json.dump(doc, open(jp + ".tmp", "w"), indent=1)
    os.replace(jp + ".tmp", jp)
    print(f"-> {binp} {os.path.getsize(binp)/1e6:.2f} MB, {jp}; cells {gx}x{gz} @ {CELL:g} m; "
          f"objects before/after road clearing {doc['stats']['objects_before_roads']} / "
          f"{doc['stats']['objects_after_roads']} (components); outlines {len(obst)}")
    return doc


def post_lanes(lv):
    """the lane rule on the assembled clutter.bin (cut / drop in the lanes, barriers stay); the rest
    of clutter.json (coverage, car-height counts, stats) is carried over"""
    old, trees, obst = load_bin(os.path.join(lv.dir, "clutter"))
    if old.get("lanes"):
        print("note: clutter.bin already went through the lane rule; running it again (idempotent)")
    trees, obst, lanes = lane_rule(lv, trees, obst, report=os.path.join(lv.dir, "clutter_lanes.json"))
    head, earr, binp = write_bin(lv, trees, obst)
    doc = dict(old); doc.update(head); doc["lanes"] = lanes
    if LANE_RULE_TXT not in doc.get("rules", ""):
        doc["rules"] = doc.get("rules", "") + LANE_RULE_TXT
    doc["carHeight"]["checked"] = int(np.isfinite(earr[:, 0]).sum())
    doc["carHeight"]["unchecked"] = int((~np.isfinite(earr[:, 0])).sum())
    jp = os.path.join(lv.dir, "clutter.json")
    json.dump(doc, open(jp + ".tmp", "w"), indent=1)
    os.replace(jp + ".tmp", jp)
    print(f"-> {binp} {os.path.getsize(binp)/1e6:.2f} MB, {jp}: {len(trees)} trunks, {len(obst)} outlines")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--workers", type=int, default=2, help="processes (default 2; ~1.5 GB each)")
    ap.add_argument("--area", type=float, nargs=4, metavar=("X0", "Z0", "X1", "Z1"),
                    help="only chunks overlapping this rectangle (level x/z)")
    ap.add_argument("--debug-chunk", type=int, nargs=2, metavar=("I", "J"),
                    help="re-run one chunk with build_level's debug PNG (scratch dir)")
    ap.add_argument("--scratch", default=None, help="debug PNG folder (default levels/<name>/clutter_chunks)")
    ap.add_argument("--roads", choices=("wfs", "osm", "off"), default="wfs")
    ap.add_argument("--road-min", type=float, default=2.0)
    ap.add_argument("--clear-centre-lines", action="store_true",
                    help=f"drop every obstacle on a drivable centre line (default: only those < {CENTRE_KEEP_H:g} m)")
    ap.add_argument("--keep-centre-hits", action="store_true",
                    help="keep obstacles on drivable OSM centre lines (default: dropped)")
    ap.add_argument("--assemble-only", action="store_true")
    ap.add_argument("--seed-from-bin", action="store_true",
                    help="before running: split the current clutter.bin into chunk files for every chunk "
                         "outside --area, so only the --area chunks are rebuilt and the rest is kept as it is")
    ap.add_argument("--keep-chunks", action="store_true")
    ap.add_argument("--no-lane-rule", action="store_true", help="keep obstacles / trunks in the driving lanes")
    ap.add_argument("--post-lanes", action="store_true",
                    help="apply the lane rule to the current clutter.bin only (no mesh pass), then exit")
    a = ap.parse_args()

    t0 = time.time()
    lv = Level(a.name)
    if a.post_lanes:
        post_lanes(lv)
        print(f"done in {(time.time()-t0)/60:.1f} min")
        return
    nreq = 0
    prepare_osm_roads(lv)
    if a.roads == "wfs" and not os.path.exists(os.path.join(lv.dir, "roads_wfs.json")):
        try:                    # fetches + caches (4 requests); an 8 x 8 px corner may hold no road
            BL.road_mask("wfs", lv.dir, lv.bbox, lv.ext, lv.to_en, 8, 8)
        except SystemExit:
            pass
        nreq += 4
    tfc, n = fetch_trees(lv); nreq += n
    te, tn, tg = [], [], []
    for f in tfc["features"]:
        c = f["geometry"]["coordinates"]
        lat_t, lon_t = (c[0], c[1]) if c[0] > 40 else (c[1], c[0])
        e, n_ = lv.to_en(lon_t, lat_t)
        te.append(e); tn.append(n_); tg.append(float(f["properties"].get("stammumfg") or 0) / 100.0)
    tiles = json.load(open(os.path.join(lv.dir, "tiles.json")))
    leaves = [r for r in tiles["tiles"] if r[-1] == 1]
    shapes, names = keep_free_shapes(lv)
    cdir = os.path.join(lv.dir, "clutter_chunks")
    os.makedirs(cdir, exist_ok=True)
    G.update(lv=lv, args=a, leaves=leaves, base=a.mesh_src, shapes=shapes, names=names, cdir=cdir,
             sdir=a.scratch or cdir, tree_e=np.array(te), tree_n=np.array(tn), tree_g=np.array(tg))
    nci = int(np.ceil((lv.ext[2] - lv.ext[0]) / CHUNK)); ncj = int(np.ceil((lv.ext[3] - lv.ext[1]) / CHUNK))
    chunks = [(ci, cj) for cj in range(ncj) for ci in range(nci)]
    print(f"level {a.name}: {lv.ext[2]-lv.ext[0]:.0f} x {lv.ext[3]-lv.ext[1]:.0f} m, {len(leaves)} leaf tiles, "
          f"{len(te)} Baumkataster trees, {len(shapes)} kept-free shapes, {len(chunks)} chunks of "
          f"{CHUNK:g} m (+{MARGIN:g} m); {nreq} WFS requests this run")
    if a.debug_chunk:
        p, s = run_chunk((a.debug_chunk[0], a.debug_chunk[1], True))
        print(json.dumps(s))
        return
    todo = chunks
    if a.area:
        x0, z0, x1, z1 = a.area
        n0, n1 = -max(z0, z1), -min(z0, z1)
        todo = [(ci, cj) for ci, cj in chunks
                if (lambda c: c[0] < max(x0, x1) and c[2] > min(x0, x1) and c[1] < n1 and c[3] > n0)(chunk_ext(ci, cj)[0])]
    if a.seed_from_bin:
        if not a.area:
            sys.exit("--seed-from-bin needs --area (the chunks to rebuild)")
        seed_from_bin(lv, cdir, chunks, set(todo))
    if not a.assemble_only:
        left = [c for c in todo if not os.path.exists(os.path.join(cdir, f"c_{c[0]:02d}_{c[1]:02d}.json"))]
        print(f"chunks: {len(todo)} selected, {len(todo) - len(left)} done, {len(left)} to run "
              f"with {a.workers} workers")
        jobs = [(ci, cj, False) for ci, cj in left]
        k = 0
        if a.workers > 1:
            import multiprocessing as mp
            with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
                for p, s in pool.imap_unordered(run_chunk, jobs):
                    k += 1
                    print(f"  [{k}/{len(jobs)}] {os.path.basename(p)} {json.dumps(s)} "
                          f"({(time.time()-t0)/60:.1f} min)", flush=True)
        else:
            for j in jobs:
                p, s = run_chunk(j); k += 1
                print(f"  [{k}/{len(jobs)}] {os.path.basename(p)} {json.dumps(s)}", flush=True)
    doc = assemble(lv, cdir, chunks, a)
    if doc["coverage"]["complete"] and not a.keep_chunks:
        shutil.rmtree(cdir)
        print(f"removed {cdir}")
    print(f"done in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()

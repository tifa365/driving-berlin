#!/usr/bin/env python3
"""Build a driving level for racing/index.html from the local Berlin data.

  visuals   : photogrammetric mesh tiles (berlin_mesh_2025/), clipped to the bbox
  collision : LoD2 roofs (berlin_lod2_vcm/) rasterised to a building mask,
              traced to wall polylines -> Box2D static walls in the game
  trees     : Baumkataster WFS trunks, kept only where the mesh shows a crown
  water     : OSM natural=water minus bridges (Overpass, cached) -> drown mask
  height    : LoD2 wall bases (ground contact points), interpolated and smoothed,
              plus a heavily blurred offset field that lifts it onto the visible
              mesh ground (LoD2 bases sit ~1.5 m below the mesh, LOD2_NOTES.md)

Frame: ENU metres around the bbox centre, three.js axes X=E, Y=U, Z=-N.
Box2D uses (x, y) = (X, Z) of that frame.

Output: levels/<name>/world.glb, level.json, height.bin (float32, row-major nz x nx)

  python3 build_level.py --name mitte --bbox 13.374 52.505 13.386 52.518
Reads local disk only (the portal is down; download first when it is back).
"""
import argparse, glob, json, os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.interpolate import griddata
import contourpy

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import merge_tiles as MT          # noqa: E402
import merge_lod2 as ML           # noqa: E402
from merge_hybrid import geo_to_ecef, clip_prims  # noqa: E402

MASK_CELL = 0.5     # m, building mask / wall tracing
OBST_MIN = 0.5      # m, default obstacle threshold above the street (owner: "everything rising > ~50 cm")
OBST_GROUND_WIN = 16.0   # m, local street ground = opening of the surface with this square
OBST_GROUND_DEV = 8.0   # m, local ground may leave the road model by this much (Pariser Platz: +5 m)
OBST_VEG_RIM = 1.0      # m, foliage rim around detected vegetation (not an obstacle)
OBST_VEG_RING = 0.5     # share of an object's outline bordering vegetation above which it is foliage
OBST_STEEP = 0.33       # min outline relief (p30, 1 m across) / object height: steep sides
OBST_TEX = 18.0         # min luminance std (0-255) inside an object (shadow noise / dark crowns: < 16)
OBST_CROWN_R = 4.5       # m, register tree crown radius (not an obstacle)
OBST_FACADE_BAND = 3.0   # m from a LoD2 wall: zone of facade / overhang noise
OBST_FACADE_H = 4.0      # m, a raised zone reaching this high next to a wall is facade
OBST_BLOCK_H = 2.3       # m, flat-topped block (container, site hut, kiosk, lorry) kept despite facade/steep filters
OBST_BLOCK_AREA = 10.0   # m2 of flat top at least (a parked car is ~8 m2 and < 2 m)
OBST_WALL_H = (1.8, 4.5)  # m, thin wall (site hoarding, fence) height band over the street (p90 >= the low end)
OBST_WALL_SIDE = 1.5     # m, street ground (< 0.7 m) within this distance on both sides of a wall cell
OBST_WALL_LEN = 4.0      # m, min wall length (along its axis, gaps bridged)
OBST_WALL_GAP = 8.0      # m, max gap bridged between two aligned wall pieces (tree crown over the wall)
H_CELL = 2.0        # m, height grid
CAR_BAND = (0.3, 2.0)   # m over the street: the car-height band (what the player sees beside the car)
CAR_SIDE = 0.5          # m2 of steep mesh surface in the band within CAR_REACH of a cell: a side face is there
CAR_REACH = 1.0         # m (disc radius; a 1.7 m high face across the disc holds ~3.4 m2)
CAR_MIN_AREA = 1.0      # m2, what is left of an object after the car-height cut at least


def rdp(pts, eps):
    """Douglas-Peucker on an open polyline (N x 2)."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    n = np.hypot(*ab)
    d = (np.abs(np.cross(ab, pts - a)) / n) if n > 1e-9 else np.hypot(*(pts - a).T)
    i = int(np.argmax(d))
    if d[i] <= eps:
        return np.array([a, b])
    return np.vstack([rdp(pts[:i + 1], eps)[:-1], rdp(pts[i:], eps)])


def raster_top(prims, x0, y0, nx, ny, cell, colour=True):
    """Top-surface z-buffer of the mesh, seen from above.

    Every triangle is rasterised at the cell centres (barycentric test, vectorised
    per bucket of equal bbox size); a cell keeps the highest surface point and the
    texture colour there. Returns (top float32 ny x nx, NaN = no surface;
    rgb uint8 ny x nx x 3 or None). Row 0 = south edge (north = y0 + j*cell).
    Vertical triangles (facades, tile skirts) cover almost no cell centre, so
    they do not raise the surface.
    """
    import io
    top = np.full(ny * nx, -np.inf, np.float32)
    rgb = np.zeros((ny * nx, 3), np.uint8) if colour else None
    for pr in prims:
        pos = pr["pos"]
        tri = pr["idx"].reshape(-1, 3).astype(np.int64)
        u = (pos[:, 0] - x0) / cell - 0.5               # cell centre i at u == i
        v = (-pos[:, 2] - y0) / cell - 0.5
        z = pos[:, 1]
        tu, tv = u[tri], v[tri]                         # T x 3
        i0 = np.ceil(tu.min(1)).astype(np.int64); i1 = np.floor(tu.max(1)).astype(np.int64)
        j0 = np.ceil(tv.min(1)).astype(np.int64); j1 = np.floor(tv.max(1)).astype(np.int64)
        i0 = np.maximum(i0, 0); j0 = np.maximum(j0, 0)
        i1 = np.minimum(i1, nx - 1); j1 = np.minimum(j1, ny - 1)
        w, h = i1 - i0 + 1, j1 - j0 + 1
        ok = (w > 0) & (h > 0)
        # signed doubled area; degenerate (vertical) triangles are dropped
        ax, ay = tu[:, 0], tv[:, 0]
        bx, by = tu[:, 1] - ax, tv[:, 1] - ay
        cx, cy = tu[:, 2] - ax, tv[:, 2] - ay
        area = bx * cy - by * cx
        ok &= np.abs(area) > 1e-9
        tex = None
        if colour and pr.get("img") is not None and pr.get("uv") is not None:
            tex = np.asarray(Image.open(io.BytesIO(pr["img"])).convert("RGB"))
            uvs = pr["uv"]
        K = np.maximum(w, h)
        cells, zs, cols = [], [], []
        for k in np.unique(K[ok]):
            sel = np.flatnonzero(ok & (K == k))
            # chunk so that a chunk holds <= ~4M samples
            step = max(1, 4_000_000 // int(k * k))
            oj, oi = np.mgrid[0:k, 0:k]
            oj = oj.ravel(); oi = oi.ravel()
            for s in range(0, len(sel), step):
                t = sel[s:s + step]
                I = i0[t, None] + oi[None]; J = j0[t, None] + oj[None]
                m = (I <= i1[t, None]) & (J <= j1[t, None])
                px, py = I - ax[t, None], J - ay[t, None]
                inv = 1.0 / area[t, None]
                l1 = (px * cy[t, None] - py * cx[t, None]) * inv
                l2 = (bx[t, None] * py - by[t, None] * px) * inv
                l0 = 1.0 - l1 - l2
                eps = -1e-6
                m &= (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
                if not m.any():
                    continue
                tt = np.broadcast_to(t[:, None], m.shape)[m]
                L0, L1, L2 = l0[m], l1[m], l2[m]
                vt = tri[tt]
                zs.append((L0 * z[vt[:, 0]] + L1 * z[vt[:, 1]] + L2 * z[vt[:, 2]]).astype(np.float32))
                cells.append(J[m] * nx + I[m])
                if tex is not None:
                    uu = L0 * uvs[vt[:, 0], 0] + L1 * uvs[vt[:, 1], 0] + L2 * uvs[vt[:, 2], 0]
                    vv = L0 * uvs[vt[:, 0], 1] + L1 * uvs[vt[:, 1], 1] + L2 * uvs[vt[:, 2], 1]
                    th, tw = tex.shape[:2]
                    cols.append(tex[np.clip(vv * th, 0, th - 1).astype(np.int32),
                                    np.clip(uu * tw, 0, tw - 1).astype(np.int32)])
        if not cells:
            continue
        c = np.concatenate(cells); zz = np.concatenate(zs)
        o = np.lexsort((zz, c))                       # highest sample per cell = last
        c, zz = c[o], zz[o]
        last = np.flatnonzero(np.r_[c[1:] != c[:-1], True])
        c, zz = c[last], zz[last]
        up = zz > top[c]
        top[c[up]] = zz[up]
        if tex is not None:
            rgb[c[up]] = np.concatenate(cols)[o][last][up]
    top[~np.isfinite(top)] = np.nan
    return top.reshape(ny, nx), (rgb.reshape(ny, nx, 3) if colour else None)


def block_field(e, n, v, q, min_n, ext, hx, hy, block=50.0, cell=H_CELL):
    """per-block percentile q of samples (E, N, value) -> despiked, smooth (hy, hx)
    grid with nodes at ext[0] + i*cell, ext[1] + j*cell; blocks of `block` metres"""
    BLK = block
    bx = int(np.ceil((ext[2] - ext[0]) / BLK)); by = int(np.ceil((ext[3] - ext[1]) / BLK))
    bi = np.clip(((e - ext[0]) // BLK).astype(int), 0, bx - 1)
    bj = np.clip(((n - ext[1]) // BLK).astype(int), 0, by - 1)
    key = bj * bx + bi
    order = np.argsort(key, kind="stable")
    ks, vs = key[order], v[order]
    starts = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
    blk = np.full(by * bx, np.nan)
    for s0, s1 in zip(starts, np.r_[starts[1:], len(ks)]):
        if s1 - s0 >= min_n:
            blk[ks[s0]] = np.percentile(vs[s0:s1], q)
    blk = blk.reshape(by, bx)
    # despike: drop blocks > 1.5 m off the median of their valid neighbours
    pad = np.pad(blk, 1, constant_values=np.nan)
    nb = np.stack([pad[1 + dj:1 + dj + by, 1 + di:1 + di + bx]
                   for dj in (-1, 0, 1) for di in (-1, 0, 1) if dj or di])
    with np.errstate(all="ignore"):
        nmed = np.nanmedian(nb, axis=0)
    bad = np.isfinite(blk) & np.isfinite(nmed) & (np.abs(blk - nmed) > 1.5)
    blk[bad] = np.nan
    jj, ii = np.nonzero(np.isfinite(blk))
    if len(jj) < 3:
        return np.full((hy, hx), np.nanmedian(v)), int(bad.sum())
    pts = np.column_stack([(jj + 0.5) * BLK / cell, (ii + 0.5) * BLK / cell])
    GJ, GI = np.mgrid[0:hy, 0:hx]
    g = griddata(pts, blk[jj, ii], (GJ, GI), method="linear")
    g = np.where(np.isnan(g), griddata(pts, blk[jj, ii], (GJ, GI), method="nearest"), g)
    return ndimage.gaussian_filter(g, 20.0 / cell, mode="nearest"), int(bad.sum())   # sigma 20 m


def osm_water(cache, bbox, ext, to_en, mx, my, mask):
    """OSM natural=water areas (incl. multipolygon relations, e.g. the Spree) minus
    bridges (highway ways with bridge=*, buffered; man_made=bridge areas) and minus
    `mask` (buildings), eroded 1 m at the quay -> bool (my x mx) at MASK_CELL, row 0 =
    south. Overpass result cached in <cache>/osm_water.json."""
    W, S, E, N = bbox
    wcache = os.path.join(cache, "osm_water.json")
    if not os.path.exists(wcache):
        q = (f"[out:json][timeout:90];("
             f'way["natural"="water"]({S},{W},{N},{E});relation["natural"="water"]({S},{W},{N},{E});'
             f'way["waterway"="riverbank"]({S},{W},{N},{E});'
             f'way["highway"]["bridge"]({S},{W},{N},{E});way["man_made"="bridge"]({S},{W},{N},{E});'
             f");out geom;")
        import urllib.request, urllib.parse
        from osm_semantic import OVERPASS          # same endpoint list + fallbacks
        body = None
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "berlin-mesh-tools"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                json.loads(body); break
            except Exception as e:
                print(f"  overpass {url}: {e}")
        if body is None:
            sys.exit("all Overpass endpoints failed - re-run later")
        open(wcache, "wb").write(body)
        print(f"osm water: fetched -> {wcache}")
    osm = json.load(open(wcache))

    def px_ring(geom):
        return [((e - ext[0]) / MASK_CELL, (n - ext[1]) / MASK_CELL)
                for e, n in (to_en(g["lon"], g["lat"]) for g in geom)]

    def stitch(ways):
        """join open member ways into closed rings by matching end points"""
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

    wimg = Image.new("L", (mx, my), 0); wdr = ImageDraw.Draw(wimg)
    holes, bridges_n, water_n = [], 0, 0
    for el in osm.get("elements", []):
        t = el.get("tags", {})
        key = lambda g: (round(g["lat"], 7), round(g["lon"], 7))
        if t.get("natural") == "water" or t.get("waterway") == "riverbank":
            if el["type"] == "way" and el.get("geometry"):
                wdr.polygon(px_ring(el["geometry"]), fill=1); water_n += 1
            elif el["type"] == "relation":
                for role in ("outer", "inner"):
                    mem = [[key(g) for g in m["geometry"]] for m in el.get("members", [])
                           if m.get("role") == role and m.get("geometry")]
                    for ring in stitch(mem):
                        pts = px_ring([{"lat": la, "lon": lo} for la, lo in ring])
                        if len(pts) > 2:
                            (wdr.polygon(pts, fill=1) if role == "outer" else holes.append(pts))
                water_n += 1
        elif t.get("man_made") == "bridge" and el.get("geometry"):
            holes.append(px_ring(el["geometry"])); bridges_n += 1
        elif "highway" in t and t.get("bridge") and t["bridge"] != "no" and el.get("geometry"):
            wdr.line(px_ring(el["geometry"]), fill=0, width=int(12 / MASK_CELL), joint="curve")
            bridges_n += 1
    for h in holes:
        if len(h) > 2: wdr.polygon(h, fill=0)
    water = np.array(wimg, dtype=bool) & ~mask
    water = ndimage.binary_erosion(water, iterations=2)       # 1 m grace at the quay edge
    print(f"water: {water_n} areas, {bridges_n} bridges, {water.mean()*100:.1f} % of the level")
    return water


# Strassenbefahrung 2014 (Geoportal Berlin) layers that count as road surface for
# ROAD_CLEARANCE_PLAN.md: carriageway, parking lanes/bays, bus bays, tram tracks.
# Not road: cl_gehweg, cj_fussgaengerzone, ce_gruenflaeche, cg_baustelle, ch_radweg.
ROAD_WFS = "https://gdi.berlin.de/services/wfs/strassenbefahrung"
ROAD_LAYERS = ("cm_fahrbahn", "ck_parkflaeche", "ca_haltebereich_bus", "bz_gleiskoerper_strab")
ROAD_ATTR = "Strassenbefahrung 2014: Geoportal Berlin, dl-de/zero-2.0"
ROAD_OSM_GAP = 8.0      # m, wfs mode: OSM roads this far from any survey polygon are added
ROAD_NOMOTOR_W = 14.0   # m, swath around OSM ways closed to cars that is not road (3 m off car roads)


def road_mask(mode, cache, bbox, ext, to_en, mx, my):
    """Road surface on the MASK_CELL lattice (my x mx, row 0 = south) for the road
    clearance rule. mode 'wfs': Strassenbefahrung polygons (one cached bbox request
    per layer, <cache>/roads_wfs.json), plus OSM roads where the survey has nothing
    within ROAD_OSM_GAP m; WFS down -> OSM only. mode 'osm': OSM way[highway]
    buffered by lanes x 3.25 m or ROAD_WIDTH (<cache>/osm_roads.json).
    Returns (mask, {layer: mask}, note); mode 'off' -> (None, {}, '')."""
    if mode == "off":
        return None, {}, ""
    import urllib.request, urllib.parse
    W, S, E, N = bbox
    C = MASK_CELL

    def px(lon, lat):
        e, n = to_en(lon, lat)
        return ((e - ext[0]) / C, (n - ext[1]) / C)

    layers, src = {}, []
    if mode == "wfs":
        rcache = os.path.join(cache, "roads_wfs.json")
        if not os.path.exists(rcache):
            feats = []
            try:
                for layer in ROAD_LAYERS:
                    q = urllib.parse.urlencode({
                        "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature",
                        "TYPENAMES": "strassenbefahrung:" + layer, "OUTPUTFORMAT": "application/json",
                        "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
                        "BBOX": f"{S},{W},{N},{E},urn:ogc:def:crs:EPSG::4326", "COUNT": "50000"})
                    req = urllib.request.Request(ROAD_WFS + "?" + q, headers={"User-Agent": "berlin-mesh-tools"})
                    with urllib.request.urlopen(req, timeout=180) as r:
                        fc = json.loads(r.read())
                    for f in fc.get("features", []):
                        f["properties"] = {"_layer": layer}          # geometry is all we use
                    feats += fc.get("features", [])
                json.dump({"type": "FeatureCollection", "features": feats}, open(rcache, "w"))
                print(f"roads: fetched {len(feats)} polygons from the Strassenbefahrung -> {rcache}")
            except Exception as e:
                print(f"  roads wfs: {e} -> OSM fallback (not cached, retried next run)")
        if os.path.exists(rcache):
            for f in json.load(open(rcache))["features"]:
                g, ly = f.get("geometry") or {}, f["properties"]["_layer"]
                polys = ([g["coordinates"]] if g.get("type") == "Polygon" else
                         g.get("coordinates", []) if g.get("type") == "MultiPolygon" else [])
                if ly not in layers:
                    layers[ly] = [Image.new("L", (mx, my), 0), Image.new("L", (mx, my), 0)]
                for poly in polys:
                    for k, ring in enumerate(poly):        # ring 0 outer, then holes
                        pts = [px(c[1], c[0]) if c[0] > 40 else px(c[0], c[1]) for c in ring]
                        if len(pts) > 2:
                            ImageDraw.Draw(layers[ly][k > 0]).polygon(pts, fill=1)
            layers = {ly: np.array(o, bool) & ~np.array(h, bool) for ly, (o, h) in layers.items()}
            src.append("Strassenbefahrung 2014 WFS (" + ", ".join(ly for ly in ROAD_LAYERS if ly in layers) + ")")
    wfs = np.zeros((my, mx), bool)
    for m in layers.values():
        wfs |= m

    # OSM: fallback (WFS down / mode osm) and gap filler for roads the survey lacks
    ocache = os.path.join(cache, "osm_roads.json")
    if not os.path.exists(ocache):
        from osm_semantic import OVERPASS
        q = f'[out:json][timeout:90];way["highway"]({S},{W},{N},{E});out geom;'
        body = None
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "berlin-mesh-tools"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                json.loads(body); break
            except Exception as e:
                body = None
                print(f"  overpass {url}: {e}")
        if body is not None:
            open(ocache, "wb").write(body)
            print(f"roads: osm highways fetched -> {ocache}")
    osm = np.zeros((my, mx), bool)
    if os.path.exists(ocache):
        from osm_semantic import ROAD_WIDTH
        oimg = Image.new("L", (mx, my), 0); odr = ImageDraw.Draw(oimg)
        pimg = Image.new("L", (mx, my), 0); nimg = Image.new("L", (mx, my), 0)
        for el in json.load(open(ocache)).get("elements", []):
            t, geom = el.get("tags", {}), el.get("geometry")
            hw = t.get("highway")
            if (hw in ("pedestrian", "footway") and t.get("area") == "yes" and geom
                    and geom[0] == geom[-1]):                 # Pariser Platz: survey says Fahrbahn
                ImageDraw.Draw(pimg).polygon([px(g["lon"], g["lat"]) for g in geom], fill=1)
            if (not geom or t.get("tunnel") in ("yes", "building_passage") or t.get("area") == "yes"
                    or t.get("layer", "0").startswith("-")):
                continue
            acc = {t.get("access"), t.get("motor_vehicle")}
            if hw == "pedestrian" or hw in ROAD_WIDTH and "no" in acc or hw == "service" and "destination" in acc:
                # closed to through traffic (Pariser Platz ring: Fahrbahn in the survey,
                # service + motor_vehicle=destination / access=no in OSM) -> square, not road
                ImageDraw.Draw(nimg).line([px(g["lon"], g["lat"]) for g in geom], fill=1,
                                          width=int(round(ROAD_NOMOTOR_W / C)), joint="curve")
                continue
            if hw not in ROAD_WIDTH:
                continue
            lanes = t.get("lanes", "")
            w = float(lanes) * 3.25 if lanes.replace(".", "").isdigit() else ROAD_WIDTH[hw]
            w = max(w, ROAD_WIDTH[hw] * 0.6) / C
            pts = [px(g["lon"], g["lat"]) for g in geom]
            odr.line(pts, fill=1, width=max(1, int(round(w))), joint="curve")
            for u, v in (pts[0], pts[-1]):                    # round caps
                odr.ellipse([u - w / 2, v - w / 2, u + w / 2, v + w / 2], fill=1)
        osm = np.array(oimg, bool)
        ped = np.array(pimg, bool) | (np.array(nimg, bool) & ~ndimage.binary_dilation(osm, iterations=int(3 / C)))
        layers = {ly: m & ~ped for ly, m in layers.items()}
        wfs &= ~ped
        osm &= ~ped
        if ped.any():
            src.append("minus OSM pedestrian areas and car-free ways")
    elif layers:
        print("  ! no OSM highways (Overpass down): pedestrian areas surveyed as Fahrbahn "
              "(Pariser Platz) count as road this run")
    if layers:
        gap = ndimage.distance_transform_edt(~wfs) * C > ROAD_OSM_GAP
        # ... and OSM road inside narrow survey gaps (junction centres missing in 2014)
        fill = osm & (gap | ndimage.binary_closing(wfs, iterations=int(10 / C)) & ~wfs)
        if fill.any():
            layers["osm_gap"] = fill
            src.append(f"OSM highways > {ROAD_OSM_GAP:g} m from any survey polygon or in gaps < 20 m")
    elif osm.any():
        layers["osm"] = osm
        src.append("OSM highways buffered lanes x 3.25 m / ROAD_WIDTH")
    road = np.zeros((my, mx), bool)
    for m in layers.values():
        road |= m
    if not road.any():
        sys.exit("--roads: no road data (WFS and Overpass failed) - re-run later or use --roads off")
    print(f"roads: {road.sum()*C*C/1e4:.2f} ha = {road.mean()*100:.0f} % of the level; " +
          ", ".join(f"{ly} {m.sum()*C*C/1e4:.2f} ha" for ly, m in layers.items()))
    if layers and "osm" not in layers and osm.any():
        both = wfs & osm
        print(f"  survey vs OSM: {both.sum()/max(osm.sum(), 1)*100:.0f} % of the OSM road buffer "
              f"lies in survey road polygons")
    return road, layers, "; ".join(src)


OBST_NOTE = ("[{p: [[x, z], ...] closed outline, h: height above road m (p90), a: area m2}]; "
             "whatever the mesh shows rising from the street (stalls, vehicles, fences, "
             "site hoardings), minus buildings, water, trees and facade noise")


def thin_walls(nd, hard, base, green, valid, mask, C):
    """Thin tall walls (site hoardings, fences): cells of `hard` OBST_WALL_H tall, not green,
    with street ground (< 0.7 m) within OBST_WALL_SIDE on both sides along one of the four
    axes; pieces lined up within OBST_WALL_GAP are bridged where something tall (a tree crown
    over the wall) hides the wall, then pieces >= OBST_WALL_LEN long are kept.
    Returns (wall cells, bridge cells, kept-piece mask)."""
    my, mx = nd.shape
    low = valid & ~mask & (nd < 0.7)
    R = max(1, int(round(OBST_WALL_SIDE / C)))
    def shifted(m, dj, di):
        o = np.zeros_like(m)
        o[max(0, dj):my + min(0, dj), max(0, di):mx + min(0, di)] = \
            m[max(0, -dj):my - max(0, dj), max(0, -di):mx - max(0, di)]
        return o
    def low_toward(dj, di):            # street ground within R cells in direction (dj, di)
        o = np.zeros_like(low)
        for s in range(1, R + 1):
            o |= shifted(low, -dj * s, -di * s)
        return o
    both = np.zeros_like(low)
    for dj, di in ((0, 1), (1, 0), (1, 1), (1, -1)):
        both |= low_toward(dj, di) & low_toward(-dj, -di)
    wc = hard & (nd >= OBST_WALL_H[0]) & (nd <= OBST_WALL_H[1]) & (green < 0.2) & both
    # pieces: centre, axis, end points
    wl, wn = ndimage.label(wc, structure=np.ones((3, 3)))
    ends, axes, lens = [], [], []
    for k, sl in enumerate(ndimage.find_objects(wl)):
        cj, ci = np.nonzero(wl[sl] == k + 1)
        if len(cj) < 3:
            continue
        p = np.c_[ci + sl[1].start, cj + sl[0].start].astype(np.float64)
        c = p.mean(0)
        ev, evec = np.linalg.eigh(np.cov((p - c).T))
        ax = evec[:, 1]
        q = (p - c) @ ax
        for e in (c + ax * q.min(), c + ax * q.max()):
            ends.append((k, e[0], e[1]))
        axes.append((k, ax, (q.max() - q.min() + 1) * C))
    ax_of = {k: (ax, ln) for k, ax, ln in axes}
    bridge = np.zeros_like(wc)
    tallish = base & (nd >= 1.5)
    if len(ends) > 1:
        from scipy.spatial import cKDTree
        P = np.array([(x, y) for _, x, y in ends])
        img = Image.new("L", (mx, my), 0); dr = ImageDraw.Draw(img)
        for i, j in cKDTree(P).query_pairs(OBST_WALL_GAP / C):
            ka, kb = ends[i][0], ends[j][0]
            if ka == kb:
                continue
            v = P[j] - P[i]; L = np.hypot(*v)
            if L < 1.0:
                continue
            v = v / L
            # aligned with every piece long enough to have a direction (>= 2 m), at least one
            ok = [abs(v @ ax_of[k][0]) >= np.cos(np.radians(25)) for k in (ka, kb) if ax_of[k][1] >= 2.0]
            if not ok or not all(ok):
                continue
            s = np.linspace(0, 1, int(L * 2) + 2)
            u = np.clip(np.round(P[i, 0] + v[0] * L * s).astype(int), 0, mx - 1)
            w = np.clip(np.round(P[i, 1] + v[1] * L * s).astype(int), 0, my - 1)
            if not (tallish | wc)[w, u].all():          # open street in the gap: a way through
                continue
            dr.line([(P[i, 0], P[i, 1]), (P[j, 0], P[j, 1])], fill=1, width=3)
        bridge = np.array(img, bool) & (tallish | wc) & ~wc
    wl, wn = ndimage.label(wc | bridge, structure=np.ones((3, 3)))
    keep = np.zeros(wn + 1, bool)
    for k, sl in enumerate(ndimage.find_objects(wl)):
        m = wl[sl] == k + 1
        mw = m & wc[sl]
        if mw.sum() * C * C < 2.0 or np.percentile(nd[sl][mw], 90) < OBST_WALL_H[0]:
            continue
        cj, ci = np.nonzero(m)
        p = np.c_[ci, cj] * C
        ev, evec = np.linalg.eigh(np.cov((p - p.mean(0)).T))
        keep[k + 1] = np.ptp((p - p.mean(0)) @ evec[:, 1]) + C >= OBST_WALL_LEN
    return wc, bridge, keep[wl]


def street_ground(t, height, mask, C=MASK_CELL):
    """(road model, t - road, local ground offset gr) on the C lattice of `t` (0.5 m top surface,
    NaN = gap): height above the street = t - road - gr, absolute street = road + gr."""
    my, mx = t.shape
    # road model on the 0.5 m lattice (height grid nodes at x0 + i*H_CELL)
    hy, hx = height.shape
    J, I = np.meshgrid((np.arange(my) + 0.5) * C / H_CELL, (np.arange(mx) + 0.5) * C / H_CELL,
                       indexing="ij")
    road = ndimage.map_coordinates(height.astype(np.float64), [J, I], order=1, mode="nearest")
    # local ground: the smooth road model misses +-1 m bumps (squares, ramps, kerb
    # lines), too coarse for a 0.5 m threshold. Morphological opening of the
    # residual (16 m square) keeps every surface wider than 16 m in all directions
    # (roads, squares, slopes) and removes everything narrower (stalls, cars,
    # vehicles, fences); buildings and mesh gaps do not take part.
    res = t - road
    bnear = ndimage.binary_dilation(mask, iterations=1)
    rr = np.where(np.isfinite(res) & ~bnear, res, np.inf)
    win = int(round(OBST_GROUND_WIN / C))
    gr = ndimage.maximum_filter(ndimage.minimum_filter(rr, size=win), size=win)
    gr = np.clip(np.where(np.isfinite(gr), gr, 0.0), -OBST_GROUND_DEV, OBST_GROUND_DEV)
    gr = ndimage.gaussian_filter(gr, 1.0 / C)
    return road, res, gr


_DBG = {}       # last obstacle_layer internals (band, nd, sup, ...) for build_clutter / probes


def car_band(prims, x0, y0, mx, my, cell, street, lo, hi, dens=25.0, steep=0.7):
    """3D mesh surface inside the car-height band [street + lo, street + hi], per cell (m2).

    The top-surface raster only sees what is highest; a container, hoarding or lorry also has
    side faces at car height, a tree crown, lamp head or sign above the street has none there.
    Every triangle whose height (relative to `street`, my x mx absolute surface height on the
    lattice x0 + (i + 0.5) * cell) reaches into the band is sampled at ~`dens` points / m2;
    points inside the band add their share of the triangle's 3D area to their cell. Only
    triangles steeper than |n_up| < `steep` count (ground, kerbs and tops are near-horizontal),
    so a cell's value is the side-face area at car height there (a 1.7 m high vertical face
    along a 0.5 m cell = 0.85 m2). Returns float32 (my x mx)."""
    acc = np.zeros(my * mx, np.float64)
    rng = np.random.default_rng(0)
    for pr in prims:
        pos = pr["pos"].astype(np.float64)
        tri = pr["idx"].reshape(-1, 3).astype(np.int64)
        if not len(tri):
            continue
        vi = np.floor((pos[:, 0] - x0) / cell).astype(np.int64)
        vj = np.floor((-pos[:, 2] - y0) / cell).astype(np.int64)
        vin = (vi >= 0) & (vi < mx) & (vj >= 0) & (vj < my)
        rel = np.full(len(pos), np.nan)
        rel[vin] = pos[vin, 1] - street[vj[vin], vi[vin]]
        tr = rel[tri]
        ok = np.isfinite(tr).all(1) & (tr.max(1) > lo) & (tr.min(1) < hi)
        if not ok.any():
            continue
        t = tri[ok]
        A, B, Cc = pos[t[:, 0]], pos[t[:, 1]], pos[t[:, 2]]
        nrm = np.cross(B - A, Cc - A)
        ar2 = np.linalg.norm(nrm, axis=1)
        good = ar2 > 1e-9
        up = np.abs(nrm[:, 1]) / np.maximum(ar2, 1e-12)
        good &= up < steep
        if not good.any():
            continue
        t, A, B, Cc, ar, tr = t[good], A[good], B[good], Cc[good], ar2[good] / 2, tr[ok][good]
        ns = np.clip(np.ceil(ar * dens), 1, 4000).astype(np.int64)
        k = np.repeat(np.arange(len(t)), ns)
        u, v = rng.random(len(k)), rng.random(len(k))
        f = u + v > 1
        u[f], v[f] = 1 - u[f], 1 - v[f]
        P = A[k] + (B[k] - A[k]) * u[:, None] + (Cc[k] - A[k]) * v[:, None]
        rr = tr[k, 0] + (tr[k, 1] - tr[k, 0]) * u + (tr[k, 2] - tr[k, 0]) * v
        w = (ar / ns)[k]
        pi = np.floor((P[:, 0] - x0) / cell).astype(np.int64)
        pj = np.floor((-P[:, 2] - y0) / cell).astype(np.int64)
        m = (rr >= lo) & (rr <= hi) & (pi >= 0) & (pi < mx) & (pj >= 0) & (pj < my)
        acc += np.bincount(pj[m] * mx + pi[m], weights=w[m], minlength=my * mx)
    return acc.reshape(my, mx).astype(np.float32)


def obstacle_layer(a, top, ortho, mask, water, height, trees, ext, out, spawn, roads=None, blocks=False,
                   walls=False, prims=None):
    """Height channel of OBSTACLES_PLAN.md: mesh top surface minus a local street
    ground -> objects standing on the street. Returns the list for level.json.

    top/ortho: 0.25 m top-surface raster + texture colour (raster_top), pooled
    here onto the 0.5 m building-mask lattice (row 0 = south).
    walls=True (build_clutter.py): thin walls (thin_walls) and flat-topped blocks that sit in a
    dropped mixed component are added as objects of their own.
    """
    C = MASK_CELL
    my, mx = mask.shape
    import warnings
    with warnings.catch_warnings():                       # max of the 2x2 sub-cells
        warnings.simplefilter("ignore", RuntimeWarning)   # (all-NaN = mesh gap)
        t = np.nanmax(np.nanmax(top.reshape(my, 2, mx, 2), axis=3), axis=1)
    rgb = ortho.reshape(my, 2, mx, 2, 3).astype(np.float32)
    # vegetation by texture colour (excess green), per 0.25 m sample -> fraction per cell
    r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    green = (g_ > 1.08 * r_) & (g_ > 1.02 * b_) & (2 * g_ - r_ - b_ > 12)
    green = green.mean(axis=(1, 3))
    lum = rgb.mean(axis=4)                                 # 0.25 m luminance, for texture
    lum1, lum2 = lum.mean(axis=(1, 3)), (lum ** 2).mean(axis=(1, 3))
    rgb = rgb.mean(axis=(1, 3))

    road, res, gr = street_ground(t, height, mask, C)
    bnear = ndimage.binary_dilation(mask, iterations=1)
    nd = res - gr                                          # height above the street
    street = road + gr                                     # absolute street surface (car-height test)
    valid = np.isfinite(nd)
    nd = np.where(valid, nd, 0.0)

    # ---- candidates ----
    # walls = LoD2 buildings plus mesh structures taller than --obst-max that LoD2
    # lacks (new buildings, Brandenburger Tor): bare (non-green) blobs >= 50 m2
    tall = valid & ~mask & (nd > a.obst_max) & (green < 0.3)
    tl, tn = ndimage.label(tall)
    big = np.r_[False, ndimage.sum(tall, tl, np.arange(1, tn + 1)) * C * C >= 50] if tn else np.zeros(1, bool)
    struct = mask | big[tl]
    bdist = ndimage.distance_transform_edt(~struct) * C   # m to the nearest wall
    crown = np.zeros_like(mask)
    if trees:
        ti = np.array([((x - ext[0]) / C, (-z - ext[1]) / C) for x, z, *_ in trees])
        seed = np.zeros_like(mask)
        ii = np.clip(ti[:, 0].astype(int), 0, mx - 1); jj = np.clip(ti[:, 1].astype(int), 0, my - 1)
        seed[jj, ii] = True
        crown = ndimage.distance_transform_edt(~seed) * C < OBST_CROWN_R
    base = valid & ~water & ~mask & (ndimage.distance_transform_edt(~mask) * C > 0.5 * C)
    raised = base & (nd > a.obst_min)
    hi = raised & (nd > a.obst_max)                       # building parts, crowns
    cand = raised & ~hi
    # register crowns only where the texture is at least a little green: a white
    # tent row between street trees stays an obstacle
    veg = cand & ((green > 0.5) | crown & (green > 0.15))
    # facade band: a raised zone glued to a wall that reaches > 4 m is the mesh
    # facade/overhang outside the LoD2 footprint (registration offset);
    # drop it within 3 m of the wall, low parts included (the facade's skirt).
    lab, n = ndimage.label(raised | (base & (nd > 0.3)), structure=np.ones((3, 3)))
    near = bdist <= 1.0
    touch = np.zeros(n + 1, bool); touch[np.unique(lab[near & (lab > 0)])] = True
    tall_near = np.zeros(n + 1, bool)
    tall_near[np.unique(lab[(bdist <= OBST_FACADE_BAND) & (nd > OBST_FACADE_H) & (lab > 0)])] = True
    facade = cand & (touch & tall_near)[lab] & (bdist <= OBST_FACADE_BAND)
    # crowns drape down at their rim (mesh smoothing): the low fringe around a crown
    # is foliage too, and a crown over the kerb lane is high enough to drive under
    vegz = ndimage.binary_dilation(veg | hi & (green > 0.3) | crown & raised & (nd > OBST_FACADE_H),
                                   iterations=int(round(OBST_VEG_RIM / C)))
    hard = cand & ~vegz & ~facade

    # ---- cleanup ----
    hard = ndimage.binary_opening(hard, structure=np.ones((2, 2)))   # 0.5 m slivers
    road = roads[0] if roads is not None else None
    if road is not None:
        # road clearance (ROAD_CLEARANCE_PLAN.md): on the road surface only what rises
        # > --road-min stays an obstacle (containers, buses); lower things (parked cars,
        # bollards, barriers) are cleared there. Off the road nothing changes.
        lab0, n0 = ndimage.label(hard, structure=np.ones((3, 3)))
        ids0 = np.arange(1, n0 + 1)
        rfrac0 = ndimage.mean(road.astype(np.float32), lab0, ids0) if n0 else np.zeros(0)
        rmax0 = (ndimage.maximum(np.where(road, nd, -np.inf), lab0, ids0) if n0 else np.zeros(0))
        core = hard & ~(road & (nd <= a.road_min))
        # a tall object keeps its blobby low rim on the road (up to 1 m around its core)
        core |= ndimage.binary_dilation(core & road, iterations=2) & hard & road
        # mostly on the road and nowhere > road_min there: the remainder goes too
        # (the pavement half of a parked car)
        gone = np.r_[False, (rfrac0 >= 0.6) & (rmax0 <= a.road_min)]
        hard0, hard = hard, ndimage.binary_opening(core & ~gone[lab0], structure=np.ones((2, 2)))

    # flat-topped blocks (blocks=True; build_clutter.py): site containers, huts, kiosks, lorries
    # standing against a wall fall into the facade band, the 16 m ground opening can take their
    # top for ground (wall + block wider than the window) and their cut side is not steep. A
    # flat top (3x3 relief < 0.5 m) of >= OBST_BLOCK_AREA, >= 2.5 m wide, not green, whose p90
    # top stands >= OBST_BLOCK_H over the street in a ring 1-3 m around it (no building cells)
    # and >= 2 m under the roof next to it (an OSM/mesh offset strip of the roof is not a block)
    # is kept whole, with its own height.
    rescue, rh = np.zeros_like(mask), np.zeros(mask.shape, np.float32)
    nblk = 0
    if blocks:
        flat = (ndimage.maximum_filter(np.where(valid, t, -1e3), size=3)
                - ndimage.minimum_filter(np.where(valid, t, 1e3), size=3)) < 0.5
        cb = base & raised & flat & (green < 0.1) & ~veg
        bl_, _ = ndimage.label(cb, structure=np.ones((3, 3)))
        for k, sl in enumerate(ndimage.find_objects(bl_)):
            if sl is None:
                continue
            j0, j1 = max(sl[0].start - 8, 0), min(sl[0].stop + 8, my)
            i0, i1 = max(sl[1].start - 8, 0), min(sl[1].stop + 8, mx)
            s2 = (slice(j0, j1), slice(i0, i1))
            m = bl_[s2] == k + 1
            if m.sum() * C * C < OBST_BLOCK_AREA or ndimage.binary_erosion(m, iterations=2).sum() * C * C < 2.0:
                continue
            rs = res[s2]
            q25, q75, q90 = np.percentile(rs[m], [25, 75, 90])
            if q75 - q25 > 1.0:
                continue
            grow = ndimage.binary_dilation(m, iterations=2) & cand[s2]          # edges back
            ring = (ndimage.binary_dilation(grow, iterations=6) & ~ndimage.binary_dilation(grow, iterations=2)
                    & ~bnear[s2] & valid[s2])
            if ring.sum() < 8:
                continue
            h = q90 - float(np.median(rs[ring]))
            if not OBST_BLOCK_H <= h <= a.obst_max:
                continue
            wall = ndimage.binary_dilation(grow, iterations=6) & mask[s2] & valid[s2]
            if wall.sum() >= 8 and float(np.median(rs[wall])) - q90 < 2.0:
                continue
            rescue[s2] |= grow; rh[s2] = np.where(grow, np.maximum(rh[s2], h), rh[s2]); nblk += 1
        hard = hard | rescue

    def objects(hard):
        """connected components of `hard` + the per-object filters -> keep flags"""
        lab, n = ndimage.label(hard, structure=np.ones((3, 3)))
        ids = np.arange(1, n + 1)
        area = ndimage.sum(np.ones_like(nd), lab, ids) * C * C
        hp90 = np.array([np.percentile(nd[sl][lab[sl] == k], 90)
                         for k, sl in zip(ids, ndimage.find_objects(lab))]) if n else np.zeros(0)
        gfrac = ndimage.mean(green, lab, ids) if n else np.zeros(0)
        border = np.zeros(n + 1, bool)
        border[np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]])] = True
        border[np.unique(lab[ndimage.binary_dilation(~valid) & (lab > 0)])] = True   # mesh gap edge
        # shadowed foliage is not green: a piece mostly enclosed by vegetation is a
        # canopy gap / dark crown part (Tiergarten), not a stall
        ring = ndimage.binary_dilation(hard, iterations=2) & ~hard
        rlab = ndimage.grey_dilation(lab, size=5) * ring
        ring_veg = ndimage.mean((vegz | veg).astype(np.float32), rlab, ids) if n else np.zeros(0)
        # steep sides: an object stands up from the street within ~1 m of its outline
        # on (nearly) all sides; a ground ridge (quay edge, ramp, embankment) falls off
        # gently on at least one side. Relief across the outline relative to the
        # object height, 30th percentile along the outline.
        relief = ndimage.maximum_filter(nd, size=3) - ndimage.minimum_filter(nd, size=5)
        edge = hard & ~ndimage.binary_erosion(hard)
        steep = (ndimage.labeled_comprehension(relief, lab * edge, ids, lambda v: np.percentile(v, 30),
                                               np.float64, 0.0) / np.maximum(hp90, 0.1)) if n else np.zeros(0)
        # objects need texture: in deep shadow the mesh is noisy (smooth 0.5-2 m bumps
        # on dark asphalt, dark crown parts); real objects (cars, stelae, barriers,
        # stalls, tents with their edges and shade) show contrast in the photo.
        # Luminance std over the object's 0.25 m samples.
        if n:
            m1, m2 = ndimage.mean(lum1, lab, ids), ndimage.mean(lum2, lab, ids)
            tex = np.sqrt(np.maximum(m2 - m1 ** 2, 0))
        else:
            tex = np.zeros(0)
        keep = ((area >= a.obst_min_area) & ~border[1:] & (gfrac < 0.35) & (ring_veg < OBST_VEG_RING)
                & (steep >= OBST_STEEP) & (tex >= OBST_TEX))
        cars = np.zeros(n, bool)
        for k, sl in enumerate(ndimage.find_objects(lab)):
            if not keep[k]:
                continue
            cj, ci = np.nonzero(lab[sl] == k + 1)
            if len(cj) < 3:
                continue
            p = np.column_stack([ci, cj]) * C
            ev, evec = np.linalg.eigh(np.cov((p - p.mean(0)).T))
            q = (p - p.mean(0)) @ evec
            L, Wd = np.ptp(q[:, 1]) + C, np.ptp(q[:, 0]) + C
            cars[k] = 3.4 <= L <= 6.0 and 1.4 <= Wd <= 2.4 and 1.0 <= hp90[k] <= 2.3
        if a.parked_cars == "exclude":
            keep &= ~cars
        return lab, n, area, hp90, keep, cars
    lab, n, area, hp90, keep, cars = objects(hard)
    if blocks and n:
        ids = np.arange(1, n + 1)
        blk = ndimage.mean(rescue.astype(np.float32), lab, ids) >= 0.5
        keep = keep | (blk & (area >= a.obst_min_area))
        hp90 = np.where(blk, np.maximum(hp90, ndimage.maximum(rh, lab, ids)), hp90)
        # a block inside a big mixed component that is not kept (a site container joined to the
        # site's hoarding and ramps, rescue share < 0.5) becomes an object of its own
        nsplit = 0
        if walls:
            pre = np.r_[False, keep][lab]
            bobj = ndimage.binary_opening(rescue & ~pre, structure=np.ones((2, 2)))
            bl2, bn2 = ndimage.label(bobj, structure=np.ones((3, 3)))
            if bn2:
                ids2 = np.arange(1, bn2 + 1)
                a2 = ndimage.sum(bobj, bl2, ids2) * C * C
                ok2 = a2 >= OBST_BLOCK_AREA / 2
                lab = np.where(bl2 > 0, bl2 + n, lab)
                area = np.r_[area, a2]; hp90 = np.r_[hp90, ndimage.maximum(rh, bl2, ids2)]
                keep = np.r_[keep, ok2]; cars = np.r_[cars, np.zeros(bn2, bool)]
                n += bn2; nsplit = int(ok2.sum())
        print(f"flat-topped blocks (containers, huts, lorries; >= {OBST_BLOCK_H:g} m, >= {OBST_BLOCK_AREA:g} m2): "
              f"{nblk} found, {int(blk.sum())} objects kept by this rule"
              + (f", {nsplit} split out of a dropped mixed component" if walls else ""))
    # thin walls (walls=True; build_clutter.py): a site hoarding glued to a crane base or crown
    # fringe forms one big mixed component whose per-object steepness (relief / p90 of the whole)
    # fails; the wall is kept as its own object where it is not already part of a kept one.
    nwall = 0
    if walls:
        wc, bridge, wkeep = thin_walls(nd, hard, base, green, valid, mask, C)
        pre = np.r_[False, keep][lab]
        wobj = (ndimage.binary_dilation(wkeep, iterations=2) & (hard | bridge) & (nd >= a.obst_min)) | wkeep
        wobj = ndimage.binary_opening(wobj, structure=np.ones((2, 2))) & ~pre
        wl, wn = ndimage.label(wobj, structure=np.ones((3, 3)))
        if wn:
            wids = np.arange(1, wn + 1)
            warea = ndimage.sum(wobj, wl, wids) * C * C
            wtouch = np.zeros(wn + 1, bool)
            wtouch[np.unique(np.r_[wl[0], wl[-1], wl[:, 0], wl[:, -1]])] = True
            wtouch[np.unique(wl[ndimage.binary_dilation(~valid) & (wl > 0)])] = True
            wok = (warea >= 1.0) & ~wtouch[1:]
            # height from the visible wall cells (bridged cells carry the crown above the wall)
            whp = np.array([np.percentile(nd[sl][(wl[sl] == k) & wc[sl]], 90)
                            if ((wl[sl] == k) & wc[sl]).any() else OBST_WALL_H[0]
                            for k, sl in zip(wids, ndimage.find_objects(wl))])
            lab = np.where(wl > 0, wl + n, lab)
            area = np.r_[area, warea]; hp90 = np.r_[hp90, whp]
            keep = np.r_[keep, wok]; cars = np.r_[cars, np.zeros(wn, bool)]
            n += wn; nwall = int(wok.sum())
        print(f"thin walls (hoardings, fences; {OBST_WALL_H[0]:g}-{OBST_WALL_H[1]:g} m, street within "
              f"{OBST_WALL_SIDE:g} m on both sides, >= {OBST_WALL_LEN:g} m): {int(wc.sum()) * C * C:.0f} m2 wall "
              f"cells, {int(bridge.sum()) * C * C:.0f} m2 bridged, {nwall} objects added "
              f"({warea[wok].sum() if wn else 0:.0f} m2)")
    # ---- car height (prims given; build_clutter.py): only what the player can see at car height
    # blocks. The scan above looks from above, so a piece of tree crown, a lamp head or a sign over
    # the street became an object although nothing stands under it. A cell of an object stays only
    # where its top is itself at car height (nd <= CAR_BAND[1]) or where the mesh has side faces in
    # the car band (car_band summed over a CAR_REACH disc >= CAR_SIDE m2; the same statistic as
    # audit_roads.py at a contact); holes enclosed by supported cells are filled (a container's roof
    # between its walls). What is left under CAR_MIN_AREA goes.
    ev = {}
    band = None
    if prims is not None and n:
        band = car_band(prims, ext[0], ext[1], mx, my, C, street.astype(np.float64), *CAR_BAND)
        rr_ = int(round(CAR_REACH / C)); yy, xx = np.mgrid[-rr_:rr_ + 1, -rr_:rr_ + 1]
        near = ndimage.convolve(band, (np.hypot(yy, xx) * C <= CAR_REACH).astype(np.float32), mode="constant")
        sup = (valid & (nd <= CAR_BAND[1])) | (near >= CAR_SIDE)
        _DBG.update(band=band, nd=nd, lab=lab.copy(), keep=keep.copy(), road=road, sup=sup)
        sls = ndimage.find_objects(lab)
        ncut, ngone, acut = 0, 0, 0.0
        for k in np.flatnonzero(keep):
            sl = sls[k]
            j0, j1 = max(sl[0].start - 3, 0), min(sl[0].stop + 3, my)
            i0, i1 = max(sl[1].start - 3, 0), min(sl[1].stop + 3, mx)
            s2 = (slice(j0, j1), slice(i0, i1))
            m = lab[s2] == k + 1
            zone = ndimage.binary_dilation(m, iterations=2)
            per = max((m & ~ndimage.binary_erosion(m)).sum() * C, 1.0)
            side = float(band[s2][zone].sum() / per)              # m2 of side face per m of outline
            ms = ndimage.binary_fill_holes(m & sup[s2]) & m
            ms = ndimage.binary_opening(ms, structure=np.ones((2, 2))) if ms.sum() > 4 else ms
            a2 = ms.sum() * C * C
            if a2 < CAR_MIN_AREA:
                keep[k] = False; ngone += 1; acut += area[k]
                lab[s2][m] = 0
                continue
            if a2 < m.sum() * C * C - 1e-6:
                ncut += 1; acut += area[k] - a2
                lab[s2][m & ~ms] = 0
                area[k] = a2
                hp90[k] = np.percentile(nd[s2][ms], 90)
            ev[k] = (round(side, 2), round(float(a2 / max(m.sum() * C * C, 1e-9)), 2))
        print(f"car height ({CAR_BAND[0]:g}-{CAR_BAND[1]:g} m over the street; side faces >= "
              f"{CAR_SIDE:g} m2 within {CAR_REACH:g} m, or the top itself in the band): "
              f"{ngone} objects dropped (nothing at car height: crowns, lamps, signs), {ncut} cut to their "
              f"supported part, {acut:.0f} m2 removed")
    keep_lab = np.r_[False, keep]
    final = keep_lab[lab]
    if road is not None:
        lab0, n0, area0, hp0, keep0, _ = objects(hard0)
        ids0 = np.arange(1, n0 + 1)
        surv0 = ndimage.mean(final.astype(np.float32), lab0, ids0) if n0 else np.zeros(0)
        rf0 = ndimage.mean(road.astype(np.float32), lab0, ids0) if n0 else np.zeros(0)
        removed = keep0 & (surv0 < 0.5)
        rf = ndimage.mean(road.astype(np.float32), lab, np.arange(1, n + 1)) if n else np.zeros(0)
        on_road = keep & (rf >= 0.3)
        sl0 = ndimage.find_objects(lab0)
        print(f"road clearance (> {a.road_min:g} m on {road.sum()*C*C/1e4:.2f} ha of road): "
              f"objects {int(keep0.sum())} -> {int(keep.sum())}, {area0[keep0].sum():.0f} -> "
              f"{area[keep].sum():.0f} m2; removed {int(removed.sum())} "
              f"(road share p50 {np.median(rf0[removed]) if removed.any() else 0:.2f}, "
              f"height p50/90 {np.percentile(hp0[removed], [50, 90]).round(1) if removed.any() else '-'} m)")
        sls = ndimage.find_objects(lab)
        for k in np.flatnonzero(on_road):
            sl = sls[k]
            ce, cn = ext[0] + (sl[1].start + sl[1].stop) / 2 * C, ext[1] + (sl[0].start + sl[0].stop) / 2 * C
            print(f"  kept on road: E {ce:7.1f} N {cn:7.1f}  h {hp90[k]:.1f} m  a {area[k]:.0f} m2  "
                  f"road {rf[k]*100:.0f} %")
        for k in np.flatnonzero(removed & (hp0 >= a.road_min)):
            sl = sl0[k]
            ce, cn = ext[0] + (sl[1].start + sl[1].stop) / 2 * C, ext[1] + (sl[0].start + sl[0].stop) / 2 * C
            print(f"  removed although p90 >= {a.road_min:g} m: E {ce:7.1f} N {cn:7.1f}  h {hp0[k]:.1f} m  "
                  f"a {area0[k]:.0f} m2  road {rf0[k]*100:.0f} %")

    # ---- trace -> polylines (Box2D X, Z) ----
    obstacles = []
    slices = ndimage.find_objects(lab)
    for k in np.flatnonzero(keep):
        sl = slices[k]
        j0, i0 = sl[0].start, sl[1].start
        sub = np.pad(lab[sl] == k + 1, 1).astype(np.float32)
        for ln in contourpy.contour_generator(z=sub).lines(0.5):
            ln = (ln - 1 + [i0, j0]) * C + [ext[0], ext[1]] + C / 2
            if len(ln) < 4:
                continue
            ln = rdp(ln, 0.3)
            if len(ln) < 3:
                continue
            obstacles.append({"p": [[round(e, 2), round(-n_, 2)] for e, n_ in ln],
                              "h": round(float(hp90[k]), 1), "a": round(float(area[k]), 1)})
            if k in ev:
                obstacles[-1]["ev"] = ev[k]
    # ---- report ----
    hs = hp90[keep]
    print(f"obstacles (>= {a.obst_min:g} m): {int(keep.sum())} objects, {area[keep].sum():.0f} m2, "
          f"{len(obstacles)} outlines; dropped: facade {facade.sum()*C*C:.0f} m2, "
          f"vegetation {veg.sum()*C*C:.0f} m2, > {a.obst_max:g} m {hi.sum()*C*C:.0f} m2; "
          f"car-shaped {int((cars & keep).sum())}" + (" (excluded)" if a.parked_cars == "exclude" else ""))
    if len(hs):
        print(f"  height p10/50/90 {np.percentile(hs, [10, 50, 90]).round(1)} m, "
              f"area p50/90/max {np.percentile(area[keep], [50, 90]).round(1)} {area[keep].max():.0f} m2; "
              f"by height <1/1-2/2-4/>4 m: {[(hs < 1).sum(), ((hs >= 1) & (hs < 2)).sum(), ((hs >= 2) & (hs < 4)).sum(), (hs >= 4).sum()]}")
    # straight run along the spawn heading: corridor +-1.2 m must stay free
    se, sn, hd = spawn
    s = np.arange(0, 400, C / 2)
    hit = None
    for off in np.arange(-1.2, 1.25, 0.4):
        e = se + np.sin(hd) * s + np.cos(hd) * off; n_ = sn + np.cos(hd) * s - np.sin(hd) * off
        i = ((e - ext[0]) / C).astype(int); j = ((n_ - ext[1]) / C).astype(int)
        inside = (i >= 0) & (i < mx) & (j >= 0) & (j < my)
        i, j, ss = i[inside], j[inside], s[inside]
        wall = mask[j, i] | water[j, i]
        lim = ss[np.argmax(wall)] if wall.any() else ss[-1]
        ob = final[j, i] & (ss < lim)
        if ob.any() and (hit is None or ss[np.argmax(ob)] < hit):
            hit = float(ss[np.argmax(ob)])
    print(f"  spawn run ahead: " + ("clear up to the first wall" if hit is None else f"OBSTACLE after {hit:.0f} m"))

    if a.debug_obstacles is not None:
        png = a.debug_obstacles or os.path.join(out, f"obstacles_{a.obst_min:g}m.png")
        Image.fromarray(rgb.clip(0, 255).astype(np.uint8)[::-1]).save(png[:-4] + "_ortho.png")
        img = rgb.copy()
        def tint(m, col, w):
            img[m] = img[m] * (1 - w) + np.array(col, np.float32) * w
        tint(mask, (40, 60, 200), 0.45)
        tint(water, (0, 200, 255), 0.5)
        tint(struct & ~mask, (90, 90, 90), 0.5)
        tint(facade, (255, 0, 255), 0.45)
        tint(veg & ~crown, (0, 255, 0), 0.35)
        if road is not None:
            tint(road, (120, 210, 255), 0.3)
        tint(final, (255, 140, 0), 0.6)
        edge = final & ~ndimage.binary_erosion(final)
        img[edge] = (255, 0, 0)
        if a.parked_cars == "include":
            ce = np.r_[False, cars & keep][lab]
            img[ce & ~ndimage.binary_erosion(ce)] = (255, 255, 0)
        if road is not None:
            rm = np.r_[False, removed][lab0]
            img[rm & ~ndimage.binary_erosion(rm)] = (175, 175, 175)
            kr = np.r_[False, on_road][lab]
            tint(kr, (170, 0, 255), 0.7)
            img[kr & ~ndimage.binary_erosion(kr)] = (255, 255, 255)
            img[road & ~ndimage.binary_erosion(road)] = (120, 210, 255)
        im = Image.fromarray(img.clip(0, 255).astype(np.uint8)[::-1])
        dr = ImageDraw.Draw(im)
        for x, z, rad, _ in trees:
            u, v = (x - ext[0]) / C, my - 1 - (-z - ext[1]) / C
            dr.ellipse([u - 3, v - 3, u + 3, v + 3], outline=(0, 255, 0))
        u0, v0 = (se - ext[0]) / C, my - 1 - (sn - ext[1]) / C
        dr.line([u0, v0, u0 + np.sin(hd) * 400, v0 - np.cos(hd) * 400], fill=(255, 255, 255))
        legend = [((40, 60, 200), "LoD2 building (wall)"), ((90, 90, 90), f"mesh > {a.obst_max:g} m, not in LoD2"),
                  ((0, 200, 255), "water"), ((255, 0, 255), "facade band (dropped)"),
                  ((0, 255, 0), "vegetation (dropped) / o register tree"),
                  ((255, 140, 0), f"OBSTACLE >= {a.obst_min:g} m"), ((255, 255, 0), "car-shaped outline"),
                  ((255, 255, 255), "spawn heading")]
        if road is not None:
            legend += [((120, 210, 255), "road surface outline"),
                       ((170, 0, 255), f"kept on road (> {a.road_min:g} m)"),
                       ((175, 175, 175), "removed on road (outline)")]
        dr.rectangle([4, 4, 230, 10 + 13 * len(legend)], fill=(0, 0, 0))
        for k, (col, txt) in enumerate(legend):
            dr.rectangle([8, 9 + 13 * k, 18, 17 + 13 * k], fill=col)
            dr.text((24, 7 + 13 * k), txt, fill=(255, 255, 255))
        im.save(png)
        print(f"  debug -> {png} (+ _ortho.png), 0.5 m/px, north up")
    return obstacles


PIT_MIN = 2.0       # m below the road model: candidate pit cell
PIT_DEPTH = 2.5     # m, median depth a pit needs
PIT_CORE = 30.0     # m2 of the pit at least 4 m wide (ramps, gutters, light wells are narrower)
PIT_RIM = 8.0       # m of the pit's rim on open street at road level (reachable by car)
PIT_NOTE = ("uint8, 1 = pit (mesh top surface >= 2 m under the road model, >= 30 m2 at least 4 m wide, "
            "reachable from the street); row j = north n0 + j*cell. floor: float32 pit-floor height "
            "(NaN off the pits) for cells i0..i0+nx-1, j0..j0+nz-1 of this grid; pits: outline [x, z], "
            "floor height, depth below the road, area; openWalls: LoD2 wall segments [x0, z0, x1, z1] "
            "on the rim of a pit the mesh shows where LoD2 still has a building (demolished)")


def pit_layer(top, mask, water, height, walls, ext, to_en, lonlat0, out, debug=False):
    """Pits the car can fall into: where the mesh top surface lies clearly below
    the street (construction pits, sunken courtyards open to the street).

    top: 0.25 m top-surface raster (raster_top, row 0 = south), pooled to the
    0.5 m mask lattice. Depth = smooth road model (height.bin, which bridges
    a pit) minus the mesh. A candidate component is a pit when it is wide
    (>= PIT_CORE m2 survive a 4 m wide opening), deep (median >= PIT_DEPTH) and
    reachable: >= PIT_RIM m of its 2 m rim ring is open street at road level
    (not LoD2, not water, within 1 m of the road model) and the ring is not
    mostly mesh gap. LoD2 cells may belong to a pit (the model still has a
    demolished building); courtyards inside buildings have no street rim and
    drop out. Writes pit.bin (1 m, water.bin layout) + pit_floor.bin into
    `out`; returns the level.json["pit"] dict, or None without pits.
    """
    import warnings
    C = MASK_CELL
    my, mx = mask.shape
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        t = np.nanmax(np.nanmax(top.reshape(my, 2, mx, 2), axis=3), axis=1)
    hy, hx = height.shape
    J, I = np.meshgrid((np.arange(my) + 0.5) * C / H_CELL, (np.arange(mx) + 0.5) * C / H_CELL, indexing="ij")
    road = ndimage.map_coordinates(height.astype(np.float64), [J, I], order=1, mode="nearest")
    dep = road - t
    valid = np.isfinite(dep)
    dep0 = np.where(valid, dep, 0.0)
    cand = valid & (dep0 > PIT_MIN) & ~water
    lab, n = ndimage.label(cand, structure=np.ones((3, 3)))
    street = valid & ~mask & ~water & (np.abs(dep0) < 1.0)
    disk = np.hypot(*np.mgrid[-4:5, -4:5]) <= 4                # 4 m wide
    pit = np.zeros_like(mask)
    stale = np.zeros_like(mask)
    found = []
    print(f"pits (mesh >= {PIT_MIN:g} m under the road model):")
    for k, s in enumerate(ndimage.find_objects(lab)):
        s2 = (slice(max(0, s[0].start - 8), s[0].stop + 8), slice(max(0, s[1].start - 8), s[1].stop + 8))
        m = lab[s2] == k + 1
        area = m.sum() * C * C
        if area < 15:
            continue
        core = ndimage.binary_opening(m, structure=disk).sum() * C * C
        ring = ndimage.binary_dilation(m, iterations=4) & ~m      # 2 m around
        rim = street[s2][ring].sum() * C * C / 2.0                # m of rim (ring is 2 m wide)
        gap = (~valid[s2][ring]).mean()
        dd = dep0[s2][m]
        d50, inb = float(np.median(dd)), float(mask[s2][m].mean())
        E = ext[0] + (s[1].start + s[1].stop) / 2 * C; N = ext[1] + (s[0].start + s[0].stop) / 2 * C
        why = ("narrow" if core < PIT_CORE else "shallow" if d50 < PIT_DEPTH else
               "no street rim" if rim < PIT_RIM else "mesh gap" if gap > 0.35 else None)
        if area >= 30:
            print(f"  x {E:6.0f} z {-N:6.0f}  {area:5.0f} m2 (4 m core {core:4.0f})  depth p50 {d50:4.1f} "
                  f"max {dd.max():4.1f} m  in LoD2 {inb*100:3.0f} %  street rim {rim:3.0f} m  -> "
                  + (why or "PIT"))
        if why:
            continue
        pit[s2] |= m
        if inb >= 0.2:
            stale[s2] |= m
        found.append(k + 1)
    if not found:
        print("  none")
        return None
    pit = ndimage.binary_fill_holes(pit)          # struts / machines in the pit are part of it
    pit = ndimage.binary_opening(pit, iterations=1)
    # 1 m mask like water.bin: a cell is pit when >= half of its 2x2 sub-cells are
    p2 = np.pad(pit, ((0, my % 2), (0, mx % 2)))
    pz = p2.reshape(p2.shape[0] // 2, 2, p2.shape[1] // 2, 2).mean(axis=(1, 3)) >= 0.5
    pz.astype(np.uint8).tofile(os.path.join(out, "pit.bin"))
    # pit floor: 30th percentile of the mesh within 2 m (ignores struts and beams
    # crossing the pit), per 1 m cell, pit cells only
    fl = np.where(pit & valid, t, np.nan)
    jj, ii = np.nonzero(pz)
    j0, j1, i0, i1 = jj.min(), jj.max() + 1, ii.min(), ii.max() + 1
    sub = np.pad(fl, 4, constant_values=np.nan)[2 * j0:2 * j1 + 8, 2 * i0:2 * i1 + 8]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        from numpy.lib.stride_tricks import sliding_window_view
        win = sliding_window_view(sub, (9, 9))[::2, ::2]           # 4.5 m window per 1 m cell
        floor = np.nanpercentile(win.reshape(win.shape[0], win.shape[1], -1), 30, axis=2)
    floor = floor[:j1 - j0, :i1 - i0].astype(np.float32)
    floor[~pz[j0:j1, i0:i1]] = np.nan
    floor.tofile(os.path.join(out, "pit_floor.bin"))

    # outlines + report
    lab2, n2 = ndimage.label(pit, structure=np.ones((3, 3)))
    pits = []
    lat0, lon0 = lonlat0[1], lonlat0[0]
    for k, s in enumerate(ndimage.find_objects(lab2)):
        m = lab2[s] == k + 1
        dd = dep0[s][m & valid[s]]
        fv = t[s][m & valid[s]]
        E = ext[0] + (np.nonzero(m)[1].mean() + s[1].start + 0.5) * C
        N = ext[1] + (np.nonzero(m)[0].mean() + s[0].start + 0.5) * C
        # lon/lat: invert the ENU frame (two fixed-point steps of to_en)
        lon, lat = lon0 + E / (111320 * np.cos(np.radians(lat0))), lat0 + N / 111132
        for _ in range(2):
            e_, n_ = to_en(lon, lat)
            lon += (E - e_) / (111320 * np.cos(np.radians(lat0))); lat += (N - n_) / 111132
        sub = np.pad(m, 1).astype(np.float32)
        outl = []
        for ln in contourpy.contour_generator(z=sub).lines(0.5):
            ln = (ln - 1 + [s[1].start, s[0].start]) * C + [ext[0], ext[1]] + C / 2
            if len(ln) >= 4:
                outl = max(outl, [[round(e, 2), round(-n_, 2)] for e, n_ in rdp(ln, 0.5)], key=len)
        w_ = (s[1].stop - s[1].start) * C; h_ = (s[0].stop - s[0].start) * C
        pits.append({"p": outl, "floor": round(float(np.percentile(fv, 30)), 2),
                     "depth": round(float(np.median(dd)), 1), "maxDepth": round(float(dd.max()), 1),
                     "a": round(float(m.sum() * C * C)), "x": round(E, 1), "z": round(-N, 1),
                     "lon": round(lon, 6), "lat": round(lat, 6)})
        print(f"  PIT at x {E:.1f} z {-N:.1f} (lon {lon:.5f} lat {lat:.5f}): {m.sum()*C*C:.0f} m2, "
              f"{w_:.0f} x {h_:.0f} m (E x N), depth p50 {np.median(dd):.1f} m max {dd.max():.1f} m, "
              f"floor {np.percentile(fv, 30):.1f} m vs road {np.median(road[s][m]):.1f} m")
    # LoD2 walls on the rim of a pit that LoD2 still covers: open them (the building is gone)
    near = ndimage.distance_transform_edt(~(stale & pit)) * C <= 1.5 if stale.any() else np.zeros_like(pit)
    open_walls = []
    for loop in walls:
        for (x0, z0), (x1, z1) in zip(loop[:-1], loop[1:]):
            L = np.hypot(x1 - x0, z1 - z0)
            u = np.linspace(0, 1, max(2, int(L / 0.25) + 1))
            e, n_ = x0 + (x1 - x0) * u, -(z0 + (z1 - z0) * u)
            ci = np.clip(((e - ext[0]) / C).astype(int), 0, mx - 1); cj = np.clip(((n_ - ext[1]) / C).astype(int), 0, my - 1)
            if near[cj, ci].mean() >= 0.5:
                open_walls.append([x0, z0, x1, z1])
    print(f"  {len(open_walls)} LoD2 wall segments opened on the rim of demolished footprints "
          f"({sum(np.hypot(w[2]-w[0], w[3]-w[1]) for w in open_walls):.0f} m)")
    if debug:
        img = np.zeros((my, mx, 3), np.float32)
        tv = np.where(valid, t, np.nanmin(t[valid]) if valid.any() else 0)
        gy, gx = np.gradient(tv, C)
        shade = np.clip(0.6 + 0.4 * (-gx - gy) / np.hypot(1, np.hypot(gx, gy)), 0, 1)
        img[:] = (shade * 200)[..., None]
        img[~valid] = (0, 0, 0)
        img[mask] = img[mask] * 0.6 + np.array((40, 60, 200)) * 0.4
        img[water] = img[water] * 0.5 + np.array((0, 200, 255)) * 0.5
        img[cand & ~pit] = img[cand & ~pit] * 0.4 + np.array((255, 220, 0)) * 0.6
        img[pit] = img[pit] * 0.3 + np.array((255, 0, 255)) * 0.7
        e = pit & ~ndimage.binary_erosion(pit); img[e] = (255, 255, 255)
        im = Image.fromarray(img.clip(0, 255).astype(np.uint8)[::-1])
        dr = ImageDraw.Draw(im)
        for x0, z0, x1, z1 in open_walls:
            dr.line([((x0 - ext[0]) / C, my - 1 - (-z0 - ext[1]) / C), ((x1 - ext[0]) / C, my - 1 - (-z1 - ext[1]) / C)],
                    fill=(0, 255, 0), width=3)
        dr.rectangle([4, 4, 250, 10 + 13 * 5], fill=(0, 0, 0))
        for k, (col, txt) in enumerate((((255, 0, 255), "PIT"), ((255, 220, 0), f"> {PIT_MIN:g} m under the road, rejected"),
                         ((40, 60, 200), "LoD2"), ((0, 200, 255), "water"), ((0, 255, 0), "opened LoD2 wall"))):
            dr.rectangle([8, 9 + 13 * k, 18, 17 + 13 * k], fill=col); dr.text((24, 7 + 13 * k), txt, fill=(255, 255, 255))
        im.save(os.path.join(out, "pits.png"))
        print(f"  debug -> {out}/pits.png (hillshade of the mesh, 0.5 m/px, north up)")
    return {"file": "pit.bin", "nx": int(pz.shape[1]), "nz": int(pz.shape[0]), "cell": 1.0,
            "x0": ext[0], "n0": ext[1], "note": PIT_NOTE,
            "floor": {"file": "pit_floor.bin", "i0": int(i0), "j0": int(j0),
                      "nx": int(i1 - i0), "nz": int(j1 - j0)},
            "pits": pits, "openWalls": open_walls}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025"))
    ap.add_argument("--lod2-src", default=os.path.join(REPO, "berlin_lod2_vcm"))
    ap.add_argument("--level", type=int, default=None, help="mesh LOD (default: finest present leaf)")
    ap.add_argument("--no-mesh", action="store_true",
                    help="do not rewrite world.glb (keeps an existing one)")
    ap.add_argument("--spawn", type=float, nargs=3, metavar=("LON", "LAT", "BEARING"),
                    help="start point + driving direction (deg from north); snapped onto open "
                         "street within 25 m / 8 deg, maximising the clear run ahead")
    ap.add_argument("--out-dir", default=None,
                    help="write level files here instead of levels/<name>/ (caches are still "
                         "read from levels/<name>/); for trial runs next to a live level")
    ap.add_argument("--obst-min", type=float, default=OBST_MIN,
                    help="obstacle: min height above the street, m (default %(default)s)")
    ap.add_argument("--obst-max", type=float, default=12.0,
                    help="obstacle: max height above the street, m (taller = building part)")
    ap.add_argument("--obst-min-area", type=float, default=2.0, help="obstacle: min area, m2")
    ap.add_argument("--parked-cars", choices=("include", "exclude"), default="include",
                    help="exclude = drop car-shaped objects (escape hatch, default include)")
    ap.add_argument("--no-obstacles", action="store_true", help="skip the obstacle layer")
    ap.add_argument("--no-pits", action="store_true",
                    help="skip the pit layer (pit.bin: construction pits the car falls into)")
    ap.add_argument("--roads", choices=("wfs", "osm", "off"), default="wfs",
                    help="road clearance: on this road surface only objects > --road-min stay "
                         "obstacles; wfs = Strassenbefahrung 2014 (+ OSM where it has nothing), "
                         "osm = OSM highways only, off = everywhere --obst-min (default %(default)s)")
    ap.add_argument("--road-min", type=float, default=2.0,
                    help="obstacle threshold on the road surface, m (default %(default)s)")
    ap.add_argument("--debug-obstacles", nargs="?", const="", default=None, metavar="PNG",
                    help="write a debug PNG (orthophoto + obstacles/buildings/trees/water); "
                         "default <out>/obstacles_<min>m.png")
    a = ap.parse_args()

    W, S, E, N = a.bbox
    lat0, lon0 = (S + N) / 2, (W + E) / 2
    origin = geo_to_ecef(lat0, lon0, 0.0)
    R = MT.enu_basis(lat0, lon0)

    def to_en(lon, lat):
        v = R @ (geo_to_ecef(lat, lon, 0.0) - origin)
        return v[0], v[1]
    e0, n0 = to_en(W, S); e1, n1 = to_en(E, N)
    ext = (min(e0, e1), min(n0, n1), max(e0, e1), max(n0, n1))   # E/N extent, metres
    print(f"level {a.name}: {ext[2]-ext[0]:.0f} x {ext[3]-ext[1]:.0f} m around {lat0:.5f},{lon0:.5f}")
    cache = os.path.join(HERE, "levels", a.name)          # Overpass / WFS caches
    out = a.out_dir or cache
    os.makedirs(cache, exist_ok=True); os.makedirs(out, exist_ok=True)

    def in_rect(en, m=0.0):
        return ((en[:, 0] >= ext[0] - m) & (en[:, 0] <= ext[2] + m) &
                (en[:, 1] >= ext[1] - m) & (en[:, 1] <= ext[3] + m))

    # ---------- mesh (visuals + ground reference) ----------
    ts = os.path.join(a.mesh_src, "tileset.json")
    tiles = MT.select_all(ts) if a.level is not None else MT.select_leaves(ts)
    seen, sel = set(), []
    for p, T in tiles:
        if p in seen or not os.path.exists(p):
            continue
        if a.level is not None and MT.level_of(p) != a.level:
            continue
        seen.add(p)
        c = (T @ np.array([0, 0, 0, 1.0]))[:3]
        en = (R @ (c - origin))[:2]
        if in_rect(en[None], 150.0)[0]:
            sel.append((p, T))
    if not sel:
        sys.exit("no local mesh tiles in bbox")
    prims = []
    for p, T in sel:
        try:
            prims += MT.tile_primitives(p, T, origin, R)
        except Exception as e:
            print(f"  ! {p}: {e}", file=sys.stderr)
    prims = clip_prims(prims, in_rect, keep="inside")
    mesh_v = np.vstack([pr["pos"] for pr in prims])          # X=E, Y=U, Z=-N
    ntri = sum(len(pr["idx"]) for pr in prims) // 3
    levels = sorted({MT.level_of(p) for p, _ in sel})
    print(f"mesh: {len(sel)} tiles (levels {levels}), {len(mesh_v):,} verts, {ntri:,} tris")
    if not a.no_mesh:
        MT.write_glb(os.path.join(out, "world.glb"), prims)
        print(f"  -> world.glb {os.path.getsize(os.path.join(out, 'world.glb'))/1e6:.1f} MB")

    # ---------- LoD2 ----------
    roofs, bases = [], []
    nfiles = 0
    for f in sorted(glob.glob(f"{a.lod2_src}/**/*.b3dm", recursive=True)):
        raw = open(f, "rb").read()
        c = ML.rtc_center(raw)
        if not in_rect((R @ (c - origin))[None, :2], 400.0)[0]:
            continue
        nfiles += 1
        for ecef, idx in ML.tile_ecef(f):
            enu = (R @ (ecef - origin).T).T
            tri = enu[idx.reshape(-1, 3)]                    # T x 3 x 3 (E, N, U)
            nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
            ln = np.linalg.norm(nrm, axis=1) + 1e-12
            nu = np.abs(nrm[:, 2]) / ln
            near = in_rect(tri.mean(1)[:, :2], 20.0)
            roofs.append(tri[(nu > 0.2) & near][:, :, :2])
            wall = tri[(nu < 0.05) & near]
            if len(wall):
                zmin = wall[:, :, 2].min(1, keepdims=True)
                bot = wall[np.abs(wall[:, :, 2] - zmin) < 0.05]   # ground-contact vertices
                bases.append(bot)
    roofs = np.concatenate(roofs) if roofs else np.zeros((0, 3, 2))
    bases = np.concatenate(bases) if bases else np.zeros((0, 3))
    print(f"lod2: {nfiles} tiles, {len(roofs):,} roof tris, {len(bases):,} base points")
    if len(bases) < 10:
        sys.exit("no LoD2 buildings here - fetch them with download_vcm_lod2.py")

    # ---------- building mask -> wall polylines ----------
    # mask raster: column = E, row = N (row 0 = south edge)
    mx = int(np.ceil((ext[2] - ext[0]) / MASK_CELL)); my = int(np.ceil((ext[3] - ext[1]) / MASK_CELL))
    img = Image.new("L", (mx, my), 0)
    dr = ImageDraw.Draw(img)
    px = (roofs - [ext[0], ext[1]]) / MASK_CELL
    for t in px:
        dr.polygon([tuple(v) for v in t], fill=1)
    mask = np.array(img, dtype=bool)
    mask = ndimage.binary_opening(mask, iterations=1)          # drop slivers
    mask = ndimage.binary_fill_holes(mask)                     # courtyards are not drivable
    print(f"buildings cover {mask.mean()*100:.0f} % of the level")
    gen = contourpy.contour_generator(z=np.pad(mask, 1).astype(np.float32))
    walls = []
    for ln in gen.lines(0.5):
        ln = (ln - 1) * MASK_CELL + [ext[0], ext[1]] + MASK_CELL / 2   # (E, N)
        if len(ln) < 4:
            continue
        ln = rdp(ln, 0.4)
        walls.append([[round(e, 2), round(-n, 2)] for e, n in ln])     # Box2D (X, Z)
    nseg = sum(len(w) - 1 for w in walls)
    print(f"walls: {len(walls)} loops, {nseg:,} segments")

    # ---------- height grid ----------
    # Streets must be stable, not detailed: robust 50 m block values, outlier
    # rejection against the neighbours, then interpolation and heavy smoothing.
    # Wall bases are noisy (setbacks start on roofs, tunnel portals go below).
    BLK = 50.0
    hx = int(np.ceil((ext[2] - ext[0]) / H_CELL)) + 1; hy = int(np.ceil((ext[3] - ext[1]) / H_CELL)) + 1

    lod, nbad = block_field(bases[:, 0], bases[:, 1], bases[:, 2], 25, 8, ext, hx, hy, BLK)

    # mesh ground per 2 m cell (20th percentile), street cells only -> offset to LoD2
    me, mn, mu = mesh_v[:, 0], -mesh_v[:, 2], mesh_v[:, 1]
    vi = np.clip(((me - ext[0]) / H_CELL).round().astype(int), 0, hx - 1)
    vj = np.clip(((mn - ext[1]) / H_CELL).round().astype(int), 0, hy - 1)
    cell = vj * hx + vi
    order = np.lexsort((mu, cell))
    cs, us = cell[order], mu[order]
    starts = np.flatnonzero(np.r_[True, cs[1:] != cs[:-1]])
    counts = np.diff(np.r_[starts, len(cs)])
    ground = np.full(hy * hx, np.nan)
    ground[cs[starts]] = us[starts + (counts * 0.2).astype(int)]
    ground = ground.reshape(hy, hx)
    bmask = ndimage.zoom(mask.astype(np.float32), (hy / my, hx / mx), order=0) > 0.5
    bmask = ndimage.binary_dilation(bmask, iterations=2)
    res = ground - lod
    ok = np.isfinite(res) & ~bmask & (np.abs(res) < 6)
    med = float(np.median(res[ok])) if ok.any() else 0.0
    GJ, GI = np.mgrid[0:hy, 0:hx]
    offset, nbad2 = block_field(GI[ok] * H_CELL + ext[0], GJ[ok] * H_CELL + ext[1], res[ok], 50, 20, ext, hx, hy, BLK)
    height = (lod + offset).astype(np.float32)
    print(f"height: {hx}x{hy} @ {H_CELL} m, despiked {nbad}+{nbad2} blocks, "
          f"LoD2->mesh offset median {med:+.2f} m")
    for nm, g in (("lod2", lod), ("offset", offset), ("final", height)):
        sl = np.hypot(*np.gradient(g, H_CELL)) * 100
        print(f"  {nm}: p1/50/99 {np.percentile(g, [1, 50, 99]).round(1)}, "
              f"slope p99 {np.percentile(sl, 99):.1f} % max {sl.max():.1f} %")
    height.tofile(os.path.join(out, "height.bin"))
    fit = (ground - height)[ok]
    print(f"  final vs mesh street ground: p5/p50/p95 {np.percentile(fit, [5, 50, 95]).round(2)} m, "
          f"|err|<1m on {(np.abs(fit) < 1).mean()*100:.0f} % of street cells")

    # ---------- water (OSM, cached per level) -> drown mask ----------
    water = osm_water(cache, a.bbox, ext, to_en, mx, my, mask)
    W_CELL = 1.0
    wz = water[::int(W_CELL / MASK_CELL), ::int(W_CELL / MASK_CELL)].astype(np.uint8)
    wz.tofile(os.path.join(out, "water.bin"))

    # ---------- trees (Baumkataster WFS, cached) -> trunk colliders ----------
    # Only trees the mesh actually shows: within 2 m of the trunk the mesh must
    # rise >= TREE_MIN_VISIBLE m above the height model (a crown is there).
    TREE_MIN_VISIBLE = 3.0
    tcache = os.path.join(cache, "trees_wfs.json")
    if not os.path.exists(tcache):
        import urllib.request, urllib.parse
        feats = []
        for layer in ("baumbestand:strassenbaeume", "baumbestand:anlagenbaeume"):
            q = urllib.parse.urlencode({
                "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": layer,
                "OUTPUTFORMAT": "application/json", "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
                "BBOX": f"{S},{W},{N},{E},urn:ogc:def:crs:EPSG::4326", "COUNT": "50000"})
            req = urllib.request.Request("https://gdi.berlin.de/services/wfs/baumbestand?" + q,
                                         headers={"User-Agent": "berlin-mesh-tools"})
            with urllib.request.urlopen(req, timeout=180) as r:
                fc = json.loads(r.read())
            for f in fc.get("features", []):
                f["properties"]["_layer"] = layer.split(":")[1]
            feats += fc.get("features", [])
        json.dump({"type": "FeatureCollection", "features": feats}, open(tcache, "w"))
        print(f"trees: fetched {len(feats)} from the Baumkataster -> {tcache}")
    tfc = json.load(open(tcache))
    # mesh surface max per 1 m cell (E, N), for the visibility test
    TC = 1.0
    tx_n = int(np.ceil((ext[2] - ext[0]) / TC)) + 1; tz_n = int(np.ceil((ext[3] - ext[1]) / TC)) + 1
    ci = np.clip(((mesh_v[:, 0] - ext[0]) / TC).astype(int), 0, tx_n - 1)
    cj = np.clip(((-mesh_v[:, 2] - ext[1]) / TC).astype(int), 0, tz_n - 1)
    top = np.full((tz_n, tx_n), -np.inf); np.maximum.at(top, (cj, ci), mesh_v[:, 1])
    top2 = ndimage.maximum_filter(top, size=5)           # 2 m radius around the trunk

    def ground_at(e, n):
        i = min(max(int(round((e - ext[0]) / H_CELL)), 0), hx - 1)
        j = min(max(int(round((n - ext[1]) / H_CELL)), 0), hy - 1)
        return float(height[j, i])
    trees, n_in, n_hidden, n_blocked = [], 0, 0, 0
    for f in tfc["features"]:
        c = f["geometry"]["coordinates"]
        lat_t, lon_t = (c[0], c[1]) if c[0] > 40 else (c[1], c[0])   # EPSG:4326 axis order
        e, n = to_en(lon_t, lat_t)
        if not (ext[0] <= e <= ext[2] and ext[1] <= n <= ext[3]):
            continue
        n_in += 1
        mi, mj = int((e - ext[0]) / MASK_CELL), int((n - ext[1]) / MASK_CELL)
        if mask[min(mj, my - 1), min(mi, mx - 1)] or water[min(mj, my - 1), min(mi, mx - 1)]:
            n_blocked += 1; continue
        vis = top2[min(int((n - ext[1]) / TC), tz_n - 1), min(int((e - ext[0]) / TC), tx_n - 1)] - ground_at(e, n)
        if not vis >= TREE_MIN_VISIBLE:
            n_hidden += 1; continue
        pr = f["properties"]
        girth = float(pr.get("stammumfg") or 0) / 100.0          # cm -> m
        r = max(0.3, girth / (2 * np.pi) + 0.1)                  # trunk radius + margin
        trees.append([round(e, 2), round(-n, 2), round(r, 2), round(float(vis), 1)])
    print(f"trees: {n_in} in level, {len(trees)} visible in the mesh -> colliders, "
          f"{n_hidden} not visible (< {TREE_MIN_VISIBLE:.0f} m above ground), {n_blocked} in buildings/water")

    # ---------- spawn: open street cell nearest the centre ----------
    free = ndimage.distance_transform_edt(~(mask | water)) * MASK_CELL
    cy, cx = my // 2, mx // 2
    yy, xx = np.mgrid[0:my, 0:mx]
    score = np.where(free > 6, -np.hypot(yy - cy, xx - cx), -np.inf)
    sj, si = np.unravel_index(np.argmax(score), score.shape)
    spawn_e, spawn_n = ext[0] + (si + 0.5) * MASK_CELL, ext[1] + (sj + 0.5) * MASK_CELL
    def clear_run(e, n, ang, limit=600.0):
        """metres of building-free street ahead of (e, n) along bearing ang"""
        dx, dy = np.sin(ang), np.cos(ang)               # E, N for bearing ang
        run = 0.0
        for s in np.arange(1, limit, MASK_CELL):
            x = int((e + dx * s - ext[0]) / MASK_CELL); y = int((n + dy * s - ext[1]) / MASK_CELL)
            if not (0 <= x < mx and 0 <= y < my) or mask[y, x] or water[y, x]:
                break
            run = s
        return run

    if a.spawn:
        lon_s, lat_s, brg = a.spawn
        e0s, n0s = to_en(lon_s, lat_s)
        best, pick = -np.inf, None
        for dB in np.arange(-8, 8.5, 1.0):
            ang = np.radians(brg + dB)
            px, py = np.cos(ang), -np.sin(ang)          # perpendicular (E, N)
            for off in np.arange(-25, 25.5, 1.0):
                e, n = e0s + px * off, n0s + py * off
                i, j = int((e - ext[0]) / MASK_CELL), int((n - ext[1]) / MASK_CELL)
                if not (0 <= i < mx and 0 <= j < my) or free[j, i] < 3:
                    continue
                sc = clear_run(e, n, ang) - 2 * abs(off) - 3 * abs(dB)
                if sc > best:
                    best, pick = sc, (e, n, float(ang), off, dB)
        if pick is None:
            sys.exit("--spawn: no open street within 25 m of that point")
        spawn_e, spawn_n, heading, off, dB = pick
        best = clear_run(spawn_e, spawn_n, heading)
        print(f"spawn snapped {off:+.0f} m sideways, {dB:+.0f} deg")
    else:   # heading along the street: direction of greatest free distance
        best, heading = -1, 0.0
        for ang in np.radians(np.arange(0, 180, 5)):
            run = clear_run(spawn_e, spawn_n, ang, 150.0)
            if run > best:
                best, heading = run, float(ang)

    # ---------- obstacles: whatever the mesh shows standing on the street ----------
    obstacles = None
    if not a.no_obstacles:
        import time
        t0 = time.time()
        top, ortho = raster_top(prims, ext[0], ext[1], 2 * mx, 2 * my, MASK_CELL / 2)
        print(f"top surface: {2*mx}x{2*my} @ {MASK_CELL/2} m, {np.isfinite(top).mean()*100:.0f} % covered "
              f"({time.time()-t0:.0f} s)")
        roads = road_mask(a.roads, cache, a.bbox, ext, to_en, mx, my)
        obstacles = obstacle_layer(a, top, ortho, mask, water, height, trees, ext, out,
                                   spawn=(spawn_e, spawn_n, heading), roads=roads)

    # ---------- pits: mesh clearly below the street (construction pits) -> fall in ----------
    pits = None
    if not a.no_pits:
        ptop = top if not a.no_obstacles else raster_top(prims, ext[0], ext[1], 2 * mx, 2 * my,
                                                          MASK_CELL / 2, colour=False)[0]
        pits = pit_layer(ptop, mask, water, height, walls, ext, to_en, (lon0, lat0), out,
                         debug=a.debug_obstacles is not None)

    level = {
        "name": a.name,
        "bbox": [W, S, E, N],
        "origin": {"lat": lat0, "lon": lon0},
        "extent": {"minX": ext[0], "maxX": ext[2], "minZ": -ext[3], "maxZ": -ext[1]},
        "height": {"file": "height.bin", "nx": hx, "nz": hy, "cell": H_CELL,
                   "x0": ext[0], "n0": ext[1],
                   "note": "row j = north offset n0 + j*cell, column i = east x0 + i*cell"},
        "walls": walls,
        "trees": trees,
        "treesNote": "[x, z, trunk radius m, visible height above road m]; Baumkataster (gdi.berlin.de, dl-de/zero-2.0), only trees the mesh shows",
        "water": {"file": "water.bin", "nx": int(wz.shape[1]), "nz": int(wz.shape[0]), "cell": W_CELL,
                  "x0": ext[0], "n0": ext[1], "note": "uint8, 1 = water; row j = north n0 + j*cell"},
        "spawn": {"x": spawn_e, "z": -spawn_n, "heading": heading},
        "mesh": "world.glb" if os.path.exists(os.path.join(out, "world.glb")) or (a.no_mesh and os.path.exists(os.path.join(cache, "world.glb"))) else None,
        "meshLevels": levels,
        "attribution": "3D mesh: Berlin Partner fuer Wirtschaft und Technologie GmbH; "
                       "LoD2: Geoportal Berlin, dl-de/by-2.0; trees: Baumkataster Berlin",
    }
    if obstacles is not None:
        level["obstacles"] = obstacles
        level["obstaclesNote"] = OBST_NOTE
        if roads[0] is not None:
            level["obstaclesNote"] += (f"; on the road surface ({roads[2]}) only objects > "
                                       f"{a.road_min:g} m, elsewhere > {a.obst_min:g} m")
            if "Strassenbefahrung" in roads[2]:
                level["attribution"] += "; " + ROAD_ATTR
    if pits is not None:
        level["pit"] = pits
    tmp = os.path.join(out, "level.json.tmp")
    with open(tmp, "w") as f:
        json.dump(level, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(out, "level.json"))
    print(f"spawn E {spawn_e:.0f} N {spawn_n:.0f}, bearing {np.degrees(heading):.0f} deg "
          f"({best:.0f} m clear) -> {out}/level.json")


if __name__ == "__main__":
    main()

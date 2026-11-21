#!/usr/bin/env python3
"""Build a streamed driving level: the mesh stays as 3D Tiles on disk and
js/stream.js loads what the camera needs (L1 near, coarser further out).

  tiles.json : every L1-L4 tile of the local tree that overlaps the bbox, with its
               parent, bounding sphere and one rigid matrix into the level frame
  height.bin : street height grid (4 m) from the L2 mesh top surface
  water.bin  : OSM water mask (build_level.osm_water, cached Overpass result)
  level.json : origin, extent, spawn, no walls / trees / obstacles, `stream` block

Frame as in build_level.py: ENU around the bbox centre, three.js X=E, Y=U, Z=-N.

  python3 build_stream.py --name mitte_all --bbox 13.3640 52.5040 13.4290 52.5410
Reads local disk only (except the one Overpass query for water, cached).
After a rebuild of tiles.json, re-run build_occluders.py (occlusion.json / .bin: occluder grid
+ tile tops for the streamer's occlusion step; tile indices refer to tiles.json order).
"""
import argparse, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
import merge_tiles as MT                 # noqa: E402
from merge_hybrid import geo_to_ecef     # noqa: E402
from build_level import raster_top, block_field, osm_water, MASK_CELL   # noqa: E402

LEVELS = (1, 2, 3, 4)   # L1 finest (owner), L4 roots
H_CELL = 4.0            # m, height grid
TOP_CELL = 2.0          # m, mesh top-surface raster for the height grid
S4 = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)   # (E, N, U) -> (E, U, -N)


def walk(ts_path, overlaps):
    """Tiles of LEVELS present on disk -> list of dicts (path, level, parent, T, box, ge).

    Above the first kept tile, subtrees whose box misses the bbox are pruned. Below
    a kept tile a parent refines into all its children on disk; it stays a leaf if
    one inside the bbox is missing, so REPLACE leaves no holes inside the bbox.
    """
    tiles = []

    def node_T(node, T):
        return T @ MT.mat(node["transform"]) if "transform" in node else T

    def uri_of(node):
        c = node.get("content") or {}
        return c.get("uri") or c.get("url") or ""

    def first_tiles(node, T, d):
        """first b3dm nodes below (through json content / content-less nodes)"""
        T2 = node_T(node, T)
        uri = uri_of(node)
        if uri.endswith(".b3dm"):
            return [(node, T2, d)]
        out = []
        for ch in node.get("children", []):
            out += first_tiles(ch, T2, d)
        if uri.endswith(".json"):
            p = MT.resolve(d, uri)
            if os.path.exists(p):
                out += first_tiles(MT.load_json(p)["root"], T2, os.path.dirname(p))
        return out

    def add(node, T2, d, parent):
        p = MT.resolve(d, uri_of(node))
        lvl = MT.level_of(p)
        idx = len(tiles)
        t = {"path": p, "level": lvl, "parent": parent, "T": T2,
             "box": node["boundingVolume"]["box"], "ge": node["geometricError"], "leaf": True}
        tiles.append(t)
        if lvl == LEVELS[0]:
            return
        kids = [k for ch in node.get("children", []) for k in first_tiles(ch, T2, d)]
        kids = [(n, T, dd, MT.resolve(dd, uri_of(n))) for n, T, dd in kids]
        kids = [k for k in kids if MT.level_of(k[3]) == lvl - 1]
        have = [k for k in kids if os.path.exists(k[3])]
        # the download kept tiles overlapping the bbox: a child missing OUTSIDE the
        # bbox only means the mesh ends at the border (as world.glb does), so refine
        # into the present ones; one missing inside -> stays a leaf (no holes)
        if not have or any(not os.path.exists(kp) and overlaps(T, n["boundingVolume"]["box"])
                           for n, T, dd, kp in kids):
            return
        t["leaf"] = False
        t["partial"] = len(have) < len(kids)
        for n, T, dd, _ in have:
            add(n, T, dd, idx)

    def visit(node, T, d):
        T2 = node_T(node, T)
        box = (node.get("boundingVolume") or {}).get("box")
        if box and not overlaps(T2, box):
            return
        uri = uri_of(node)
        if uri.endswith(".b3dm"):
            p = MT.resolve(d, uri)
            if MT.level_of(p) in LEVELS and os.path.exists(p):
                add(node, T2, d, -1)
                return
        for ch in node.get("children", []):
            visit(ch, T2, d)
        if uri.endswith(".json"):
            p = MT.resolve(d, uri)
            if os.path.exists(p):
                visit(MT.load_json(p)["root"], T2, os.path.dirname(p))

    visit(MT.load_json(ts_path)["root"], np.eye(4), os.path.dirname(ts_path))
    return tiles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--bbox", type=float, nargs=4, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--spawn", type=float, nargs=3, metavar=("LON", "LAT", "BEARING"),
                    default=(13.3805, 52.51634, 80.0), help="start point + bearing (deg), not snapped")
    ap.add_argument("--tau", type=float, default=24.0, help="screen-space error target, px")
    ap.add_argument("--budget-mb", type=float, default=1024.0, help="GPU budget of the streamer (Detail: normal; low = half, high = 1.5x)")
    a = ap.parse_args()

    W, S, E, N = a.bbox
    lat0, lon0 = (S + N) / 2, (W + E) / 2
    origin = geo_to_ecef(lat0, lon0, 0.0)
    R = MT.enu_basis(lat0, lon0)
    P = S4.copy(); P[:3, :3] = S4[:3, :3] @ R; P[:3, 3] = -(S4[:3, :3] @ R @ origin)   # ECEF -> level frame

    def to_en(lon, lat):
        v = R @ (geo_to_ecef(lat, lon, 0.0) - origin)
        return v[0], v[1]
    e0, n0 = to_en(W, S); e1, n1 = to_en(E, N)
    ext = (min(e0, e1), min(n0, n1), max(e0, e1), max(n0, n1))
    print(f"level {a.name}: {ext[2]-ext[0]:.0f} x {ext[3]-ext[1]:.0f} m around {lat0:.5f},{lon0:.5f}")
    out = os.path.join(HERE, "levels", a.name)
    os.makedirs(out, exist_ok=True)

    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], float)

    def box_en(T, box):
        b = np.asarray(box, float)
        pts = b[:3] + corners @ b[3:].reshape(3, 3)          # box frame -> tile frame
        ecef = (T[:3, :3] @ pts.T).T + T[:3, 3]
        en = (R @ (ecef - origin).T).T[:, :2]
        return en.min(0), en.max(0)

    def overlaps(T, box):
        lo, hi = box_en(T, box)
        return lo[0] <= ext[2] and hi[0] >= ext[0] and lo[1] <= ext[3] and hi[1] >= ext[1]

    t0 = time.time()
    tiles = walk(os.path.join(a.mesh_src, "tileset.json"), overlaps)
    if not tiles:
        sys.exit("no local mesh tiles in bbox")
    by_lvl = {l: sum(t["level"] == l for t in tiles) for l in LEVELS}
    edge = sum(t["leaf"] and t["level"] > 1 for t in tiles)
    part = sum(t.get("partial", False) for t in tiles)
    print(f"tiles: {len(tiles)} ({', '.join(f'L{l} {n}' for l, n in by_lvl.items())}), "
          f"{edge} coarse leaves, {part} parents refine into their children inside the bbox only, roots {sum(t['parent'] < 0 for t in tiles)} "
          f"({time.time()-t0:.0f} s)")

    # ---------- tiles.json ----------
    # M = P . T_acc . ZUP (GLTFLoader applies the glTF node matrix itself);
    # bounding sphere = circumsphere of the 3D Tiles box (P is rigid)
    rows, ge = [], {}
    base = os.path.abspath(a.mesh_src)
    for t in tiles:
        M = P @ t["T"] @ MT.ZUP
        b = np.asarray(t["box"], float)
        c = (P @ t["T"] @ np.r_[b[:3], 1.0])[:3]
        r = float(np.sqrt((b[3:].reshape(3, 3) ** 2).sum()))
        ge.setdefault(t["level"], round(float(t["ge"]), 4))
        rows.append([os.path.relpath(t["path"], base), t["level"], t["parent"],
                     *np.round(c, 2).tolist(), round(r, 2),
                     *[round(float(v), 7 if k % 4 < 3 else 3) for k, v in enumerate(M[:3].ravel())],
                     int(t["leaf"])])
    # self-check: the matrix places a tile exactly as merge_tiles does
    t = next(t for t in tiles if t["level"] == 1)
    gj, bn = MT.gltf_from_b3dm(open(t["path"], "rb").read())
    nw = MT.node_world_matrices(gj)
    ni = next(i for i, n in enumerate(gj["nodes"]) if "mesh" in n)
    v = MT.read_accessor(gj, bn, gj["meshes"][gj["nodes"][ni]["mesh"]]["primitives"][0]["attributes"]["POSITION"])[:50]
    mine = ((P @ t["T"] @ MT.ZUP @ nw[ni]) @ np.c_[v, np.ones(len(v))].T).T[:, :3]
    ref = MT.tile_primitives(t["path"], t["T"], origin, R)[0]["pos"][:50]
    assert np.abs(mine - ref).max() < 0.01, np.abs(mine - ref).max()
    doc = {"base": "tiles/", "ge": {str(k): v for k, v in sorted(ge.items())},
           "fields": "path, level, parent (-1 = root), cx, cy, cz, r, m0..m11 (rows 0-2 of the 4x4, "
                     "tile glTF -> level frame), leaf (1 = never refines)",
           "tiles": rows}
    with open(os.path.join(out, "tiles.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"  -> tiles.json {os.path.getsize(os.path.join(out, 'tiles.json'))/1e6:.2f} MB")

    # ---------- water (OSM, cached) ----------
    mx = int(np.ceil((ext[2] - ext[0]) / MASK_CELL)); my = int(np.ceil((ext[3] - ext[1]) / MASK_CELL))
    water = osm_water(out, a.bbox, ext, to_en, mx, my, np.zeros((my, mx), bool))
    W_CELL = 1.0
    wz = water[::int(W_CELL / MASK_CELL), ::int(W_CELL / MASK_CELL)].astype(np.uint8)
    wz.tofile(os.path.join(out, "water.bin"))

    # ---------- height grid ----------
    # mesh top surface of L2 (coarse leaves where no L2 exists) at 2 m, water cells
    # out; 20th percentile per 50 m block (street level between the buildings),
    # despiked, interpolated, smoothed (sigma 20 m). No morphological opening: it
    # would pull the quays down to the Spree.
    t0 = time.time()
    src = [t for t in tiles if t["level"] == 2 or (t["leaf"] and t["level"] > 2)]
    prims = []
    for t in src:
        try:
            prims += MT.tile_primitives(t["path"], t["T"], origin, R)
        except Exception as e:
            print(f"  ! {t['path']}: {e}", file=sys.stderr)
    tx = int(np.ceil((ext[2] - ext[0]) / TOP_CELL)); ty = int(np.ceil((ext[3] - ext[1]) / TOP_CELL))
    top, _ = raster_top(prims, ext[0], ext[1], tx, ty, TOP_CELL, colour=False)
    del prims
    k = int(TOP_CELL / MASK_CELL)
    wp = np.pad(water, ((0, max(0, ty * k - my)), (0, max(0, tx * k - mx))))
    wet = wp[:ty * k, :tx * k].reshape(ty, k, tx, k).any(axis=(1, 3))
    ok = np.isfinite(top) & ~wet
    J, I = np.nonzero(ok)
    hx = int(np.ceil((ext[2] - ext[0]) / H_CELL)) + 1; hy = int(np.ceil((ext[3] - ext[1]) / H_CELL)) + 1
    height, nbad = block_field(ext[0] + (I + 0.5) * TOP_CELL, ext[1] + (J + 0.5) * TOP_CELL, top[J, I],
                               20, 60, ext, hx, hy, 50.0, H_CELL)
    height = height.astype(np.float32)
    height.tofile(os.path.join(out, "height.bin"))
    sl = np.hypot(*np.gradient(height, H_CELL)) * 100
    print(f"height: {hx}x{hy} @ {H_CELL:g} m from {len(src)} tiles, top {np.isfinite(top).mean()*100:.0f} % "
          f"covered, despiked {nbad} blocks, p1/50/99 {np.percentile(height, [1, 50, 99]).round(1)} m, "
          f"slope p99 {np.percentile(sl, 99):.1f} % ({time.time()-t0:.0f} s)")

    se, sn = to_en(a.spawn[0], a.spawn[1])
    level = {
        "name": a.name,
        "bbox": [W, S, E, N],
        "origin": {"lat": lat0, "lon": lon0},
        "extent": {"minX": ext[0], "maxX": ext[2], "minZ": -ext[3], "maxZ": -ext[1]},
        "height": {"file": "height.bin", "nx": hx, "nz": hy, "cell": H_CELL,
                   "x0": ext[0], "n0": ext[1],
                   "note": "row j = north offset n0 + j*cell, column i = east x0 + i*cell"},
        "walls": [],
        "water": {"file": "water.bin", "nx": int(wz.shape[1]), "nz": int(wz.shape[0]), "cell": W_CELL,
                  "x0": ext[0], "n0": ext[1], "note": "uint8, 1 = water; row j = north n0 + j*cell"},
        "spawn": {"x": se, "z": -sn, "heading": float(np.radians(a.spawn[2]))},
        "mesh": None,
        "meshLevels": list(LEVELS),
        "stream": {"file": "tiles.json", "tau": a.tau, "budgetMB": a.budget_mb},
        "attribution": "3D mesh: Berlin Partner fuer Wirtschaft und Technologie GmbH; "
                       "water: OpenStreetMap contributors",
    }
    try:   # pits (build_pits.py) survive a rebuild of the level (pit.bin / pit_floor.bin stay)
        old = json.load(open(os.path.join(out, "level.json")))
        if "pit" in old:
            level["pit"] = old["pit"]
    except (OSError, ValueError):
        pass
    tmp = os.path.join(out, "level.json.tmp")
    with open(tmp, "w") as f:
        json.dump(level, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(out, "level.json"))
    print(f"spawn E {se:.0f} N {sn:.0f}, bearing {a.spawn[2]:.0f} deg, water {water.mean()*100:.1f} % "
          f"-> {out}/level.json")


if __name__ == "__main__":
    main()

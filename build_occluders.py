#!/usr/bin/env python3
"""Occlusion data for the tile streamer (js/stream.js, "occlusion" step).

  python3 build_occluders.py --name mitte_all          (after build_stream.py + build_buildings.py)

Writes levels/<name>/occlusion.json + occlusion.bin (gzip, ~0.3 MB):

  occluder grid  CELL (4 m) cells over the level, uint8: 0 = no occluder, else the
                 absolute height (level frame Y) = BASE + v * STEP. A cell is an
                 occluder only if ALL of it is building (OSM mask of build_buildings.py,
                 its 2 m buffer eroded away + ERODE_EXTRA, so bridges, the viaduct,
                 passages, roofs over the street, trees are never occluders) AND the
                 mesh surface covers all of it at every LOD (L1..L4: whatever the
                 streamer draws there). Height = the LOWEST surface point of the cell
                 over all four LODs (1 m raster) minus MARGIN, rounded down: a building
                 is only ever made lower than it is drawn.
  tile tops      for every tile that can refine (L2-L4): a G x G grid over the x/z box
                 of all its content (own + descendants, down to L1), per cell the
                 HIGHEST content point (each triangle counted in every grid cell its
                 box touches) + TOP_MARGIN, uint16 decimetres, 0 = no content. The
                 streamer calls a tile hidden only if every one of these columns is
                 behind occluders.

Reads local disk only (the mesh mirror ../berlin_mesh_2025_wab, levels/<name>/).
Frame as build_stream.py: three.js X = E, Y = U, Z = -N.
"""
import argparse, gzip, json, os, sys, time
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)
import merge_tiles as MT                 # noqa: E402
from build_level import raster_top       # noqa: E402

CELL = 4.0          # m, occluder grid
RASTER = 1.0        # m, mesh top raster (min over a cell's 16 samples)
ERODE_EXTRA = 0.0   # m, eroded beyond the mask's own buffer (an OSM vs. mesh offset is
                    # caught by the mesh minimum: a cell reaching onto the street gets street height)
MARGIN = 1.0        # m, occluder height below the lowest drawn surface
BASE, STEP = 20.0, 0.5   # uint8 height code: Y = BASE + v * STEP (v >= 1)
G = 8               # tile top grid per refinable tile
TOP_MARGIN = 0.5    # m, added to the tile tops


def tile_geometry(path, M):
    """level-frame vertices (N x 3) and triangles (T x 3) of one b3dm"""
    gj, bn = MT.gltf_from_b3dm(open(path, "rb").read())
    nw = MT.node_world_matrices(gj)

    def acc(i):
        a = gj["accessors"][i]
        bv = gj["bufferViews"][a["bufferView"]]
        n, c, dt = a["count"], MT.NC[a["type"]], np.dtype(MT.CT[a["componentType"]])
        st = bv.get("byteStride") or c * dt.itemsize
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        if st == c * dt.itemsize:
            return np.frombuffer(bn, dt, n * c, off).reshape(n, c)
        raw = np.frombuffer(bn, np.uint8, (n - 1) * st + c * dt.itemsize, off)
        return np.lib.stride_tricks.as_strided(raw, (n, c * dt.itemsize), (st, 1)).copy().view(dt).reshape(n, c)

    out = []
    for ni, node in enumerate(gj["nodes"]):
        if "mesh" not in node:
            continue
        W = M @ nw[ni]
        for pr in gj["meshes"][node["mesh"]]["primitives"]:
            if pr.get("mode", 4) != 4:
                continue
            v = acc(pr["attributes"]["POSITION"]).astype(np.float64)
            v = v @ W[:3, :3].T + W[:3, 3]
            idx = acc(pr["indices"]).ravel().astype(np.int64) if "indices" in pr else np.arange(len(v))
            out.append((v, idx.reshape(-1, 3)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    a = ap.parse_args()
    out = os.path.join(HERE, "levels", a.name)
    level = json.load(open(os.path.join(out, "level.json")))
    doc = json.load(open(os.path.join(out, level["stream"]["file"])))
    bmeta = json.load(open(os.path.join(out, "buildings.json")))
    ext = level["extent"]
    x0, n0 = ext["minX"], -ext["maxZ"]
    nx = int(np.ceil((ext["maxX"] - ext["minX"]) / CELL))
    nz = int(np.ceil((ext["maxZ"] - ext["minZ"]) / CELL))
    rx, rz = nx * int(CELL / RASTER), nz * int(CELL / RASTER)

    rows = doc["tiles"]
    T = len(rows)
    par = [r[2] for r in rows]
    lvl = [r[1] for r in rows]
    leaf = [r[19] for r in rows]
    refin = [i for i in range(T) if not leaf[i]]

    # ---- pass 1: content boxes from the accessors' min/max (cheap), subtree union ----
    t0 = time.time()
    box = np.zeros((T, 4))                    # x0 z0 x1 z1
    corners = np.array([[sx, sy, sz] for sx in (0, 1) for sy in (0, 1) for sz in (0, 1)], float)
    for i, r in enumerate(rows):
        M = np.eye(4); M[:3] = np.array(r[7:19]).reshape(3, 4)
        gj, _ = MT.gltf_from_b3dm(open(os.path.join(a.mesh_src, r[0]), "rb").read())
        nw = MT.node_world_matrices(gj)
        pts = []
        for ni, node in enumerate(gj["nodes"]):
            if "mesh" not in node:
                continue
            W = M @ nw[ni]
            for pr in gj["meshes"][node["mesh"]]["primitives"]:
                ac = gj["accessors"][pr["attributes"]["POSITION"]]
                lo, hi = np.array(ac["min"]), np.array(ac["max"])
                c = lo + corners * (hi - lo)
                pts.append(c @ W[:3, :3].T + W[:3, 3])
        p = np.concatenate(pts)
        box[i] = (p[:, 0].min(), p[:, 2].min(), p[:, 0].max(), p[:, 2].max())
    sub = box.copy()
    for i in sorted(range(T), key=lambda i: lvl[i]):      # finest first: children before parents
        if par[i] >= 0:
            j = par[i]
            sub[j, :2] = np.minimum(sub[j, :2], sub[i, :2]); sub[j, 2:] = np.maximum(sub[j, 2:], sub[i, 2:])
    print(f"content boxes: {T} tiles ({time.time()-t0:.0f} s)")

    # ---- pass 2: geometry -> per-LOD top rasters (occluders) + tile top grids ----
    t0 = time.time()
    rast, pend, npend = {}, {}, {}
    tops = np.zeros((T, G, G), np.float32)    # -> only refinable tiles are written
    cw = (sub[:, 2] - sub[:, 0]) / G; ch = (sub[:, 3] - sub[:, 1]) / G

    def flush(L):
        if not pend.get(L):
            return
        tp, _ = raster_top(pend[L], x0, n0, rx, rz, RASTER, colour=False)
        if L not in rast:
            rast[L] = np.full((rz, rx), -np.inf, np.float32)
        rast[L] = np.fmax(rast[L], np.where(np.isfinite(tp), tp, -np.inf))
        pend[L] = []; npend[L] = 0

    for n, (i, r) in enumerate(enumerate(rows)):
        M = np.eye(4); M[:3] = np.array(r[7:19]).reshape(3, 4)
        try:
            geo = tile_geometry(os.path.join(a.mesh_src, r[0]), M)
        except Exception as e:
            print(f"  ! {r[0]}: {e}", file=sys.stderr)
            continue
        L = lvl[i]
        pend.setdefault(L, []).extend({"pos": v, "idx": tri.ravel()} for v, tri in geo)
        npend[L] = npend.get(L, 0) + sum(len(tri) for _, tri in geo)
        if npend[L] > 1_500_000:
            flush(L)
        # tile tops: every triangle into the grid of this tile and all its ancestors
        for v, tri in geo:
            tv = v[tri]                                       # T x 3 x 3
            tx0, tx1 = tv[:, :, 0].min(1), tv[:, :, 0].max(1)
            tz0, tz1 = tv[:, :, 2].min(1), tv[:, :, 2].max(1)
            ty = tv[:, :, 1].max(1) + TOP_MARGIN
            a_ = par[i] if leaf[i] else i
            while a_ >= 0:
                i0 = np.clip(np.floor((tx0 - sub[a_, 0]) / cw[a_]).astype(int), 0, G - 1)
                i1 = np.clip(np.floor((tx1 - sub[a_, 0]) / cw[a_]).astype(int), 0, G - 1)
                j0 = np.clip(np.floor((tz0 - sub[a_, 1]) / ch[a_]).astype(int), 0, G - 1)
                j1 = np.clip(np.floor((tz1 - sub[a_, 1]) / ch[a_]).astype(int), 0, G - 1)
                flat = tops[a_].ravel()
                for di in range(int((i1 - i0).max()) + 1):
                    for dj in range(int((j1 - j0).max()) + 1):
                        ok = (i0 + di <= i1) & (j0 + dj <= j1)
                        np.maximum.at(flat, (j0[ok] + dj) * G + i0[ok] + di, ty[ok].astype(np.float32))
                a_ = par[a_]
        if n % 200 == 0:
            print(f"  {n}/{T} tiles ({time.time()-t0:.0f} s)", flush=True)
    for L in list(pend):
        flush(L)
    print(f"geometry: {T} tiles ({time.time()-t0:.0f} s)")

    # ---- occluder grid ----
    # lowest surface over all LODs; NaN (no surface at some LOD / some sample) propagates
    lo = np.stack([np.where(np.isfinite(R_), R_, np.nan) for R_ in rast.values()]).min(0)
    k = int(CELL / RASTER)
    cellmin = lo.reshape(nz, k, nx, k).min(axis=(1, 3))
    # building mask at 1 m (packed bits), buffer eroded away, then "all of the cell"
    bnx, bnz = bmeta["nx"], bmeta["nz"]
    bits = np.unpackbits(np.fromfile(os.path.join(out, bmeta["file"]), np.uint8).reshape(bnz, -1), axis=1)[:, :bnx].astype(bool)
    er = int(round((bmeta.get("buffer", 0) + ERODE_EXTRA) / bmeta["cell"]))
    bits = ndimage.binary_erosion(bits, structure=np.ones((3, 3), bool), iterations=er) if er > 0 else bits
    full = np.zeros((nz, nx), bool)
    kb = int(CELL / bmeta["cell"])
    oi = int(round((x0 - bmeta["x0"]) / bmeta["cell"])); oj = int(round((n0 - bmeta["n0"]) / bmeta["cell"]))
    pad = np.zeros((nz * kb, nx * kb), bool)
    src = bits[max(0, oj):oj + nz * kb, max(0, oi):oi + nx * kb]
    pad[max(0, -oj):max(0, -oj) + src.shape[0], max(0, -oi):max(0, -oi) + src.shape[1]] = src
    full = pad.reshape(nz, kb, nx, kb).all(axis=(1, 3))
    h = cellmin - MARGIN
    occ = full & np.isfinite(h)
    # code 0 (at / below BASE + STEP) = no occluder; above 255 clamped down (lower = safe)
    code = np.where(occ, np.clip(np.floor((np.where(occ, h, BASE) - BASE) / STEP), 0, 255), 0).astype(np.uint8)
    occ = code > 0
    gnd = np.fromfile(os.path.join(out, level["height"]["file"]), np.float32).reshape(level["height"]["nz"], level["height"]["nx"])
    print(f"occluders: {occ.sum()} of {nx*nz} cells ({occ.mean()*100:.1f} %), height p10/50/90 "
          f"{np.percentile(h[occ], [10, 50, 90]).round(1)} m (ground ~{np.median(gnd):.1f})")

    # ---- write ----
    tb = np.zeros((len(refin), G, G), np.uint16)
    for n, i in enumerate(refin):
        tb[n] = np.where(tops[i] > 0, np.clip(np.ceil(tops[i] * 10), 1, 65535), 0)
    grid_bytes = code.tobytes()
    off = (len(grid_bytes) + 3) // 4 * 4
    # gzip (mostly zeros); js/stream.js inflates it (DecompressionStream) when it sees the magic
    with gzip.open(os.path.join(out, "occlusion.bin"), "wb", compresslevel=9) as f:
        f.write(grid_bytes); f.write(b"\0" * (off - len(grid_bytes))); f.write(tb.astype("<u2").tobytes())
    meta = {
        "file": "occlusion.bin", "gzip": True,
        "grid": {"offset": 0, "nx": nx, "nz": nz, "cell": CELL, "x0": x0, "n0": n0, "base": BASE, "step": STEP,
                 "note": "uint8, row j = north n0 + j*cell .. +cell, column i = east x0 + i*cell; 0 = none, "
                         "else occluder top Y = base + v*step (level frame)"},
        "tops": {"offset": off, "g": G, "count": len(refin),
                 "note": "uint16 LE decimetres (level frame Y), per tile g*g, row-major over z then x, 0 = no content"},
        "tiles": [[i, *np.round(sub[i], 2).tolist()] for i in refin],
        "tilesNote": "tile index (tiles.json order), x0 z0 x1 z1 of all its content (own + descendants)",
        "constants": {"erodeExtra": ERODE_EXTRA, "margin": MARGIN, "raster": RASTER, "topMargin": TOP_MARGIN},
        "source": "OSM building mask (buildings.bin) + Berlin 3D mesh L1-L4 (local mirror)",
    }
    with open(os.path.join(out, "occlusion.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"-> {out}/occlusion.bin {os.path.getsize(os.path.join(out, 'occlusion.bin'))/1e3:.0f} kB, "
          f"occlusion.json {os.path.getsize(os.path.join(out, 'occlusion.json'))/1e3:.0f} kB")


if __name__ == "__main__":
    main()

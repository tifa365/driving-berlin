#!/usr/bin/env python3
"""Area names for the street-sign note (js/areasign.js).

  python3 racing/build_areas.py --name mitte_all --pbf berlin-latest.osm.pbf   (or env OSM_PBF)

Source: a local OpenStreetMap extract (osmium CLI, no network) and the level's map.json.
  - Ortsteile: boundary=administrative + admin_level=10 relations overlapping the level box,
    as simplified rings (Douglas-Peucker SIMPLIFY m), clipped to the level extent + MARGIN.
    Rings are stored flat; the inside test is even-odd over all rings of one Ortsteil
    (outer rings and holes alike), which keeps holes and multipolygons right.
  - historic quarters: the `quarter` and `neighbourhood` points of map.json `places`, each
    tagged with the Ortsteil it lies in (`in`). The sign shows a quarter when it is the
    nearest one of the car's Ortsteil and within `near` m (js/areasign.js opts.nearM).
Frame as build_walls.py (ENU at level.origin, x = east, z = -north, metres).
Writes levels/<name>/areas.json (small, < 200 KB). Re-runnable.
"""
import argparse, json, os, subprocess, sys, tempfile, time
import numpy as np
from build_walls import Frame, dp, need_pbf, PBF

HERE = os.path.dirname(os.path.abspath(__file__))
SIMPLIFY = 5.0     # m Douglas-Peucker
MARGIN = 600.0     # m around the level extent kept when clipping
NEAR = 600.0       # m, a quarter point counts within this distance (default for the client)
QUARTER_KINDS = ("quarter", "neighbourhood")


def load_ortsteile(pbf, bbox, td):
    """admin_level=10 areas whose bbox overlaps the level bbox (lon/lat)"""
    f, gj = os.path.join(td, "adm.osm.pbf"), os.path.join(td, "adm.geojsonl")
    q = dict(check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # tags-filter on the whole extract first: relations with their member ways and nodes only
    subprocess.run(["osmium", "tags-filter", pbf, "r/admin_level=10", "-o", f, "-O"], **q)
    subprocess.run(["osmium", "export", f, "-f", "geojsonseq", "-o", gj, "-O", "-a", "type,id",
                    "--geometry-types=polygon"], **q)
    W, S, E, N = bbox
    out = []
    with open(gj) as fh:
        for line in fh:
            if not line.strip():
                continue
            ft = json.loads(line.lstrip("\x1e"))
            p = ft.get("properties") or {}
            if p.get("boundary") != "administrative" or str(p.get("admin_level")) != "10" or not p.get("name"):
                continue
            g = ft["geometry"]
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            pts = np.array([c for poly in polys for ring in poly for c in ring])
            if pts[:, 0].max() < W or pts[:, 0].min() > E or pts[:, 1].max() < S or pts[:, 1].min() > N:
                continue
            out.append((p["name"], p.get("@id"), polys))
    return out


def clip_rect(ring, x0, z0, x1, z1):
    """Sutherland-Hodgman against an axis-aligned box; keeps even-odd parity inside the box"""
    pts = [tuple(p) for p in ring]
    for axis, lim, keep_ge in ((0, x0, True), (0, x1, False), (1, z0, True), (1, z1, False)):
        if not pts:
            break
        inside = (lambda p: p[axis] >= lim) if keep_ge else (lambda p: p[axis] <= lim)
        res = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            ci, pi = inside(cur), inside(prev)
            if ci != pi:
                t = (lim - prev[axis]) / (cur[axis] - prev[axis])
                res.append((prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])))
            if ci:
                res.append(cur)
        pts = res
    return pts


def inside(rings, x, z):
    """even-odd over flat rings [[x, z, x, z, ...], ...]"""
    c = False
    for r in rings:
        n = len(r) // 2
        j = n - 1
        for i in range(n):
            xi, zi, xj, zj = r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]
            if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                c = not c
            j = i
    return c


def locate(A, x, z, near=NEAR):
    """(ortsteil, quarter or None) - the same rule as js/areasign.js"""
    o = next((a["name"] for a in A["ortsteile"] if inside(a["rings"], x, z)), None)
    best, bd = None, near
    for qn in A["quarters"]:
        d = ((qn["x"] - x) ** 2 + (qn["z"] - z) ** 2) ** 0.5
        if qn["in"] == o and d <= bd:
            best, bd = qn["name"], d
    return o, best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--pbf", default=PBF)
    a = ap.parse_args()
    t0 = time.time()
    out = os.path.join(HERE, "levels", a.name)
    L = json.load(open(os.path.join(out, "level.json")))
    M = json.load(open(os.path.join(out, "map.json")))
    F, ext = Frame(L), L["extent"]
    box = (ext["minX"] - MARGIN, ext["minZ"] - MARGIN, ext["maxX"] + MARGIN, ext["maxZ"] + MARGIN)
    with tempfile.TemporaryDirectory() as td:
        raw = load_ortsteile(need_pbf(a.pbf), L["bbox"], td)
    print(f"{len(raw)} admin_level=10 areas near the level ({time.time() - t0:.0f} s)")

    ortsteile = []
    for name, oid, polys in raw:
        rings = []
        for poly in polys:
            for ring in poly:
                xz = F.xz(ring)
                if np.allclose(xz[0], xz[-1]):
                    xz = xz[:-1]
                xz = dp(np.vstack([xz, xz[:1]]), SIMPLIFY)[:-1]   # closed for DP, open again after
                c = clip_rect(xz, *box)
                if len(c) >= 3:
                    rings.append([round(float(v), 1) for p in c for v in p])
        if rings:
            ortsteile.append({"name": name, "osm": oid, "rings": rings})
    # the largest share of the level first (cheap early hit in the client)
    ortsteile.sort(key=lambda o: -sum(len(r) for r in o["rings"]))

    A = {"ortsteile": ortsteile, "quarters": []}
    for kind, name, x, z in (p[:4] for p in M.get("places", []) if p[0] in QUARTER_KINDS):
        o = next((a["name"] for a in ortsteile if inside(a["rings"], x, z)), None)
        A["quarters"].append({"name": name, "kind": kind, "x": round(x, 1), "z": round(z, 1), "in": o})
    A.update({
        "format": "ortsteile[].rings: flat [x0, z0, x1, z1, ...] in level metres (x east, z -north), "
                  "even-odd over all rings of one Ortsteil; quarters[]: point + the Ortsteil it lies in",
        "near": NEAR, "simplify": SIMPLIFY,
        "source": "OpenStreetMap boundary=administrative admin_level=10 (local extract via osmium) "
                  "and map.json places (quarter/neighbourhood), (c) OpenStreetMap contributors, ODbL",
    })
    path = os.path.join(out, "areas.json")
    with open(path, "w") as fh:
        json.dump(A, fh, ensure_ascii=False, separators=(",", ":"))

    print("Ortsteile:")
    for o in ortsteile:
        print(f"  {o['name']:<22} {len(o['rings'])} ring(s), {sum(len(r) for r in o['rings']) // 2} points")
    print("quarters:")
    for qn in A["quarters"]:
        print(f"  {qn['name']:<26} {qn['kind']:<13} in {qn['in']}")
    spots = [("spawn", L["spawn"]["x"], L["spawn"]["z"]), ("Alexanderplatz", 1000, 80),
             ("Hauptbahnhof", -1800, -200), ("Hackescher Markt", 490, -35)]
    print("spot check:")
    for label, x, z in spots:
        o, qn = locate(A, x, z)
        print(f"  {label:<17} ({x:7.1f}, {z:7.1f})  Ortsteil {o}, quarter {qn} -> sign '{qn or o}'")
    print(f"wrote {path} ({os.path.getsize(path) / 1024:.1f} KB, {time.time() - t0:.0f} s)")


if __name__ == "__main__":
    sys.exit(main())

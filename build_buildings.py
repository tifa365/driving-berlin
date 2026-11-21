#!/usr/bin/env python3
"""Building footprint mask for a level (camera collision: only buildings move the camera).

  python3 build_buildings.py --name mitte_all [--pbf berlin-latest.osm.pbf] [--buffer 2]

Reads levels/<name>/level.json (bbox, origin, extent), cuts the bbox out of a local
OSM extract with the `osmium` CLI (no network), rasterises every `building=*` area
(ways + multipolygons, holes kept open; `building=no` skipped) at 1 m and grows it
by --buffer metres (OSM vs. photogrammetry offset, eaves). Only walls standing on the
ground count: things OVER the street are left out / cut out again after the buffer
(a deck over the car must never move the camera, see js/camcollide.js `over`):
  - dropped: building=bridge|roof|carport|canopy, bridge=* (not no),
    layer > 0 (station halls on the viaduct, roofs over platforms), min_height /
    building:min_level > 0 (floating parts);
  - cut out: railway / highway ways with bridge=* (not no) buffered by their half width
    (tracks 3.5 m, roads width/2 or lanes * 1.75 + 1.5 m, default 6 m) - this removes the
    Stadtbahn viaduct and the track part of station sheds; man_made=bridge areas;
    tunnel=building_passage / covered=yes ways (passages, gateways) by 3 m; nothing
    underground (layer < 0, tunnel=yes) cuts.
Writes

  levels/<name>/buildings.json : {"file", "cell", "nx", "nz", "x0", "n0", "buffer", "count", "note"}
  levels/<name>/buildings.bin  : packed bits, row j = north n0 + (j + .5) * cell,
                                 column i = east x0 + (i + .5) * cell; a row is
                                 ceil(nx / 8) bytes, bit 7 of byte k = column 8k
                                 (numpy packbits, big bit order). 1 = building.

Frame as build_stream.py / build_level.py: ENU at level.origin, three.js X = E, Z = -N.
Re-runnable (levels/ is gitignored); index.html loads it lazily if present.
"""
import argparse, json, math, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
PBF = os.environ.get("OSM_PBF")   # local OSM extract (.osm.pbf): --pbf or env OSM_PBF
def need_pbf(p):
    if not p:
        sys.exit("no OSM extract: pass --pbf <berlin-latest.osm.pbf> or set OSM_PBF "
                 "(e.g. from download.geofabrik.de/europe/germany/berlin.html)")
    return p
CELL = 1.0
OVER_BUILDING = {"bridge", "roof", "carport", "canopy"}   # no walls to the ground
A_WGS, E2 = 6378137.0, 6.69437999014e-3   # WGS84 (as merge_hybrid.geo_to_ecef)


def ecef(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    N = A_WGS / np.sqrt(1 - E2 * np.sin(la) ** 2)
    return np.stack([N * np.cos(la) * np.cos(lo), N * np.cos(la) * np.sin(lo), N * (1 - E2) * np.sin(la)], -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--buffer", type=float, default=2.0, help="m grown around each footprint")
    a = ap.parse_args()
    need_pbf(a.pbf)
    out = os.path.join(HERE, "levels", a.name)
    L = json.load(open(os.path.join(out, "level.json")))
    W, S, E, N = L["bbox"]
    lat0, lon0 = L["origin"]["lat"], L["origin"]["lon"]
    la, lo = math.radians(lat0), math.radians(lon0)
    R = np.array([[-math.sin(lo), math.cos(lo), 0],
                  [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)]])   # rows E, N
    o = ecef(np.array(lat0), np.array(lon0))
    ext = L["extent"]
    x0, n0 = ext["minX"], -ext["maxZ"]
    nx, nz = int(math.ceil((ext["maxX"] - x0) / CELL)), int(math.ceil((ext["maxZ"] - ext["minZ"]) / CELL))

    with tempfile.TemporaryDirectory() as td:
        box, bld, gj = (os.path.join(td, f) for f in ("box.osm.pbf", "b.osm.pbf", "b.geojsonl"))
        m = 0.002   # deg margin: footprints crossing the edge stay whole
        subprocess.run(["osmium", "extract", "-b", f"{W - m},{S - m},{E + m},{N + m}", a.pbf, "-o", box, "-O", "-s", "smart"], check=True)
        subprocess.run(["osmium", "tags-filter", box, "wr/building", "-o", bld, "-O"], check=True)
        subprocess.run(["osmium", "export", bld, "-f", "geojsonseq", "-o", gj, "-O",
                        "--geometry-types=polygon"], check=True)
        feats = [json.loads(l.lstrip("\x1e")) for l in open(gj) if l.strip()]
        # things over the street: bridges, passages (cut out of the mask after the buffer)
        ov, ovj = os.path.join(td, "o.osm.pbf"), os.path.join(td, "o.geojsonl")
        subprocess.run(["osmium", "tags-filter", box, "w/bridge", "wr/man_made=bridge", "w/tunnel=building_passage",
                        "w/covered=yes", "-o", ov, "-O"], check=True)
        subprocess.run(["osmium", "export", ov, "-f", "geojsonseq", "-o", ovj, "-O",
                        "--geometry-types=linestring,polygon"], check=True)
        overs = [json.loads(l.lstrip("\x1e")) for l in open(ovj) if l.strip()]

    img = Image.new("1", (nx, nz), 0)
    dr = ImageDraw.Draw(img)

    def px(ring):
        ll = np.asarray(ring, float)
        en = (R @ (ecef(ll[:, 1], ll[:, 0]) - o).T).T
        return [((e - x0) / CELL - 0.5, (n - n0) / CELL - 0.5) for e, n in en]   # pixel centre = cell centre

    def num(v):
        try:
            return float(str(v).split(";")[0].replace("m", "").strip())
        except (TypeError, ValueError):
            return 0.0

    count = dropped = 0
    for f in feats:
        p = f.get("properties") or {}
        if p.get("building") == "no":
            continue
        if (p.get("building") in OVER_BUILDING or p.get("bridge", "no") != "no" or num(p.get("layer")) > 0
                or num(p.get("min_height")) > 0 or num(p.get("building:min_level")) > 0):
            dropped += 1
            continue
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            dr.polygon(px(poly[0]), fill=1, outline=1)
            for hole in poly[1:]:
                dr.polygon(px(hole), fill=0)
        count += 1
    mask = np.array(img, bool)
    r = int(round(a.buffer / CELL))
    if r > 0:
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        mask = ndimage.binary_dilation(mask, structure=xx * xx + yy * yy <= r * r)
    # cut out what spans the street (after the buffer, so neighbours do not grow back over it)
    cut = Image.new("1", (nx, nz), 0)
    dc = ImageDraw.Draw(cut)
    ncut = 0
    for f in overs:
        p, g = f.get("properties") or {}, f["geometry"]
        if p.get("bridge", "yes") == "no" and p.get("man_made") != "bridge" and p.get("tunnel") != "building_passage" and p.get("covered") != "yes":
            continue
        if num(p.get("layer")) < 0 or p.get("tunnel") in ("yes", "culvert") or p.get("location") == "underground":
            continue   # underground (U-Bahn passages, covered stairs below ground): the building above is a wall
        if g["type"] in ("Polygon", "MultiPolygon"):
            for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
                dc.polygon(px(poly[0]), fill=1, outline=1)
            ncut += 1
            continue
        if g["type"] != "LineString":
            continue
        if p.get("bridge", "no") != "no":
            if p.get("railway"):
                half = 3.5
            elif num(p.get("width")) > 0:
                half = num(p.get("width")) / 2 + 1.0
            elif num(p.get("lanes")) > 0:
                half = num(p.get("lanes")) * 1.75 + 1.5
            else:
                half = 6.0 if p.get("highway") not in ("footway", "path", "cycleway", "steps", "pedestrian") else 3.0
        else:
            half = 3.0   # building passage / covered way
        pts = px(g["coordinates"])
        w = max(1, int(round(2 * half / CELL)))
        dc.line(pts, fill=1, width=w)
        for x, y in pts:   # round joints
            dc.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=1)
        ncut += 1
    cutm = np.array(cut, bool)
    mask &= ~cutm
    tmp = os.path.join(out, "buildings.bin.tmp")
    np.packbits(mask, axis=1).tofile(tmp)
    os.replace(tmp, os.path.join(out, "buildings.bin"))
    meta = {"file": "buildings.bin", "cell": CELL, "nx": nx, "nz": nz, "x0": x0, "n0": n0,
            "buffer": a.buffer, "count": count, "dropped_over": dropped, "cut_over": ncut, "source": "OpenStreetMap building=* (osmium, local extract)",
            "note": "packed bits (numpy packbits, bit 7 = first column), row stride ceil(nx/8); "
                    "row j = north n0 + (j+.5)*cell, column i = east x0 + (i+.5)*cell; 1 = building + buffer"}
    json.dump(meta, open(os.path.join(out, "buildings.json"), "w"), indent=1)
    print(f"{a.name}: {count} buildings ({dropped} roofs/bridges/raised dropped, {ncut} bridges/passages cut out, "
          f"{cutm.mean() * 100:.1f} % of the area), {nx}x{nz} @ {CELL:g} m, {mask.mean() * 100:.1f} % covered "
          f"(buffer {a.buffer:g} m) -> {out}/buildings.bin")


if __name__ == "__main__":
    sys.exit(main())

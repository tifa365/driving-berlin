#!/usr/bin/env python3
"""Stage the mesh tiles Driving Berlin streams, for upload as the dataset `driving-berlin-tiles`.

  python3 tools/stage_tiles.py [--out driving-berlin-tiles/] [--level mitte_all]

Hard-links (os.link: no extra disk) every tile listed in levels/<level>/tiles.json from the local
mirror ../berlin_mesh_2025_wab/ into <out>/L#/<REGION>/<name>.b3dm - the same relative paths the
game requests, so the dataset's resolve/main/ URL is the site's "tiles" root (site.json). Writes
<out>/README.md (dataset card: source, attribution, licence note). The output folder must be on
the same filesystem as the mirror. Re-runs skip tiles already linked. Stdlib only.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # racing/
MIRROR = os.path.join(os.path.dirname(HERE), "berlin_mesh_2025_wab")

CARD = """---
pretty_name: Driving Berlin tiles (3D-Meshmodell Berlin 2025, Mitte)
license: other
license_name: berlin-3d-mesh-2025
tags:
  - 3d
  - 3d-tiles
  - mesh
  - photogrammetry
  - berlin
---

# Driving Berlin tiles

The {n:,} mesh tiles ({mb:,.0f} MB, `.b3dm`, OGC 3D Tiles 1.0) that the browser game
*Driving Berlin* streams: the photogrammetric 3D city mesh of Berlin 2025 for Ortsteil Mitte
(about 4.4 x 4.1 km), levels L4 (coarsest) to L1 (finest), stored under their original relative
paths `L#/<REGION>/<name>.b3dm`. The tile index (positions, transforms, parents) is the game's
`levels/mitte_all/tiles.json`; this dataset holds only the tile files.

## Source

3D-Meshmodell Berlin 2025, Berlin 3D download portal
(https://www.businesslocationcenter.de/berlin3d-downloadportal/), listed in the Berlin open-data
register as "3D-Meshmodell Berlin"
(https://daten.berlin.de/datensaetze/3d-meshmodell-berlin). Tiles are unchanged copies.

## Attribution

3D-Meshmodell Berlin 2025 © Berlin Partner für Wirtschaft und Technologie GmbH

The data belongs to the provider named above. *Driving Berlin* is a free, non-commercial hobby
project; it is not affiliated with or endorsed by Berlin Partner or the State of Berlin.

## Licence

Not an open licence: the open-data register lists the portal resource as "other-closed"
(http://dcat-ap.de/def/licenses/other-closed); the portal's terms of use
(https://www.businesslocationcenter.de/berlin3d-downloadportal/resources/terms/terms.de.html)
apply. Always credit the provider as above. If you reuse these files, the portal's terms apply
to you as well.
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "driving-berlin-tiles"))
    ap.add_argument("--level", default="mitte_all")
    ap.add_argument("--mirror", default=MIRROR)
    a = ap.parse_args()
    doc = json.load(open(os.path.join(HERE, "levels", a.level, "tiles.json")))
    paths = sorted({t[0] for t in doc["tiles"]})
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    if os.stat(out).st_dev != os.stat(a.mirror).st_dev:
        sys.exit(f"{out} is not on the same filesystem as {a.mirror} - hard links impossible")
    n = linked = total = 0
    missing = []
    for p in paths:
        s, d = os.path.join(a.mirror, p), os.path.join(out, p)
        if not os.path.exists(s):
            missing.append(p); continue
        if not os.path.exists(d):
            os.makedirs(os.path.dirname(d), exist_ok=True)
            os.link(s, d); linked += 1
        elif not os.path.samefile(s, d):
            sys.exit(f"{d} exists and is not a link to {s}")
        n += 1; total += os.path.getsize(s)
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write(CARD.format(n=n, mb=total / 1e6))
    print(f"{n} tiles ({linked} newly linked), {total:,} bytes = {total / 1e6:,.0f} MB in {out}")
    if missing:
        print(f"MISSING {len(missing)} tiles in {a.mirror}, e.g. {missing[:3]}", file=sys.stderr)
        sys.exit(1)
    card = open(os.path.join(out, "README.md"), encoding="utf-8").read()
    if "/home/" in card:
        sys.exit("dataset README contains a /home path")


if __name__ == "__main__":
    main()

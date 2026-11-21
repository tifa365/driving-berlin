#!/usr/bin/env python3
"""Stage the public copy of Driving Berlin for a static host (GitHub Pages).

  python3 tools/publish_site.py --out site/ --tiles https://huggingface.co/datasets/<account>/driving-berlin-tiles/resolve/main/

Copies index.html, js/, Box2D.js, assets/, models/ and the runtime files of the level
(explicit list below, taken from what index.html and js/*.js fetch - not the whole
levels/ folder, which also holds build inputs, scans and OSM extracts). map.html (the spot list)
is the owner's tool page and is not published (the game no longer links it, 2026-11-21). Every .bin is written
gzipped as <name>.bin.gz (static hosts do not compress .bin; js/site.js unpacks it). Writes
site.json ({"tiles": URL, "gz": true}) and .nojekyll, prints the size, and exits non-zero when a
staged text file contains "/home/" or something that looks like a mail address.

--out is emptied first (only if it looks like an earlier output: it holds site.json, or is empty).
Stdlib only.
"""
import argparse, gzip, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # racing/
LEVEL = "mitte_all"                                                   # index.html: const LEVEL

# runtime files of levels/<LEVEL>/ and who loads them; .bin names of the binary layers come from
# their JSON metadata ("file"), plus level.json's height / water / pit entries
LEVEL_JSON = [
    ("level.json", True),       # index.html
    ("tiles.json", True),       # js/stream.js (level.stream.file)
    ("occlusion.json", False),  # js/stream.js (occlusion step; missing = off)
    ("map.json", False),        # js/minimap.js, js/clutter.js
    ("walls.json", False),      # js/walls.js
    ("clutter.json", False),    # js/clutter.js (index.html HEAD probe)
    ("buildings.json", False),  # index.html (camera collision)
    ("roofs_deck.json", False), # js/roofs.js
    ("tunnels.json", False),    # js/tunnels.js
    ("bridges.json", False),    # js/bridges.js
    ("sbahn.json", False),      # js/sbahn.js
    ("spots.json", False),      # index.html
    ("eggs.json", False),       # js/eggs.js, js/intro.js (bear count)
    ("doorway.json", False),    # js/doorway.js (via js/eggs.js; doorway figure, garden fountain)
    ("areas.json", False),      # js/areasign.js, js/loading.js (area street sign; assets/fonts/ goes with assets/)
    ("sights.json", False),     # js/sights.js (debt clock, stork's nest)
]
APP = ["index.html", "Box2D.js", "js", "assets", "models"]
TEXT = (".html", ".js", ".mjs", ".json", ".md", ".css", ".txt")
MAIL = re.compile(rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


def level_bins(src):
    """binary files the game loads, from the level's JSON metadata"""
    L = json.load(open(os.path.join(src, "level.json")))
    bins = []
    for k in ("height", "water"):
        if L.get(k, {}).get("file"):
            bins.append(L[k]["file"])
    if L.get("pit"):
        bins += [L["pit"]["file"], L["pit"]["floor"]["file"]]
    for j, default in (("occlusion.json", None), ("walls.json", None), ("clutter.json", None),
                       ("buildings.json", None), ("roofs_deck.json", "roofs_deck.bin")):
        p = os.path.join(src, j)
        if os.path.exists(p):
            f = json.load(open(p)).get("file", default)
            if f:
                bins.append(f)
    return bins


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output folder (e.g. site/)")
    ap.add_argument("--tiles", required=True, help="tile root URL, ends with / (the Hugging Face dataset's resolve/main/)")
    ap.add_argument("--no-gz", action="store_true", help="keep .bin files plain (site.json gz false)")
    a = ap.parse_args()
    tiles = a.tiles if a.tiles.endswith("/") else a.tiles + "/"
    out = os.path.abspath(a.out)
    if os.path.isdir(out) and os.listdir(out):
        if not os.path.exists(os.path.join(out, "site.json")):
            sys.exit(f"{out} is not empty and holds no site.json - refusing to clear it")
        shutil.rmtree(out)
    os.makedirs(out)

    for n in APP:
        s, d = os.path.join(HERE, n), os.path.join(out, n)
        if os.path.isdir(s):
            shutil.copytree(s, d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".*"))
        else:
            shutil.copy2(s, d)

    src = os.path.join(HERE, "levels", LEVEL)
    dst = os.path.join(out, "levels", LEVEL)
    os.makedirs(dst)
    raw = packed = 0
    for name, required in LEVEL_JSON:
        p = os.path.join(src, name)
        if not os.path.exists(p):
            if required:
                sys.exit(f"missing required level file {p}")
            print(f"  note: optional {name} not built - skipped (the game runs without it)")
            continue
        shutil.copy2(p, os.path.join(dst, name))
    for name in level_bins(src):
        p = os.path.join(src, name)
        b = open(p, "rb").read()
        raw += len(b)
        if a.no_gz:
            open(os.path.join(dst, name), "wb").write(b)
            packed += len(b); continue
        z = b if b[:2] == b"\x1f\x8b" else gzip.compress(b, 9, mtime=0)   # occlusion.bin is gzip already
        open(os.path.join(dst, name + ".gz"), "wb").write(z)
        packed += len(z)
        print(f"  {name}: {len(b) / 1e6:.2f} MB -> {len(z) / 1e6:.2f} MB")

    json.dump({"tiles": tiles, "gz": not a.no_gz}, open(os.path.join(out, "site.json"), "w"), indent=1)
    open(os.path.join(out, ".nojekyll"), "w").close()

    # guard: nothing private in any staged text file
    hits, total, nfiles = [], 0, 0
    for root, _, files in os.walk(out):
        for f in files:
            p = os.path.join(root, f)
            total += os.path.getsize(p); nfiles += 1
            if not f.endswith(TEXT):
                continue
            b = open(p, "rb").read()
            rel = os.path.relpath(p, out)
            for m in re.finditer(rb"/home/", b):
                hits.append(f"{rel}: '/home/' near {b[max(0, m.start() - 40):m.end() + 40]!r}")
            for m in MAIL.finditer(b):
                hits.append(f"{rel}: mail-like {m.group(0)!r}")
    print(f"staged {nfiles} files, {total / 1e6:.1f} MB in {out} (level .bin {raw / 1e6:.1f} MB -> {packed / 1e6:.1f} MB)")
    print(f"tiles from {tiles}")
    if hits:
        print("GUARD: private-looking text in the staged site - fix the source, do not publish:", file=sys.stderr)
        for h in hits[:50]:
            print("  " + h, file=sys.stderr)
        sys.exit(1)
    print("guard ok: no /home/ paths, no mail addresses")


if __name__ == "__main__":
    main()

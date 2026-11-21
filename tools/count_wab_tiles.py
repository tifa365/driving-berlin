"""Count berlin-wab mesh tiles per level inside a lon/lat box, from the LOCAL index
(berlin_mesh_2025_wab/, no network). Size estimate uses the per-level means from
MESH_BACKUP_PLAN.md.

  python3 racing/tools/count_wab_tiles.py W S E N
"""
import json, os, sys, collections, urllib.parse
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO)
import download_berlin_mesh as DL
from matplotlib.path import Path
R = os.path.join(REPO, "berlin_mesh_2025_wab")
lo = [float(v) for v in sys.argv[1:5]]
class _P:
    def contains_point(self, p): return lo[0] <= p[0] <= lo[2] and lo[1] <= p[1] <= lo[3]
poly = _P(); ring = []
print('bbox', lo)
base_url = DL.WAB_ROOT.rsplit('/', 1)[0] + '/'
cnt = collections.Counter(); inside = collections.Counter(); missing = 0
stack = [('tileset.json', DL.IDENT)]
seen = set()
while stack:
    rel, T = stack.pop()
    if rel in seen: continue
    seen.add(rel)
    p = os.path.join(R, rel)
    if not os.path.exists(p): missing += 1; continue
    doc = json.load(open(p))
    def walk(node, T_in, dirrel):
        T2 = DL.matmul(T_in, DL.mat_from_colmajor(node['transform'])) if 'transform' in node else T_in
        box = (node.get('boundingVolume') or {}).get('box')
        if box:
            wb = DL.world_box_lonlat(T2, box)
            if not DL.overlaps(wb, lo): return
        c = node.get('content') or {}
        uri = c.get('uri') or c.get('url') or ''
        if uri.endswith('.json'):
            stack.append((os.path.normpath(os.path.join(dirrel, uri)), T2))
        elif uri.endswith('.b3dm'):
            lvl = DL.level_of(uri); cnt[lvl] += 1
            if box:
                cx, cy = (wb[0] + wb[2]) / 2, (wb[1] + wb[3]) / 2
                if poly.contains_point((cx, cy)): inside[lvl] += 1
        for ch in node.get('children', []): walk(ch, T2, dirrel)
    walk(doc['root'], T, os.path.dirname(rel))
MB = {0: 169e3/552661, 1: 82e3/144282, 2: 18e3/32655, 3: 11e3/9242}
print('index files read', len(seen), 'missing', missing)
print('level  tiles(bbox)  tiles(inside ring)  est. GB inside')
for l in sorted(inside):
    print(f'L{l:<3} {cnt[l]:>10} {inside[l]:>14}   {inside[l]*MB.get(l, 0.5)/1000:7.1f}')

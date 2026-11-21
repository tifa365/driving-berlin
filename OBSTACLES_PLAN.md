# Obstacles plan (saved 2026-11-16, not implemented yet)

> Note 2026-11-19: the small level `mitte` was retired; `mitte_all` is the only level.

## Context
The photogrammetric mesh (2025) shows many things no dataset has: beer trucks
(Bierwagen), café chairs, market stalls, construction sites (Baustellen), fences,
kiosks, parked cars. Today the car collides only with LoD2 buildings, Baumkataster
trunks (only where the mesh shows a crown) and OSM water, so it drives straight through
everything else it visibly hits. Goal: whatever the mesh shows standing on the ground
becomes collidable, without blocking roads with noise.

A probe on level `mitte` (2026-11-16) proved feasibility: the market stalls on the
Unter den Linden promenade were found. Problems seen: red bands along nearly every
facade (overhangs, LoD2 vs mesh offset), and only 13 % of 0.5 m cells contain a mesh
vertex (flat surfaces use big triangles), so vertex-max heights are blobby.
Probe numbers: 961 objects >= 1.5 m (14,500 m²), 1,174 objects >= 0.8 m — far too
many, mostly facade noise.

## Revision 2026-11-16: colour vs. OSM is the primary signal
Measured around the spawn: small street furniture (chairs, parasols, beer trucks) is
often **not** 3D in the Berlin mesh — mostly flat photo texture; what rises clearly is
vegetation/building parts (6–10 m) and a few stall-sized objects (2.5–3.7 m). So height
alone misses most of what the owner wants. Primary detection is now **colour anomaly
per OSM class** (the owner's idea): a Baustelle looks different from the asphalt OSM
expects there.

- **Class map**: reuse `osm_semantic.py` (classes: road, path, parking, green, water,
  building) on the level lattice (0.25–0.5 m), plus OSM `landuse=construction`,
  `highway=construction`, `barrier=*` as direct hints.
- **Ortho colour**: rasterize the mesh *texture* top-down (same triangle z-buffer as
  step 1 below, carrying UV → texel colour) = a true orthophoto of the level.
- **Learn per level**: per class robust colour stats in CIELab (median + MAD of a*, b*,
  and L separately).
- **Anomaly**: chroma distance (a*, b*) from the class median, brightness-tolerant so
  shadows do not trigger; strong hits (red/white, yellow, orange, saturated blue) count
  alone, weak hits need height (nDSM > 0.5 m) as second evidence.
- **Filters**: drop thin features (markings, zebras, tram rails: opening with a 1 m
  disk), min area 2 m², compact shape; parked cars per the open decision.
- **Optional hint layer**: VIZ Berlin construction sites (current, not 2025) only as a
  weak prior, never alone.
- **Two independent triggers (owner, 2026-11-16: "everything rising from the street
  should be collidable")**: a cell is an obstacle if it **rises** (height channel below)
  **or** is a strong **colour anomaly**. Weak colour anomalies still need a little height
  (> 0.5 m) as confirmation.

## Approach (height channel — trigger 1; all in `racing/build_level.py`, one new layer like water/trees)

1. **Top-surface raster (z-buffer)** at 0.25–0.5 m: rasterize every mesh triangle
   (max height per cell), vectorised in numpy — bbox per triangle, barycentric test,
   `np.maximum.at`. Replaces vertex-max. Input = the `prims` already built in
   `main()` (positions X=E, Y=U, Z=-N; `clip_prims` output).
2. **nDSM** = top − road model (`height` grid already computed, bilinear upsample).
3. **Candidates**: nDSM between `--obst-min` (default 1.0 m) and 12 m, and not:
   - LoD2 building mask (`mask`) dilated ~0.5 m,
   - water (`water`),
   - register tree crowns (radius ~4.5 m around `trees`), see 4 for unregistered trees.
4. **Vegetation by colour**: sample the mesh texture at each candidate cell (need UV
   + decoded JPEG per prim: keep `pr["uv"]`, `pr["img"]` from `MT.tile_primitives`;
   decode with PIL once per tile). Green dominant (g > r·1.1 and g > b·1.1, or ExG
   index) → vegetation → not hard (optionally a "soft" surface later).
5. **Facade band filter**: within 3 m of a LoD2 wall, drop candidates that are
   connected to the wall and taller than ~4 m (overhangs/balconies/registration
   offset), keep low ones (café chairs, stalls 1–3.5 m).
6. **Cleanup**: binary opening, connected components, keep area >= 2 m²
   (`--obst-min-area`), drop components touching the level border.
7. **Parked cars are obstacles** (decided by the owner: everything rising from the
   street collides). Keep a `--parked-cars exclude` switch only as an escape hatch.
8. **Colliders**: trace components like the LoD2 walls (contourpy + `rdp`, same 0.6 m
   boxes) → `level.json["obstacles"]` (polylines) with per-object height and area;
   print counts.

## Game (`racing/index.html`)
- Add obstacles to `wallBody` exactly like `level.walls` (`addWall`).
- `F` debug overlay: obstacles in a second colour (e.g. orange), so they can be
  checked against the mesh.

## Critical files / reuse
- `racing/build_level.py`: `rdp()`, contour tracing block, `to_en()`, `mask`, `water`,
  `trees`, `height`, Overpass fallback loop (`osm_semantic.OVERPASS`).
- `merge_tiles.py`: `tile_primitives()` (pos, uv, idx, img), `write_glb`.
- `racing/index.html`: `addWall()`, `wallLines` / `wallViz`, `window.berlinDrive`
  test hook (`teleport`, `simulate`, `state`, `showDebug`).
- Probe script logic from this session (vertex-max nDSM + overlay PNG) is the
  starting point for a `--debug-obstacles` PNG output.

## Verification
1. `python3 racing/build_level.py --name mitte --bbox 13.3745 52.5135 13.3830 52.5210 --no-mesh --spawn 13.3805 52.51634 80`
   → prints obstacle counts; writes a debug PNG (hillshade + obstacles + buildings +
   trees + water). Target: facade bands gone, stalls kept, total area plausible.
2. Debug PNG must also show the orthophoto with anomaly overlay; owner reviews it on a
   swipe page (ortho vs. ortho+obstacles) before colliders go live.
3. Headless Chrome test (`racing/serve.py` + CDP script with `berlinDrive.showDebug`,
   `teleport`, `simulate`): screenshot known spots — promenade market stalls, any
   construction site / beer truck found in the level, a kerbside lane with parked cars —
   and confirm overlay outlines sit on the visible objects.
4. Drive test via `simulate`: car at 50 km/h into a stall stops; lanes stay drivable
   (straight run east on Unter den Linden from spawn unchanged).
5. Commit in the racing repo; README "How the level is built" gets an Obstacles bullet.

## Decisions
- Everything rising from the street is collidable, parked cars included (owner, 2026-11-16).
  **Superseded on road surfaces (owner, 2026-11-18, `ROAD_CLEARANCE_PLAN.md`):** on the
  carriageway (incl. kerb parking lanes) only objects > 2 m collide; off the road the 0.5 m
  rule stays (`build_level.py --roads wfs|osm|off`, `--road-min`).
- Height and colour anomaly are independent triggers (either one suffices).

## Streamed level `mitte_all` (2026-11-19, implemented)
`build_clutter.py --name mitte_all` runs the same height channel (`build_level.raster_top`,
`obstacle_layer`, `road_mask`) on 500 m chunks (+40 m margin; objects kept by outline centre)
over the L1 leaf tiles, with OSM footprints (`buildings.bin`, +2 m) instead of LoD2 and the
level's 4 m height grid as the road model (the local 16 m ground opening does the rest). Kept
free: spawn, eggs, Weltballon platform, S-Bahn entrance / drop-offs, no-drive zones, viaduct
corridor, OSM bridges; obstacles on drivable OSM centre lines are dropped. Trunks: Baumkataster
where the mesh shows a crown. Output `clutter.bin/json` (64 m cells as `js/walls.js`);
`js/clutter.js` builds cell bodies around the car, off with the Obstacles switch and in S-Bahn
rails mode. The colour channel is still open here as on the small level.
Fix 2026-11-19 (owner's bug: blue site containers at 52.51829 N 13.3811 E did not block): they stand against a
house, half in the facade band (dropped), the 16 m ground opening took their top for ground next to the wall
(`gr` up to 7 m), and the remaining part failed the steep-sides test (0.23 < 0.33) on its cut side. New in
`obstacle_layer(..., blocks=True)` (used by build_clutter.py): flat-topped blocks >= 10 m2, >= 2.3 m over a street
ring around them, >= 2 m under the adjacent roof, not green, are kept whole (`OBST_BLOCK_H`, `OBST_BLOCK_AREA`).

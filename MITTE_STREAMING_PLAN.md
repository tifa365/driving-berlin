# Plan: drive all of Ortsteil Mitte (saved 2026-11-16)

> Note 2026-11-19: the small level `mitte` was retired; `mitte_all` is the only level.

**Status 2026-11-18: visuals done** - `?level=mitte_all` streams the local tiles
(`build_stream.py` + `js/stream.js`, own streamer instead of 3DTilesRendererJS, which
needs three >= 0.167; see README). Steps 1-2 and 7 are done (tiles are on disk in
`berlin_mesh_2025_wab/`, served by `serve.py` under `/tiles/`); step 6 is superseded.
Still open: steps 3 and 5 (LoD2 walls, trees, obstacles for the big area - the car drives
through buildings for now), step 4 (optional recompression) and the FPS check on a real GPU.

## Goal
Grow the racing area from the 0.6 × 0.8 km patch around the Brandenburger Tor to all of
Ortsteil Mitte (Unter den Linden, Museumsinsel, Alexanderplatz, Spandauer Vorstadt),
streamed so the browser only ever holds what is around the car.

## Decisions so far (owner, 2026-11-16)
- Area: **Ortsteil Mitte**, not Bezirk Mitte (that would be ≈ 17 GB at L0).
  Box used for the numbers: `13.3640 52.5040 13.4290 52.5410` (W S E N), approximate.
- Detail: **L1 is enough** for the 60 m chase camera (≈ 12 cm/px). No L0.
- **L1 + coarser levels** (L2…L17): the coarse parents are what a 3D Tiles streamer
  shows instantly while L1 loads, so there are no holes at speed.
- Download **later** (not yet run).

## Numbers (local index, `racing/tools/count_wab_tiles.py`, no network)
| level | tiles in box | est. size |
|---|---|---|
| L0 | 9,551 | 2.9 GB (skipped) |
| L1 | 2,506 | 1.4 GB |
| L2 | 545 | 0.3 GB |
| L3 | 143 | 0.2 GB |
| L4+ | < 50 | ~0 |
| **download** | **≈ 2,700** | **≈ 1.9 GB** |

Disk on 2026-11-16: 14 GB free. Recompressed with `optimize_tiles.py` (meshopt + WebP;
measured 1.2 GB → 426 MB on the old cache) ≈ 0.65 GB.

## Steps
1. **Downloader: "finest level" option.** `download_berlin_mesh.py --level N` keeps
   only ONE level. Add `--finest N` = keep every tile with level >= N and do not descend
   below N (in `Crawler.walk`: skip tiles with `level_of(uri) < N`, set `descend = False`
   once a tile of level N is reached). Stdlib only, like the rest.
2. **Download** from the berlin-wab mirror (portal still in maintenance — check first):
   ```bash
   curl -sI https://berlin-wab.virtualcitymap.de/datasource-data/baselayer/mesh_2025/tileset.json
   python3 download_berlin_mesh.py --root https://berlin-wab.virtualcitymap.de/datasource-data/baselayer/mesh_2025/tileset.json \
       --bbox 13.3640 52.5040 13.4290 52.5410 --finest 1 --out berlin_mesh_2025_wab --workers 8
   ```
   Keep 8 workers (third-party server). Resumable; re-run after drops. Re-fetches the
   index JSONs of the box (they exist locally already, same content).
   Expected time: ~10–15 min at the 4 MB/s measured before; 2–3 h on a slow line.
3. **LoD2 for the box** (collision, height model):
   `python3 download_vcm_lod2.py --bbox 13.3640 52.5040 13.4290 52.5410` (into
   `berlin_lod2_vcm/`).
4. **Optional:** `optimize_tiles.py` into `berlin_mesh_2025_wab_opt/` (point it at the
   wab folder; check its `--src/--out` handling first).
5. **Collision/height for all of Mitte, loaded once** (small: est. ~50k wall segments,
   ~13 MB height grid): `build_level.py --name mitte_all --bbox … --mesh-src
   berlin_mesh_2025_wab --no-mesh` (build_level reads the mesh only for the height
   offset, trees visibility and later obstacles; make it accept a tileset that has no
   L0 — `select_leaves` already takes the finest present tile).
6. **Visual streaming in the game** — recommended: **3DTilesRendererJS**
   (NASA-AMMOS, three.js, reads 3D Tiles/b3dm directly) on the wab `tileset.json`:
   - place it in our ENU frame (same origin as `level.json`: invert the ENU rotation
     used in `build_level.py`, apply as the tiles group matrix);
   - cap refinement at L1 (missing L0 children must not be requested: either prune
     L0 `children` from a served copy of the JSONs, or limit by `errorTarget`/depth);
   - photogrammetry is unlit: swap materials to `MeshBasicMaterial` on tile load
     (same as `world.glb` today);
   - load radius ~400 m around the car, unload behind (the library's LRU cache).
   Fallback if that is awkward: own chunk streamer — convert each L1 tile once to a
   placed GLB + `index.json` with bounds, load within 400 m, unload beyond 500 m.
7. **Serving:** `racing/serve.py` serves the game; tiles come from the local
   `berlin_mesh_2025_wab/` (symlink or a static route). No live dependency on the mirror
   while playing. (`serve.py` in the parent repo can proxy+LRU-cache live tiles with
   `--prune-gb`, but points at the dead portal and would need `--root` for wab.)

## Verification
- `count_wab_tiles.py` numbers vs. files on disk after the download (L1 ≈ 2,506).
- Headless test (`berlinDrive` hook): drive the length of Unter den Linden to
  Alexanderplatz with `simulate`, screenshot at intervals: no holes, coarse→L1 swap
  visible only briefly; log loaded tile count and JS heap (target < ~60 tiles, < 300 MB).
- Collision still matches the mesh (F overlay) in a few spots across Mitte.
- Frame rate on the owner's machine via a temporary FPS readout.

## Related
- `OBSTACLES_PLAN.md` (mesh-derived obstacles) applies per area once this exists.
- Ghost-station easter egg idea (S+U Brandenburger Tor entrances, CC BY station model
  "Lowpoly Berlin U-bahn Station" by n-malmberg as an option) — not planned in detail yet.

## Streaming fixes (2026-11-19)
Owner, after the first play-test: "tiles become bad quality from time to time". Measured with
a headless drive (Unter den Linden east from the spawn at 50 km/h, 45 s, one left and one right
turn; counters in `berlinDrive.stream.stats().events`), see the table below.

**Causes found**
1. **All-or-nothing fallback.** When a refined tile had *one* visible child not loaded (a new
   child entering the view on a turn, or one evicted), the whole subtree snapped back to the
   nearest loaded ancestor, often an L4 root (~1 km tile): twice in the drive the entire view
   was 2 L4 tiles. 146 downgrade events in 45 s.
2. **Budget full at rest.** 31 tiles = 255 of 256 MB standing still (the estimate is honest:
   2048x1024 RGBA8 + mips = 11 MB per texture, ~8 MB per L1 tile). So everything leaving the
   wanted set was evicted at once - including the parents needed as fallback and the
   siblings just outside the frustum: 89 evictions, 28 of them re-requested within 10 s.
3. Children were culled with the parent's bounding sphere, which does not always contain
   theirs (tiles dropped at the screen edge), and there was no hysteresis at the tau border.

**Changes (`js/stream.js`)**
- A tile refines only when *all* its children are loaded (also those outside the view); what
  is drawn is always complete, so a drawn region never falls back because one child is
  missing. Parents first: a tile is requested only once its parent is in.
- Hysteresis: a refined tile coarsens only below 0.7 x tau.
- Never evicted: everything the last selection touched (drawn tiles, their ancestors and
  siblings, the look-ahead) and fading tiles; above the budget the look-ahead goes first.
- Look-ahead: the same selection for the camera predicted 1.5 s and 3 s ahead (velocity and
  yaw rate, 1.3x fov, so turns are covered), plus L1 within 120 m of the car.
- Culling spheres grown over all descendants.
- Dither cross-fade (350 ms) between a parent and its children, complementary per pixel
  (no overlap, no gaps; works on top of the mood grade, depth stays complete for the ghost).
  Tiles that come into view from the side appear at once.
- Uploads time-sliced (4 ms per frame). JPEG decode was already off the main thread
  (GLTFLoader uses `createImageBitmap` in Chrome).
- Default budget **1024 MB** (`level.json` / `build_stream.py --budget-mb`); the 60/60 view
  measured 650-730 MB for the view set (drawn + ancestors + siblings), up to ~940 MB with
  look-ahead. On-screen **Detail** dropdown: low = 512 MB / tau 32, normal = 1024 / 24,
  high = 1536 / 18 (saved in localStorage; `?tilebudget=` still overrides the budget).

**Counters, same 45 s drive (headless, SwiftShader, game loop parked, physics + streamer stepped in real time)**
| | before (256 MB) | after (1024 MB) |
|---|---|---|
| downgrade events (sharp spot drawn coarser while in view) | 146 | **0** |
| whole view collapsed to L4 | 2x | 0 |
| holes | 5 | 10 (probably refined tiles with no child inside the frustum - unverified) |
| evictions / re-requested within 10 s | 89 / 28 | 87 / 22 (budget full while driving, LRU; none drawn) |
| tiles at the start / MB | 31 / 255 | 94 / 711 |

## Streaming round 2 (2026-11-19, `js/stream.js`)
Done ("by the book" list):
- **Cancel stale requests**: `AbortController` per fetch; a request nobody wants for 250 ms is
  aborted, bytes that already arrived are dropped before parsing, a loaded tile nobody touched
  for 250 ms is discarded before its upload. A near tile waiting behind a full pipe pre-empts
  the farthest look-ahead request; a free slot is refilled at once (was: every 100 ms).
- **Dynamic SSE**: tau x1 up to 50 km/h -> x1.75 at 110 -> x2 at 160 (camera speed), x1.35 at
  the screen edge, x1.25 beyond ~1.5 km. These only hold back *new* refinement; a refined tile
  still coarsens only below 0.7 x base tau, so speed never takes detail off the screen.
- **Budget admission + governor**: a refinement requests its missing children only if their
  estimated size fits the room left by the view set (reserved per pass, parents stay counted
  while their children are drawn); a governor raises tau (up to x3) when the view set passes
  85 % of the room and eases back below 70 %.
- **Base layer**: all 49 L4 roots loaded, never evicted, counted in the budget, kept when it
  fits 35 % of the budget. L4 and L3 textures are halved (linear) at load, before the upload.
  L4 full size = 328 MB (no mips, see below), halved = **104 MB** (measured), so it is on at
  every preset (low: 104 <= 0.35 x 512).
- **Jump priority**: after a teleport (camera > 150 m between selections) the L1 ring around the
  car goes first, coarse to fine, and the look-ahead pauses until 80 m around the car are L1
  (`stats().jump.sharpMs / l4Ms`).
- `prefetchAt(x, z, radius, { level = 1, seconds = 20 })` -> `{ release() }`, also as
  `berlinDrive.stream.prefetchAt`. Teleports are not wired to it: the jump rule above covers them.
- Fades only where a drawn parent/child is replaced (a tile with nothing behind it appears at
  once); no LOD change of a region while its fade runs (3-level dither masks left gaps).
- Hole counter fixed: a refined tile whose children are all outside the frustum counted as a
  hole (its own sphere sticks out past theirs); now only real gaps count. Before/after: 8 -> 0.
- Small items: glTF nodes `matrixAutoUpdate/matrixWorldAutoUpdate = false`; no allocations in
  the selection (reused sets/arrays); fade shader keeps the mood's program cache key; shader
  warm-up via `renderer.compileAsync`; anisotropy per Detail (2 / 4 / 8, new tiles only);
  `serve.py` keep-alive (HTTP/1.1, needs a restart). One draw call per tile (1 mesh, 1
  primitive). three's own frustum culling stays on next to the streamer's (cheap, per camera).
- **Found**: the tiles' sampler is `minFilter LINEAR` - three generates no mipmaps for them,
  so the old 4/3 mip factor in the MB estimate was wrong (all MB numbers above round 1 are ~25 %
  high) and far tiles alias. Tiles are `doubleSided` in the glTF; we draw FrontSide like
  world.glb because camcollide / ground probes raycast them (three's raycast honours side).
- Skipped: far-edge fog (both paths already fade: plain render `THREE.Fog` 1200-4000 m on the
  tile `MeshBasicMaterial`, moods their own gaussian fog + level-edge fade); hidden-tile skipping
  (the chase camera looks down street canyons; a horizon from bounding spheres would hide the far
  end of the street, and SSE already makes those tiles coarse).

**Counters, same 45 s drive as above (headless SwiftShader, Detail normal)**
| | round 1 (re-run today) | round 2 |
|---|---|---|
| downgrade events | 0 | **0** |
| holes | 8 | **0** |
| evictions / re-requested within 10 s | 96 / 33 | **0 / 0** (L3/L4 halved, honest MB) |
| requests issued / cancelled / obsolete dropped before parse or upload | 138 / - / - | 137 / 18 / 15 |
| MB at the end (incl. base) / peak resident + reserved | 1016 / - | 780 / 793 |
| time to the game's "loaded" (headless) | 132 s | 48 s (too early: the start view was still L3 - fixed after the run, `idle()` now also waits for tiles held back by a running fade) |

Jump test (same run, Detail low 512 MB, spawn <-> (900, -600), 4 round trips): MB 504-514
every time, textures 136-138 at the spawn and 149-152 at the far spot (levels off, no climb),
peak resident + reserved 546 MB (in-flight reserve over the budget; eviction now makes room
for the reserve, after the run). 80 m around the car at L1 after 5.2-9.3 s, L4 there for
1.2-1.5 s (spawn) and 3.4-8.4 s (far spot) - SwiftShader tile latency ~2 s; after the run a
jump requests the whole parent chain at once (was: one level per round trip). The speed
factor read up to 1.95 in the headless run (harness steps physics in bursts); it now uses the
car's speed, so the drive counters may be slightly flattered (coarser at times). Not re-run.

## Occlusion: no fine tiles behind buildings (2026-11-21, `js/stream.js`, `build_occluders.py`)
Owner: tiles in the field of view but hidden behind buildings were loaded at full detail.
Now a tile that would refine is first asked "is all of you behind buildings?"; if yes it is
**not refined** - it stays drawn at its own (coarser) level, the L4 base is always under it,
its children are neither requested nor pinned (LRU evicts them when room is needed). A wrong
"hidden" therefore costs sharpness for a moment, never a hole or a wrong picture.

**Data** (`nice -n 19 python3 build_occluders.py --name mitte_all`, ~5 min, reads the local mesh
mirror + `buildings.bin`; writes `levels/mitte_all/occlusion.json` + `occlusion.bin`, gzip):
- *Occluder grid*, 4 m cells, uint8 height. A cell is an occluder only if all of it is OSM
  building (the `buildings.bin` mask with its 2 m buffer eroded away; that mask already has
  bridges, the Stadtbahn viaduct, station sheds, roofs/canopies over the street and passages
  cut out; trees are never in it) and the mesh covers all of it at every LOD L1..L4. Its
  height is the **lowest** mesh surface point in the cell over all four LODs (1 m raster) minus
  1 m, rounded down - whichever LOD is drawn there, the occluder is never taller than the
  drawn building. An OSM footprint offset onto the street gets street height (useless, safe).
- *Tile tops*: for each tile that can refine (L2-L4, 814), an 8 x 8 grid over the x/z box of
  all its content (own + every descendant down to L1); per grid cell the highest point of any
  triangle touching it + 0.5 m. Tall buildings sticking out behind lower ones are thus seen.

**Test** (per refine candidate, inside the existing 100 ms selection pass): around each eye
the circle is cut into 360 wedges of 1 deg, each marched lazily along its centre line, one
sample per 4 m cell, up to 500 m; it keeps the running maximum elevation
`(occluder top - eye height) / distance`. The occluder top used at a sample is the *lowest*
one within the wedge's half width around it (the grid min-filtered 3 x 3, beyond ~460 m 5 x 5),
so every sight line inside the wedge passes a column at least that high there: **no gaps
between rays**, a narrow alley between two buildings simply is no occluder. A content box is
hidden from an eye when, in every wedge its azimuth span touches, that running maximum
*before the box's nearest point* is above the box's highest elevation (top over its nearest
distance; over its farthest when the top is below the eye). Boxes are a quadtree over the 8 x 8
tile tops (whole tile, quarters, ... single cells), each at the highest top below it: a hidden
quarter settles 16 cells in one test, a visible tile stops at the first visible cell (the
side facing the eye goes first). Because the horizon is per wedge, the far end of a street
canyon stays visible along the street (the reason the round-2 notes skipped a sphere-based
horizon).
- The verdict must hold from the **camera and four eyes ahead**: the camera pose 0.75 / 1.5 /
  2.25 / 3 s ahead (`OCC_LEADS`, same prediction as the look-ahead cameras, which are the 1.5
  and 3 s ones; only while they run, > 2 m/s). ~10 m apart at 50 km/h, so a cross street the
  camera passes between two of them is still seen in time; what the car will see in the
  next 3 s is loaded.
- **Never hidden**: a tile whose culling sphere comes within `RING_R` (120 m) of the car
  while the ring runs (< 90 km/h or after a jump), or any box within `OCC_NEAR` (20 m) of an eye.
- **Hysteresis**: a tile counts as hidden only if it has not been seen (raw verdict visible)
  for `OCC_HOLD` = 1000 ms; one visible verdict refines it again at once. A tile that has
  never been seen is hidden from its first verdict (driving into a view it was never in).
- **Cost cap**: a verdict is reused for `OCC_STALE` = 300 ms (its eyes reach 3 s ahead); older
  ones are recomputed while the pass's work budget lasts (`OCC_WORK` = 6000 units = ray
  samples + 20 per box test, ~0.4 ms here), then reused up to `OCC_OLD` = 1000 ms; older than
  that and over budget = no verdict this pass (`skipped`: the tile refines as without the
  step). A teleport / `setOcclusion()` voids all verdicts.
- A refined tile that becomes hidden coarsens (its children fade out; invisible behind the
  buildings). Such a swap counts as `events.occDowngrade`, not `downgrade`, so the
  "downgrade = 0" check stays meaningful.
- Look-ahead (`ahead()`) skips the children of a hidden tile too; ring, prefetchAt regions,
  the base layer and jump priority are untouched.

| constant | value | where |
|---|---|---|
| `OCC_RAYS` / sample step / `OCC_RANGE` | 360 wedges (1 deg) / one grid cell (4 m) / 500 m | `js/stream.js` |
| `OCC_NEAR` | 20 m | `js/stream.js` |
| `OCC_LEADS` | 0.75, 1.5, 2.25, 3 s | `js/stream.js` |
| `OCC_HOLD` | 1000 ms | `js/stream.js` |
| `OCC_WORK` / `OCC_STALE` / `OCC_OLD` | 6000 units / 300 ms / 1000 ms | `js/stream.js` |
| ray stop height | 99th percentile of all tile tops (106.5 m frame Y): a wedge stops early once nothing up to it could look over its horizon; the horizon then stays constant - only less hiding | `makeOcclusion` |
| `CELL` / `RASTER` / `MARGIN` | 4 m / 1 m / 1 m | `build_occluders.py` |
| `G` / `TOP_MARGIN` | 8 x 8 / 0.5 m | `build_occluders.py` |

Built (2026-11-21): 214,369 of 1,136,090 cells are occluders (18.9 %; the unbuffered OSM
footprints cover ~26 %), height p10 / 50 / 90 = 41.6 / 56.7 / 69.6 m frame Y (street ~36);
`occlusion.bin` 264 kB gzip, `occlusion.json` 32 kB. Not covered: occluder heights are
sampled at 1 m (a notch narrower than that in a roof is not seen); a sight line under a
building through a passage that OSM does not tag is treated as blocked. Data without
`occlusion.json` = no occlusion (console info).

**Switch**: `berlinDrive.stream.setOcclusion(false)` (saved as localStorage
`berlinDrive.occlusion` = `'0'`; `true` / removing the key = on, the default).
`berlinDrive.stream.occlusion` reads it. The Detail dropdown (`#detailSel`, `index.html`
stream block) would be the natural place for an on/off entry; not added.
**Numbers**: `berlinDrive.stream.stats().occlusion` = `{ available, on, eyes, kept` (tiles kept
from refining in the last pass), `keptTotal` (sum over all passes), `coarsened` /
`coarsenedTotal` (refined tiles collapsed because hidden), `aheadKept` (look-ahead
refinements skipped), `tested / reused / skipped / hidden` (verdicts last pass), `work /
workMax` (budget units), `ms / msAvg / msMax` (verdict time per pass), `rays }`.

**Offline estimate** (`node tools/occlusion_replay.mjs`: the occlusion core of `js/stream.js`
verbatim, the selection re-implemented without hysteresis / governor / budget; window 950 px
high, fov 35, tau 24; camera behind the car looking at it, no camera collision). "Loaded" =
view set + all children of refining tiles + look-ahead + ring + base (incl. the 104 MB L4
base); MB = GPU bytes as `stats()` counts them.

| camera (height / distance) | Friedrichstr. at Franzoesische Str., north | Friedrichstr. at Leipziger, north | Unter den Linden, east |
|---|---|---|---|
| 60 / 60, standing | 0 tiles saved (of 128 loaded, 415 MB) | 0 | 0 |
| 30 / 50, standing | 0 | 0 | 0 |
| 8 / 15, standing | **19 tiles, 77 of 456 MB** | **21 tiles, 77 of 505 MB** | 4 tiles, 17 of 516 MB |
| 60 / 60, 50 km/h | 0 | 0 | 0 |
| 30 / 50, 50 km/h | 0 | 0 | 0 |
| 8 / 15, 50 km/h | **19 tiles, 77 of 481 MB** | **21 tiles, 77 of 544 MB** | 9 tiles, 42 of 569 MB |

At the owner's cameras (60/60, 30/50) the step hides nothing in these places: from 30 m up
the eye looks over the eaves (~20 m) to the far tiles, and everything nearer is inside the
120 m ring anyway. With a street-level camera, the L3/L4 tiles beside the street behind the
block rows stay coarse (their L2/L3 children are not loaded); Unter den Linden is wide and
its sides open, so little is hidden. CPU per pass of full verdicts (this laptop, with a
pit scan on both cores): 0.1-0.35 ms at 60/60 and 30/50, 0.3-0.35 ms low and standing,
0.8-1.6 ms low at 50 km/h (5 eyes) - which the work budget spreads over passes.


## Smoother streaming - options (not implemented)
| option | gain | cost | disk |
|---|---|---|---|
| **KTX2 / Basis + meshopt re-encode** (plan below) | GPU per texture 8 MB -> 1 MB (ETC1S -> BC1/ETC2) or 2 MB (UASTC -> BC7), with mips; no JPEG decode, upload is a copy | one-off encode, `toktx` + `gltf-transform` | see plan |
| per-level texture audit + offline downsampling | L4/L3 are now halved at load (no disk change); the same offline (`gltf-transform resize`) also saves fetch + decode, and L2 could follow if the audit shows its texels are only seen at deep mips. Halving = -75 % texture memory | minutes, same tools | smaller |
| strip unused attributes + quantise (in the re-encode) | tiles carry POSITION + TEXCOORD_0 only (already minimal); `gltf-transform quantize` (16-bit positions, 12-bit UVs) halves geometry on the GPU too | part of the re-encode | smaller |
| tighter culling volumes (boxes for flat tiles) | fewer false-visible tiles at the screen edge and behind the camera | tiles.json carries spheres only; build_stream.py would add the 3D Tiles `box` | none |
| adaptive render resolution | pixel ratio (capped at 1.5 in index.html) lowered while frame time is high | small governor in the render loop; owner's call on softness | none |
| worker-side b3dm parsing | main-thread parse time off | only if a trace shows parse time (JPEG decode is already off-thread) | none |
| three >= 0.167 + `3d-tiles-renderer` | mature LRU, priority queue, worker parsing, KTX2/meshopt plugins | re-test every custom shader (mood grade/fog, ice, ghost, bloom/Output, camcollide); est. 1-2 days + a play-test round | none |

### KTX2 + meshopt re-encode - ready-to-run plan (owner approves; nothing installed yet)
1. **Install** (user space, no root): KTX-Software 4.3.x release `.deb` or tarball from
   https://github.com/KhronosGroup/KTX-Software/releases (`toktx` on PATH, e.g. unpack to
   `~/.local/opt/ktx` and link `toktx` into `~/.local/bin`); `npm i -g @gltf-transform/cli@4`
   (Node 22 is installed).
2. **Which tiles**: exactly the 3,470 in `levels/mitte_all/tiles.json` (2.0 GB of b3dm:
   L1 1.46 GB, L2 0.29, L3 0.19, L4 0.05). `optimize_tiles.py` walks a whole folder, so first a
   symlink tree of just these: `python3 -c "import json,os; R='berlin_mesh_2025_wab/'; O='berlin_mesh_2025_wab_mitte/'; [ (os.makedirs(os.path.dirname(O+t[0]),exist_ok=True), os.path.exists(O+t[0]) or os.symlink(os.path.abspath(R+t[0]), O+t[0])) for t in json.load(open('racing/levels/mitte_all/tiles.json'))['tiles'] ]"`
3. **Encode** (repo root): `python3 optimize_tiles.py --src berlin_mesh_2025_wab_mitte --out berlin_mesh_2025_wab_mitte_opt --textures ktx2 --compress meshopt --workers 4`
   (gltf-transform `optimize` with ETC1S by default; try `--limit 20` first and compare a few
   tiles against the JPEGs; if photos smear, UASTC via `gltf-transform uastc --level 2 --zstd 18`).
   Optionally `gltf-transform resize --width 1024 --height 1024` for L4/L3 in the same pass.
4. **Disk / time**: only **~4.1 GB free** now (was 7.6). ETC1S + meshopt ~1.2-1.8 GB output ->
   fits; UASTC + zstd ~3-4 GB -> does not fit safely, so ETC1S first. ETC1S encoding is slow:
   ~2-6 s per 2048x1024 texture per core -> 3,470 tiles on 4 workers ~1-1.5 h (UASTC faster).
5. **Loader** (stream.js, ~15 lines): `KTX2Loader` from `three/addons/loaders/KTX2Loader.js`,
   `.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/')
   .detectSupport(renderer)`, `loader.setKTX2Loader(ktx2)`; `MeshoptDecoder` from
   `three/addons/libs/meshopt_decoder.module.js`, `loader.setMeshoptDecoder(MeshoptDecoder)`.
   MB estimate from the compressed mip chain (`map.mipmaps[i].data.byteLength`); the load-time
   downscale already skips compressed textures. `serve.py` gets a second root (`/tiles_opt/`)
   and `tiles.json` `base` (or a `?tiles=opt` flag) picks it.
6. **Gain**: L1 tile ~6.1 MB -> ~2-2.5 MB GPU (texture 4-8 MB -> 0.7-1.4 MB with mips, geometry
   unchanged unless quantised): the normal budget holds ~2.5x the tiles, the base layer could stay
   full size, Detail "high" becomes the sensible default; JPEG decode and the remaining upload
   hitches go. Delete nothing of the raw mirror; the opt dir is extra.

# AGENTS.md

For people and coding agents working on Driving Berlin. The visitor-facing page is `README.md`;
this file is the map of the code, the rules and the procedures. Code comments that say
"README Rules" mean the section [Rules of the house](#rules-of-the-house) below.

## 1. The project in brief

- A browser driving game on Berlin's photogrammetric 3D mesh (*3D-Meshmodell Berlin 2025*). One
  level, `mitte_all`: Ortsteil Mitte, bbox `13.3640 52.5040 13.4290 52.5410`, 4.4 x 4.1 km.
- three.js r160 (import map, jsDelivr CDN), Box2D (box2dweb, `Box2D.js`, global `Box2D`), no
  build step, no packages: `index.html` (one large inline module) plus `js/*.js`.
- The mesh is never merged: `js/stream.js` streams the 3D Tiles (`.b3dm`, L1 finest ... L4 roots).
  Collision, heights and everything else come from level files in `levels/mitte_all/`, built
  offline by the `build_*.py` scripts from the mesh, OpenStreetMap and two Berlin WFS datasets.
- Live: GitHub Pages (`gh-pages` branch) for the code and level files; the tiles are the Hugging
  Face dataset `driving-berlin-tiles`.
- This folder is its own git repository, nested in (and ignored by) the parent mesh project. Build
  scripts import `merge_tiles`, `merge_hybrid`, `osm_semantic` (and `build_level.py` also
  `merge_lod2`) from the parent folder and read the mesh mirror `../berlin_mesh_2025_wab/`. Keep
  the folder there.

**Level frame.** ENU metres around the level origin (`level.json` `origin`, the bbox centre):
three.js X = east, Y = up, Z = −north; Box2D (x, y) = three.js (X, Z). **Heading** is a bearing:
0 = north, clockwise positive, forward = (sin h, −cos h). Speeds in the UI are km/h; everything
else is metres and seconds. The exact lon/lat ↔ frame transform is in `build_level.py` (and mirrored
in `js/nodrive.js`, `js/balloon.js`); never approximate it.

## 2. Rules of the house

- **Quiet game.** No on-screen messages while driving: no toasts, popups, hints, prompts, status
  lines. Feedback is the world itself (confetti, the bear, the counter). Allowed: controls and
  readouts (speed, street name, the round map), objects in the world, the loading screen, the
  menu and the map. Two deliberate text exceptions:
  - the street-name plate when the car has turned onto a new street, rarely (`js/areasign.js`);
  - one calm line, "Respect is Everything.", when the car enters the Holocaust memorial's
    no-drive zone (`js/respect.js`, at most once per 20 s).
  Add a quiet substitute only where the player would otherwise be stuck.
- **Settings belong in the menu** (Einstellungen) and are remembered in `localStorage`. URL
  parameters are a fallback for testing, not the main way.
- **Obstacles start off** on every load (`setCollision(false)` in `index.html`); the switch lasts
  for the session.
- **Camera standards:** Standard view height 50 / distance 90 on the street and on the S-Bahn
  tracks; Horizont 12 / 34, look point 8 m up. The car always stays in the central 75 % of the
  picture. Only buildings move the camera, never trees, poles or anything over the car.
- **The car is stopped only by what the player can see at car height** (walls, visible
  obstacles). Check with `audit_roads.py` after changing walls or clutter.
- **Nothing playful within 100 m of a memorial site** (`build_eggs.py` checks this).
- **Privacy:** no personal paths (`/home/<user>/`), scratch paths or mail addresses in committed
  or published files. `tools/check.mjs` scans what git would commit; `tools/publish_site.py`
  refuses to stage such text.
- **Never write the local OSM extract's path into a file.** Scripts take `--pbf` or the env var
  `OSM_PBF`.
- **Be gentle with third-party servers:** no new public Overpass requests. The two existing ones
  (`build_map.py` → `osm_map.json`, `build_stream.py` → `osm_water.json`) are cached and reused;
  anything new reads the local OSM extract. WFS requests are cached and made once; requests are
  sequential and modest.
- **No new dependencies without reason.** Build scripts use numpy, scipy, matplotlib (`path`),
  contourpy and the osmium CLI; `serve.py` and `tools/*.py` are stdlib only; the browser side has
  no packages (three.js from the CDN); the test suite uses Node's own fetch and WebSocket.
- **Level data stays out of git** (`levels/` is ignored, as are `site/` and `driving-berlin-tiles/`).
- **Testing:** new features get syntax checks plus `tools/test.sh`; a bug fix gets the one
  measurement that proves it, and a regression case in `tools/drive_cases.json`.
- **Publish only after `tools/test.sh` exits 0.**
- **Commits and pushes only on the owner's word.**

## 3. Map of the code

### Page and runtime modules

`index.html` holds the renderer, the Box2D world, the car, the chase camera, the HUD, the
sequences (rescue, pits, doors, lifts), the key handling and `window.berlinDrive` (the console /
test API). The modules:

| Module | What it does | On `window.berlinDrive` |
|---|---|---|
| `js/vehicle.js` | Vehicle model: Box2D chassis + four wheel bodies, tyre forces, speed governor, parking hold, impact response (`SOLID`, `IMPACT`, `HOLD`) | `vehicle`, `speedLimit` |
| `js/stream.js` | Tile streamer: selection by screen-space error, budget, base layer, look-ahead, cross-fades, occlusion step, start rule | `stream` |
| `js/ground.js` | Car on the mesh road: wheel probes into the drawn tiles, the smooth ride layer | `carGround`, `ride` |
| `js/camcollide.js` | Camera collision: shortens / lifts the boom when buildings hide the car | `setCamAvoid()` |
| `js/walls.js` | Building walls (`walls.bin`): Box2D fixtures only in the cells around the car; `inside`, `hits` | `walls` |
| `js/clutter.js` | Tree trunks + mesh street obstacles (`clutter.bin`), switchable | `clutter` |
| `js/bridges.js` | Bridge decks over water: deck height, rails near the car | `bridges` |
| `js/tunnels.js` | Road tunnels: guided ramps, tunnel mode, tube outline drawn through the ground | `tunnels` |
| `js/sbahn.js` | S-Bahn: station doors, rails mode on the viaduct deck, bail-outs, the garage portal | `sbahn` |
| `js/roofs.js` | Roof mode on the Bundestag roof route, lift ride, falls and checkpoints | `roofs` |
| `js/liftpad.js` | Shared look of lift slabs and the green door beacon | — |
| `js/nodrive.js` | No-drive zones (lon/lat outlines; now the Holocaust memorial) | `noDrive` |
| `js/respect.js` | The "Respect is Everything." line | `respectLine` |
| `js/edge.js` | Level border: glass wall, cushion, turn-around (U) | `edge`, `edgeModule`, `turnAround()` |
| `js/bordershimmer.js` | Light wave along the border near the car | `borderShimmer` |
| `js/eggs.js` | Bears, football pitches, goals, balls; loads `js/doorway.js` | `eggs` |
| `js/doorway.js` | Figures and props from `doorway.json` (garden, hint frame, photo group, hidden extras) | via `eggs` |
| `js/sights.js` | Debt clock, stork's nest, Berlinale carpet | — |
| `js/balloon.js` | Weltballon: cycle, ride (E), hidden cable cut | `balloon` |
| `js/doves.js` | Ambient pair of doves every few minutes | `doves` |
| `js/dust.js` | Dust puffs at the rear wheels | `dust` |
| `js/skid.js` | Skid marks | `skid` |
| `js/mood.js` | Moods day / moon / snow (grade, sky, fog, bloom, snow); only with `?mood=` | `mood` |
| `js/sky.js` | Photographed sky dome and the sky light on the car | `sky` |
| `js/minimap.js` | Round HUD map, street-name lookup, full-screen overview map | `minimap` |
| `js/areasign.js` | Street-name plate; shared plate / place-name sign CSS and font | `areaSign` |
| `js/loading.js` | Loading screen (the way into the game) | `intro`, `loading` |
| `js/menu.js` | Esc menu: pages, slow motion into the pause | `menu`, `paused` |
| `js/intro.js` | Shared help texts: key list, ways to play, `DATASETS` / `SOFTWARE` credits | — |
| `js/touch.js` | Touch controls; they dispatch the same key events as the keyboard | — |
| `js/site.js` | Optional `site.json` of the published copy: tile URL, gzipped `.bin` | — |

Other useful API members: `state()`, `steps(n, keys)`, `simulate(s, keys)`, `teleport(x, z, h)`,
`spot(slug)`, `spots()`, `jump()`, `setView()` / `view` / `viewInUse`, `setBlinkers()`,
`setCollision()`, `showDebug()`, `newGame()`, `resetSettings()`, `mapDrive`. Key F toggles the
debug overlay (walls, trunks, obstacles, pits).

Other files: `map.html` (developer tool page: level border, spots, live position and "drive here"
over a `BroadcastChannel`; not published), `serve.py` (no-cache dev server, `/tiles/` from
`../berlin_mesh_2025_wab/` with CORS), `models/Car.glb`, `models/Bus.glb`, `assets/fonts/`,
`assets/sky/sky.webp`.

### Build scripts

All write into `levels/<name>/` (default / usual `--name mitte_all`; `build_eggs.py`,
`build_sights.py`, `build_spots.py` take `--level`). "Mesh" = the L1/L2 tiles in
`../berlin_mesh_2025_wab/`; "PBF" = a local OSM extract via `--pbf` / `OSM_PBF` (osmium CLI).

| Script | Output | Needs | Cost |
|---|---|---|---|
| `build_level.py` | library for the others (`raster_top`, `obstacle_layer`, `pit_layer`, `road_mask`, `osm_water`, `car_band`, frame maths); its own CLI built the retired small level | — | — |
| `build_stream.py` | `tiles.json`, `height.bin`, `water.bin`, `level.json` (keeps its `pit` block) | mesh, one cached Overpass query (`osm_water.json`) | ~6 min |
| `build_map.py` | `map.json` (minimap, street names) | one cached Overpass query (`osm_map.json`) | ~1 min |
| `build_buildings.py` | `buildings.bin/.json` (camera mask, clutter mask) | PBF | light |
| `build_occluders.py` | `occlusion.json/.bin` (streamer occlusion) | mesh, after `build_stream` + `build_buildings` | ~5 min, `nice` |
| `build_eggs.py` | `eggs.json`, `doorway.json` | `map.json` (+ `walls.bin` for checks) | seconds |
| `build_sbahn.py` | `sbahn.json`; `--carve-doors` edits `walls.bin` in place | mesh, `osm_map.json`; `--footprints` needs PBF | ~3 min; `--bailouts-only` ~3.5 min, ~4 GB |
| `build_tunnels.py` | `tunnels.json` | mesh, `osm_map.json`, height/water | 2–6 min, `nice` |
| `build_bridges.py` | `bridges.json` | mesh, `osm_water.json`, `water.bin` | ~6 min, `nice` |
| `build_walls.py` | `walls.bin/.json` (keeps bears, pitches, doors reachable) | PBF, `sbahn.json`, `eggs.json` | ~5 min, **~4 GB RAM** |
| `build_clutter.py` | `clutter.bin/.json` (resumable chunks in `clutter_chunks/`) | mesh, `buildings.bin`, cached WFS (`trees_wfs.json`, `roads_wfs.json`) | ~55 min with 2 workers, ~0.7 GB each |
| `build_pits.py` | `pit.bin`, `pit_floor.bin`, `level.json` `pit`; `--scan` → `pit_scan.json` (review only) | mesh, `walls.bin` | `--at` ~30 s; `--scan-full` hours |
| `build_areas.py` | `areas.json` (Ortsteile for loading screen and menu) | PBF, `map.json` | ~25 s |
| `build_roofs.py` | `roofs_deck.json/.bin` | mesh | ~30 s, `--check` ~5 min |
| `build_sights.py` | `sights.json` | PBF, mesh | light |
| `build_spots.py` | `spots.json` (`?spot=` starts, every pose checked; exit 1 on a failed check) | all of the above, mesh | minutes |
| `audit_roads.py` | `road_audit.txt/.json`: blocked places on drivable roads; `--heads-only` checks bridge heads in seconds | `osm_map.json`, walls, clutter, bridges, tunnels, mesh | heavy without `--heads-only` |
| `find_roofs.py` | `roofs.json` (review list of roof routes; the answer is `ROOF_ROUTES.md`) | mesh, PBF | 20–40 min |

### tools/

| File | Purpose |
|---|---|
| `test.sh` → `test.mjs` | the whole suite, one table, exit 0 = passed |
| `check.mjs` | layer 1: static checks (syntax, imports, Python compile, car bench, bridge heads, S-Bahn doors, publish staging, privacy) |
| `smoke.mjs` | layer 2: one headless start-up |
| `drive_tests.mjs`, `drive_cases.json` | layer 3: drive and settings tests and their data (known failures with reasons) |
| `testlib.mjs` | shared: result table, flags, headless Chrome over DevTools |
| `vehicle_bench.mjs`, `vehicle_ref.json` | vehicle bench in pure Node, reference numbers |
| `occlusion_replay.mjs` | offline replay of the streamer's occlusion step |
| `publish_site.py` | stage the public site into `site/` |
| `stage_tiles.py` | stage the tiles for the Hugging Face dataset |
| `count_wab_tiles.py` | count mirror tiles per LOD inside a lon/lat box |

## 4. How it fits together at run time

**Start-up and loading screen** (`js/loading.js`). The page opens on the loading screen with the
game view blurred behind it; pause reason `load` holds physics and keys. Phase 1 (0–30 %) loads
the level files; phase 2 waits for `stream.ready()`, the **coarse-ready start rule**
(`START_RULE` in `js/stream.js`: no hole in view; within 120 m nothing coarser than L2, L3 beyond;
within 12 m of the car the final level with no cross-fade running, so a standing car is never
re-seated). Until then the streamer loads only that, plus the base-layer roots within 300 m.
Then the screen fades and the car drives at once; the city keeps sharpening. Safety net: after
60 s it starts anyway. Start pose order: mood-switch resume (`sessionStorage
berlinDrive.resume`), `?spot=`, `?at=lat,lon,bearing`, the level spawn.

**Tile streamer** (`js/stream.js`). Levels L1 (finest) to L4 (49 roots). Every 100 ms a tile
refines when its screen-space error exceeds `tau` (24 px, coarser at speed, at the screen edge,
far away and near the budget) and all its children are loaded (REPLACE, no partial states;
350 ms dither cross-fade). The 49 L4 roots stay loaded as the base layer (L3/L4 textures halved).
Look-ahead with the camera predicted 1.5 s and 3 s ahead, L1 within 120 m of the car, LRU
eviction over the GPU budget. Detail setting: low / normal / high = 512 / 1024 / 1536 MB, tau
32 / 24 / 18 (phones: a quarter budget). Occlusion step: tiles hidden behind buildings are not
refined (`occlusion.json`). The Horizont view adds a refine cap (L2→L1 within 350 m, L3→L2 900 m,
L4→L3 1600 m). Details: `MITTE_STREAMING_PLAN.md`.

**Ground and ride layer** (`js/ground.js`). Four wheel probes into the drawn mesh find the road;
the car rides a smoothed plane fitted to a probe grid, so lumps and potholes drop out. The height
grid (`height.bin`) is only the fallback where tiles have not arrived. The order of height
sources: **roof → tunnel → S-Bahn → bridge deck → ice (snow mood) → mesh probes → height grid**
(`carGround` in `index.html`).

**Collision sources.** Building walls (`js/walls.js`, always on); trunks and street obstacles
(`js/clutter.js`, the Obstacles switch); bridge rails (`js/bridges.js`, only at deck level);
tunnel walls (`js/tunnels.js`); roof boxes (`js/roofs.js`, roof mode only); the level border
(Box2D border + `js/edge.js` cushion). Not colliders but sequences: water and pits (the car
sinks / falls, the Rescue Bear lifts it out) and the no-drive zone (the bear lifts it back to the
street). A car truly enclosed in a footprint for 1.5 s hops to the nearest free spot.

**Guided modes.** Each switches off the street colliders it would conflict with:
- *roof mode*: only roof boxes collide; off the deck edge the car falls and the bear sets it
  back at the roof's start (`FALL_TO` in `js/roofs.js`); uses the Horizont view whatever the setting (temporary override, `viewInUse`);
- *tunnel mode*: entered through a portal face inward, profile replaces the mesh, only tunnel
  walls collide, the car shows as a ghost silhouette;
- *S-Bahn rails mode*: on the viaduct deck, corridor walls only; `G` / the on-screen button calls
  the bear to the nearest street bail-out;
- *bridge decks*: active only while the car is at deck level.
R, teleport and the map drop all modes; a mood switch keeps them.

**Sequences and pause.** Scripted moments are `sinking.kind` values: `water`, `pit`, `nodrive`,
`sbahn`, `sbahnOut`, `roofUp`, `roofDown`, `roofFall`. Pause is a set of reasons, `pauseBy`
(`load`, `menu`, `map`); with any reason set no game key works, and when the last one is released
the frame clock restarts (no big dt). Opening the menu eases game time 1 → 0 over 0.35 s while
the canvas blurs (`MENU_FX` in `js/menu.js`; reduced motion = instant). Every module's
`update(dt)` gets the scaled dt.

**Views.** Standard (50 / 90, no sky in frame) and Horizont (low camera with sky; scene fog
becomes sky haze; refine cap). Each view keeps its own slider sets for street and tracks:
`berlinDrive.cam7.*`, `berlinDrive.cam7.sbahn.*`, `berlinDrive.cam7.horizon.*`,
`berlinDrive.cam7.sbahn.horizon.*`. V toggles head-up / north-up.

**Moods** (`?mood=day|moon|snow`, menu "Stimmung", reloads the page with the car kept). The mesh
has noon light baked in, so moods are a colour grade in the mesh shader, a sky, fog and bloom.
Without `?mood=` none of `js/mood.js` runs; plain daylight and the day mood use the photographed
sky (`js/sky.js`).

**HUD and map.** While driving: the round map with speed and street name, the street plate when
it appears, the credit line, the S-Bahn button on the tracks, touch controls on touch devices.
N opens the full-screen overview (paused); it shows streets and the car only, no bears or hints.
Of the minimap marker groups only the green S-Bahn door dots are drawn.

**Settings storage** (`localStorage`). Progress keys (cleared by "Neustart" / `newGame()`):
`berlinDrive.eggs.found`, `berlinDrive.balloon.cut`, `berlinDrive.pos` (plus `sessionStorage
berlinDrive.resume`). Every other `berlinDrive.*` key is a setting (removed by "Auf Standard
zurücksetzen" / `resetSettings()`): `vehicle`, `speedLimit`, `detail`, `view`, `cam7.*`,
`blinkers`, `camAvoid`, `collision` (written, but obstacles still start off), `occlusion`,
`minimap`, `minimapZoom`, `eggs.hints`, `doves`, `dust`, `skid`, `shimmer`. `berlinDrive.cmd` is
the map.html teleport channel fallback; `sessionStorage berlinDrive.reopen` reopens the settings
page after a reset.

**URL parameters** (testing; not saved): `?spot=`, `?at=`, `?mood=`, `?maxspeed=`, `?height=`,
`?distance=`, `?zoomout=`, `?skycam=1`, `?northup=1`, `?camcollide=0|1`, `?tilebudget=`,
`?handling=arcade|classic`, `?power=`, `?carscale=`, `?msaa=0`.

## 5. Easter eggs and sights (maintainers only)

Bears, pitches and goals come from `build_eggs.py` (`BEARS`, `PITCHES`) → `eggs.json`; spot links
from `build_spots.py` (`SPOTS`) → `spots.json` (`?spot=<slug>`, the car starts a short drive
before the spot). **Items marked hidden are not to be advertised** anywhere public (README, menu,
map, spot lists for players).

| What | Code / data | Spot slug(s) |
|---|---|---|
| 19 bears (one on the Bundestag roof, found only in roof mode) | `js/eggs.js`, `eggs.json` | `baer-*` (e.g. `baer-paula`, `baer-lotte`) |
| Football: 4 pitches, goals, oversized balls | `js/eggs.js`, `eggs.json` | `fussball-*` |
| S-Bahn: a door at each of five stations, rails mode, deck stops, bail-outs | `js/sbahn.js`, `sbahn.json` (`entrances`, `lifts`, `bailouts`) | `sbahn`, `sbahn-alexanderplatz`, `sbahn-hackescher-markt`, `sbahn-friedrichstrasse`, `sbahn-hauptbahnhof` |
| Bundestag roof route with the lift slab | `js/roofs.js`, `roofs_deck.json/.bin` | `bundestag-dach` |
| Road tunnels (Tiergarten Spreebogen, Alexanderplatz) | `js/tunnels.js`, `tunnels.json` | `tunnel-tiergarten-nord`, `tunnel-tiergarten-sued`, `tunnel-alexanderplatz` |
| Bridges, incl. the Gustav-Heinemann footbridge | `js/bridges.js`, `bridges.json` | `heinemann-bruecke` |
| Construction pits | `level.json` `pit`, `pit.bin` | `baugrube-wilhelmstrasse`, `baugrube-elisabeth-selbert-haus` |
| Holocaust memorial (no-drive zone) | `js/nodrive.js`, `js/respect.js` | `mahnmal` |
| Weltballon and the ride (E) | `js/balloon.js` | `weltballon` |
| Debt clock, stork's nest, Berlinale carpet | `js/sights.js`, `sights.json` (`build_sights.py`: `CLOCK_NUMBERS`, `NEST`, `BERLINALE`) | `schuldenuhr`, `nabu`, `berlinale` |
| Garden at Albrechtstraße: doorway figure, fountain, bear Lola | `js/doorway.js`, `doorway.json` (`DOORWAYS`, `FOUNTAINS`) | `lola`, `baer-lola` |
| Checkpoint Charlie photo group | `doorway.json` (`PHOTO_GROUPS`) | `checkpoint` |
| Hidden: green hint frame of a passage to a bear | `doorway.json` (`HINTS`) | `baer-maura` |
| Hidden: Tiefgarage Am Friedrichshain → S-Bahn deck | `sbahn.json` `portal` (`PORTAL`, `--portal-only`) | `tiefgarage` |
| Hidden: cutting the Weltballon's cable (permanent, `berlinDrive.balloon.cut`) | `js/balloon.js` | — |
| Hidden: driving on the full-screen map (a driving key on the open map) | `index.html` `startMapDrive`, `js/minimap.js` | — |
| Hidden: "Runter von den Gleisen" (G) is not listed in the menu | `js/sbahn.js` | — |

To add a spot: one row in `SPOTS` in `build_spots.py`, then `python3 build_spots.py --only <slug>`.
Re-run `build_spots.py` whenever `walls.bin`, `clutter.bin` or `eggs.json` change.

## 6. Building the level data

Order for a full rebuild (all local except the cached Overpass and WFS requests; `--pbf FILE`
or `OSM_PBF` where marked):

```bash
python3 build_stream.py --name mitte_all --bbox 13.3640 52.5040 13.4290 52.5410
python3 build_map.py
python3 build_buildings.py --name mitte_all                        # PBF
nice -n 19 python3 build_occluders.py --name mitte_all
python3 build_eggs.py
python3 build_sbahn.py --name mitte_all
nice -n 19 python3 build_tunnels.py --name mitte_all
nice -n 19 python3 build_bridges.py --name mitte_all
python3 build_walls.py --name mitte_all                            # PBF, ~4 GB RAM
nice python3 build_clutter.py --name mitte_all
python3 build_pits.py --name mitte_all --at LON LAT                # one per pit
python3 build_areas.py --name mitte_all                            # PBF
nice -n 19 python3 build_roofs.py --name mitte_all --work DIR
python3 build_sights.py                                            # PBF
python3 build_spots.py                                             # last: checks every start
```

Light ways to rebuild one thing:
- `build_sbahn.py --doors-only [--only <door id>] [--dry-run]`, `--check-doors`, `--carve-doors`,
  `--bailouts-only`, `--portal-only`, `--lifts-only`;
- `build_spots.py --only <slug>`, `--dry-run`; `build_roofs.py --only bundestag`;
- `build_clutter.py --area X0 Z0 X1 Z1`; `build_pits.py --at LON LAT` adds one pit window;
- `audit_roads.py --heads-only` (bridge heads only, seconds).

Learnt the hard way:
- **Whole-level OSM work needs about 4 GB RAM** and gets killed on a small machine. Cut a small
  box out of the extract with osmium first, and close other heavy jobs.
- **Back up binary files before in-place edits** (`--carve-doors` writes into `walls.bin`): copy
  them aside (`*.pre-<reason>`) first.
- After `tiles.json` changes, re-run `build_occluders.py` (tile indices refer to its order).
- The mesh portal has been down; build only from the local mirror `../berlin_mesh_2025_wab/`.
- Delete `osm_map.json` / `osm_water.json` only when fresh OSM data is really needed (it means a
  new public Overpass request).

## 7. Testing

Run the server, then the suite:

```bash
python3 serve.py 8765
tools/test.sh                                         # everything, ~5 min, exit 0 = passed
tools/test.sh --list                                  # test names
tools/test.sh --only drive.bridge --only static.imports
tools/test.sh --slow                                  # also build_spots.py --dry-run (needs the mesh)
tools/test.sh --url http://127.0.0.1:8771/ --port 9370
```

Three layers: (1) `tools/check.mjs`, static, ~30–40 s, no browser; (2) `tools/smoke.mjs`, one
headless Chrome start-up: loading screen ends, no uncaught error, every module present on
`window.berlinDrive`, menu and map pause; (3) `tools/drive_tests.mjs`: every spot drives off, both
heads of the Monbijou bridges, each S-Bahn door, the roof fall, the border, the memorial line,
coast-down, map driving, default settings on a fresh profile, `newGame()` / `resetSettings()`.

- **KNOWN**: a failure listed with its reason in `tools/drive_cases.json` (`static` or `drive`)
  is shown as `KNOWN` and does not fail the run (today: six wall-contact values of the car bench,
  the accepted differences of the current car model; `tools/vehicle_ref.json` describes the
  previous one).
- **A fixed bug becomes a case** in `tools/drive_cases.json`, with its reason, so it cannot break
  twice. Positions come from the level files wherever they exist.
- **Headless facts:** the test machine renders in software (SwiftShader), so a rendered frame
  takes seconds. Drive with `berlinDrive.steps(n, keys)` + `state()` (physics without rendering),
  not with real key presses and frames.
- Not tested on purpose: how things look, and phones. `PLAYTEST.md` lists what to check by eye.

## 8. Publishing

**First `tools/test.sh` must exit 0.** Then:

1. **Tiles** (only when `tiles.json` changed): `python3 tools/stage_tiles.py --out
   driving-berlin-tiles/` hard-links the 3,470 tiles of `tiles.json` from the mirror into the same
   `L#/<REGION>/` layout and writes the dataset card. Upload that folder to the Hugging Face
   dataset `driving-berlin-tiles` (done with the Hugging Face CLI from inside the staged folder: `hf upload <account>/driving-berlin-tiles . --repo-type=dataset`, which splits a large folder into several commits; upload one tile first and fetch it from a browser on another origin). Tile root:
   `https://huggingface.co/datasets/<account>/driving-berlin-tiles/resolve/main/`.
2. **Site:** `python3 tools/publish_site.py --out site/ --tiles <tile root>` copies `index.html`,
   `js/`, `Box2D.js`, `assets/`, `models/` and the runtime level files (an explicit list; build
   inputs such as `osm_*.json`, `*_wfs.json`, scans and audits stay home), gzips the `.bin` files,
   writes `site.json` and `.nojekyll`, and **exits non-zero if any staged text contains `/home/`
   or a mail address** (the privacy guard: fix the source, never the staged copy).
3. **Check** the staged copy locally: serve `site/` on another port; `serve.py` sends CORS on
   `/tiles/`, so `--tiles http://127.0.0.1:8765/tiles/` works for a local check.
4. **gh-pages** holds exactly one commit, the content of `site/`. Each publish replaces it (a fresh
   orphan commit, force-pushed). Only on the owner's word.

`map.html` is not published. Without `site.json` the game behaves as in local play (tiles from
`serve.py`, plain `.bin`).

## 9. Known limits and further reading

Open ends and ideas: `TODO.md`. Notes and plans (kept at the root because code comments refer to
them by name):

- `MITTE_STREAMING_PLAN.md` — the streamer, its options, the occlusion step
- `OBSTACLES_PLAN.md` — obstacle channels (height done; colour channel open)
- `ROAD_CLEARANCE_PLAN.md` — clearing the carriageway, the road audit
- `ROOF_ROUTES.md` — roof route survey (`find_roofs.py`)
- `VEHICLE_INTERFACE.md` — what `index.html` expects from a vehicle module
- `OPTIMIZATION_REPORT.md` — generic optimisation advice from an outside review, with notes on what the streamer already does
- `PLAYTEST.md` — what to check by eye

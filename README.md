# Driving Berlin

> The game loads about 100 MB to start and more data while driving. Best used on Wi-Fi and on a computer, to save data.

*racing/ - drive through the Berlin mesh.* Public name: **driving-berlin** (GitHub repo
`driving-berlin`, tiles as the Hugging Face dataset `driving-berlin-tiles`); see "Publishing" at the end.

A driving game on our own data: the photogrammetric mesh is the scenery (streamed 3D
tiles), OSM building footprints are the walls, a height grid from the mesh is the
fallback road height.

**One level: `mitte_all`** - all of Ortsteil Mitte, 4.4 x 4.1 km, streamed. Start
`python3 racing/serve.py` and open `http://127.0.0.1:8765/`. (The small 0.6 x 0.8 km level
`mitte` around the Brandenburger Tor, one merged `world.glb`, was retired on 2026-11-19; an
old `?level=` in a bookmark is ignored.)

**Rules:** quiet game: no on-screen messages while driving (no toasts, popups, hints,
prompts, status lines, "Tor!"); controls, readouts (speed, bear counter, minimap) and objects in
the world (signs, discs, markers) are fine. Feedback is the world itself (confetti, the bear, the
counter); add a quiet substitute only where the player would otherwise be stuck. The one
allowed note is the street plate (a Berlin street-name plate when the car has turned onto a new
street, rarely; `js/areasign.js`), by the owner's wish 2026-11-21. A second deliberate exception:
entering the Holocaust memorial's no-drive zone shows one calm line, "Respect is Everything.",
centred (white UI sans, soft shadow; 0.6 s in, 4 s, 1.2 s out; at most once per 20 s; only that
zone; `js/respect.js`, `berlinDrive.respectLine.show()`).

Own git repo, nested in (and ignored by) `3d-modell-berlin-mesh`. The build scripts
import `merge_tiles`, `merge_hybrid`, `osm_semantic` (and `build_level.py` also
`merge_lod2`) from the parent folder and read its `berlin_mesh_2025_wab/`, so keep it there.

| file | role |
|---|---|
| `build_level.py` | library for the other build scripts (`raster_top`, `obstacle_layer`, `pit_layer`, `road_mask`, `osm_water`, frame maths); its own CLI built the retired small level |
| `index.html` | three.js renderer, Box2D world, chase camera, HUD |
| `build_stream.py`, `js/stream.js` | streamed level: tile index + height + water, and the browser tile streamer (see below) |
| `build_occluders.py`, `tools/occlusion_replay.mjs` | streamed level: occluder grid + tile tops for the streamer's occlusion step, and its offline replay |
| `build_walls.py`, `js/walls.js` | streamed level: OSM building walls (passages carved), Box2D fixtures only around the car (see below) |
| `build_areas.py`, `js/areasign.js` | streamed level: Ortsteile + historic quarters, for the loading screen and menu ("Berlin-Mitte"); `js/areasign.js` is the street-name plate (see below) |
| `build_clutter.py`, `js/clutter.js` | streamed level: tree trunks + mesh street obstacles, chunked build, switchable cell bodies around the car (see below) |
| `js/vehicle.js` | the vehicle model (Box2D rigid body with four tyres, automatic D/R) |
| `Box2D.js` | Box2DWeb physics library (© Erin Catto, zlib licence) |
| `models/Car.glb`, `models/Bus.glb` | car and bus models |

How the level is built, in this order (all local disk except the cached OSM / WFS requests):
```bash
python3 racing/build_stream.py --name mitte_all --bbox 13.3640 52.5040 13.4290 52.5410   # tiles.json, height, water (~6 min)
python3 racing/build_map.py                 # map.json (minimap, street names; one cached Overpass request)
python3 racing/build_buildings.py           # buildings.bin (camera collision, clutter mask)
nice -n 19 python3 racing/build_occluders.py --name mitte_all   # occlusion.json/.bin (after build_buildings, ~5 min)
python3 racing/build_eggs.py                # eggs.json (bears, pitches; checked against map.json)
python3 racing/build_sbahn.py --name mitte_all          # sbahn.json (~2 min)
nice -n 19 python3 racing/build_tunnels.py --name mitte_all   # tunnels.json (road tunnels, ~2-6 min)
nice -n 19 python3 racing/build_bridges.py --name mitte_all   # bridges.json (decks over water, ~6 min)
python3 racing/build_walls.py               # walls.bin / walls.json (~5 min, ~4 GB RAM; keeps eggs + S-Bahn reachable)
nice python3 racing/build_clutter.py --name mitte_all   # clutter.bin / clutter.json (trunks + obstacles)
python3 racing/build_pits.py --name mitte_all --at LON LAT   # pit windows (or --scan; reads walls.json)
python3 racing/build_areas.py --name mitte_all --pbf berlin-latest.osm.pbf   # areas.json (area sign; after build_map, ~25 s)
python3 racing/serve.py                     # no-cache dev server: http://127.0.0.1:8765/
python3 racing/serve.py 8765 --bind 0.0.0.0 # same, reachable from a phone on the home network
```
Each step is described in its own paragraph below. The bullets that follow describe the
shared algorithms of `build_level.py`; numbers marked *small level* were measured on the
retired level `mitte` and are kept as reference.
- **Walls (small level only):** LoD2 roofs rasterised at 0.5 m, traced (contourpy) and
  simplified (Douglas-Peucker, 0.4 m) into Box2D boxes 0.6 m thick. `mitte_all` uses OSM
  footprints instead (`build_walls.py`, below).
- **Height (small level):** LoD2 wall bases (ground contact), 25th percentile per 50 m block,
  despiked against neighbours and smoothed (sigma 20 m), plus a per-block offset to the mesh
  street ground (median error 0.0 m, slope p99 12 %). `mitte_all`: the L2 mesh top surface
  instead (`build_stream.py`, below).
- **Car height in the game** (`js/ground.js`): four wheel probes into the drawn mesh find the
  road (fallback: the height model above). The car rides on a smooth **ride layer** on top: a
  plane fitted to a 5x3 probe grid over the footprint, keeping only samples near the current
  layer (frozen-traffic remnants and bumps stick out, potholes drop out), low-passed over
  distance driven (rise 1.5 m, fall 4 m, pitch/roll 4 m). The models are shifted so the tyre
  bottoms sit at y = 0 (the car's were modelled 3.9 cm low, the bus's 0.7 cm), and
  `clearance` (-1 cm: a slight sink beats any float) is the true tyre-to-road height. Measured
  with downward raycasts from the tyre bottoms (2026-11): median -1 cm on both the small level and
  `mitte_all` (p5 -15..-18 cm over lumps, p95 +7..8 cm); the height-grid fallback only ran
  where tiles had not arrived yet (0 % and 3 % of updates in two runs;
  `berlinDrive.carGround.stats` counts the layer source per update). Tune live with
  `berlinDrive.ride = { clearance: 0 }` (all constants in `ride` in `createCarGround`).
  The "floating" look came from the shadow: the blob is offset toward the sun, so nothing
  darkened the road where the car touches it. A **contact shadow** (AO under the body + a dark
  spot under each tyre, posed on the ride plane, fading out within ~25 cm of lift) is meant to fix that;
  tune with `berlinDrive.contact = { body: 0.7, tyre: 0.85, bodyW: 1.12, tyreW: 0.7 }` (`CONTACT` in `index.html`).
- **Water:** OSM `natural=water` (incl. the Spree multipolygon) minus bridges (highway
  `bridge=*` buffered 6 m, `man_made=bridge`), eroded 1 m at the quay; fetched once from
  Overpass into `levels/<name>/osm_water.json`. Driving in sinks the car; the Rescue Bear
  (an original helper: bear in a hard hat, propeller basket, fishing rod) fishes it out
  and sets it down on the road where it was 2 s before going in.
- **Bridges** (`build_bridges.py --name mitte_all` -> `bridges.json`, `js/bridges.js`; re-runnable, ~6 min niced,
  reads `osm_water.json`, `water.bin`, `tiles.json` and the L1 mesh): every OSM road or path bridge over
  water (`highway=*` + `bridge=*`, footbridges included; railway-only bridges skipped) is a deck: the
  `man_made=bridge` outline that holds the way, else the way buffered by its `width` (guess per class),
  a centre line with the deck height every 1 m from the L1 mesh top (30th percentile across the deck
  core, so railings, lamp posts and arch / truss members drop out) and rails along the edges where the
  car would drop off (river or >= 2 m down outside; bridge heads and side ramps stay open). In the game
  a deck is never water, its profile replaces the mesh fit under the car while the car is at deck level
  (-2.5 .. +4 m: a car on the quay path below or in the Tiergarten tunnel is unaffected), the rails are
  static Box2D boxes only near the car and footprint edges on a deck are dropped (`walls.js` `clear`;
  OSM maps `building=bridge_support` piers *on* the Gustav-Heinemann-Bruecke, which walled it off). Off
  in S-Bahn rails and tunnel mode. Narrower than 2.2 m or no deck in the mesh -> listed as not drivable
  in the build log / `bridges.json`. `berlinDrive.bridges.items()`, `.deckAt(x, z)`, `.stats()`.
- **Pits** (`pit_layer()`, `--no-pits`): where the mesh top surface lies >= 2 m under the road
  model, >= 30 m2 at least 4 m wide, median depth >= 2.5 m and with >= 8 m of rim on open street
  -> `pit.bin` (water.bin grid) + `pit_floor.bin` (mesh floor height) + `level.json["pit"]`.
  Courtyards inside buildings (no street rim), ramps/light wells/quay strips (narrow) and shallow
  hollows drop out. LoD2 still has a building over the Baugrube Wilhelmstrasse (x 224, z 277,
  13.38204 E 52.51476 N, 12.6 m deep, ~1,500 m2): its walls on the pit rim are opened
  (`pit.openWalls`). Mitte also has a 4 m sunken courtyard open to the street (x 60, z -160).
  Driving over the rim (or landing there from a jump) drops the car onto the pit floor; it lands
  with a squash, then the Rescue Bear lifts it out (same sequence as the water, `kind: 'pit'`).
  `F` draws the pits in magenta; `--debug-obstacles` also writes `pits.png`.
  **Streamed level** (`build_pits.py`, same `pit_layer()` on windows of the L1 mesh from
  `tiles.json`; road model = the level's height.bin, buildings = OSM footprints of walls.bin,
  water = water.bin): `level.json["pit"].windows` = one small 1 m grid per pit window,
  concatenated in `pit.bin` / `pit_floor.bin` (element offsets `off`, `floor.off`), plus `pits`
  (outline, floor, depth, area, lon/lat; map.html draws them) and `footprints` (OSM buildings
  covering a pit by > half: warning only, none so far). `build_stream.py` keeps the `pit` block
  on a rebuild. `mitte_all` has the Baugrube Wilhelmstrasse (two joined parts, x -976 z 864 and
  x -954 z 910, ~3,400 m2, 12.5 m deep, floor 21.7 m): `berlinDrive.teleport(-1015, 857, Math.PI/2)`
  puts the car on Wilhelmstrasse just west of it, drive east. Second pit: Baugrube
  Elisabeth-Selbert-Haus north of Unter den Linden (13.38339 E 52.51709 N, x -890 z 602,
  ~1,650 m2, 68 x 57 m, 4.4 m deep (max 6.0), floor 29.8 m): `berlinDrive.teleport(-900, 640, 0)`
  puts the car on Unter den Linden, drive north. While the car is in the pit the
  camera's look point goes down with it. No pit trigger in S-Bahn rails / tunnel mode.
  **Several pits:** each `--at` run adds one window (pit bbox + 2 m) and keeps every earlier
  window that does not overlap it (an overlapping one is replaced), so pits are added one by
  one; the loader in `index.html` walks the window list (`pitWin`), nothing else changes.
  `python3 build_pits.py --name mitte_all --at LON LAT` adds one pit window (~30 s).
  **Scan (review list only, never touches the pit layer):**
  `nice -n 19 python3 build_pits.py --name mitte_all --scan [--osm-construction F.geojsonseq]`
  rasterises the whole level from the coarse L2 tiles (2 m, ~600 tiles), keeps depressions
  >= 120 m2 and >= 2.5 m median under the road model (water + 6 m excluded), then runs
  `pit_layer()` on L1 only around each -> `levels/<name>/pit_scan.json`. `--scan-full` runs
  `pit_layer()` on L1 over the whole level instead (182 chunks of 400 m, ~1-2 min each on this
  laptop: several hours) -> `pit_scan_full.json`. Both resume after an interruption (finished
  windows in `<out>.partial`; re-run the same command). Each listed pit carries lat/lon, size,
  depth, `known` (already in the game), `osm` (OSM `landuse=` / `building=construction`
  polygons it touches, from `osmium tags-filter ... wr/landuse=construction
  wr/building=construction` + `osmium export -f geojsonseq`) and `near` (metres to tunnels.json,
  the S-Bahn deck, bridges.json, water). `pit_layer()` itself needs >= 8 m of street-level rim
  and a 4 m wide core, but a tunnel ramp, station trough, quay or sunken courtyard can still
  pass, so a person checks the list and adds the real Baugruben with `--at`.
- **No-drive zones** (`js/nodrive.js`, `NO_DRIVE` in lon/lat): the Holocaust memorial (OSM way 172234733) is off limits —
  on contact (on the ground) the Rescue Bear lifts the car straight up onto the street, facing away (`kind: 'nodrive'`); no text on screen.
- **Trees:** Berlin's Baumkataster (WFS `gdi.berlin.de/services/wfs/baumbestand`, street +
  park trees, cached in `levels/<name>/trees_wfs.json`). A tree gets a trunk collider
  (radius from `stammumfg` + 0.1 m, min 0.3 m) **only if the mesh shows it**: within 2 m of the
  trunk the mesh must rise >= 3 m above the road model. Small level: 698 trees, 496 colliders.
  `F` shows walls, trunk rings and a pole up to the visible crown height.
- **Obstacles:** whatever the mesh shows rising from the street (stalls, barriers, tents,
  parked cars, low walls) collides. `build_level.py` rasterises the mesh top surface at
  0.25 m, subtracts a local ground model and keeps objects >= `--obst-min` (default 0.5 m)
  and >= 2 m2 outside buildings, water and vegetation; facade bands, ramps and textureless
  shadow bumps are filtered. Small level: 316 objects.
  `--debug-obstacles` writes an orthophoto with the outlines; `F` shows them in orange.
  Not caught: flat-textured furniture (needs the colour channel in `OBSTACLES_PLAN.md`),
  objects over 12 m and buildings missing from LoD2 (the Brandenburger Tor does not
  collide). Off the road, cars that were driving when the photos were taken are obstacles too.
  **Roads are cleared** (`--roads wfs`, `ROAD_CLEARANCE_PLAN.md`): on the road surface only
  objects > `--road-min` (2 m: lorries, buses, site containers) stay; parked cars, frozen
  traffic, bollards and barriers there are drive-through. Road surface = Berlin
  Strassenbefahrung 2014 (WFS `gdi.berlin.de/services/wfs/strassenbefahrung`, layers
  `cm_fahrbahn` incl. the kerb parking lanes, `ck_parkflaeche`, `ca_haltebereich_bus`,
  `bz_gleiskoerper_strab`; cached in `levels/<name>/roads_wfs.json`), plus OSM roads where
  the survey has none (`osm_roads.json`), minus OSM pedestrian areas and car-free or
  destination-only ways (Pariser Platz). `--roads osm` = OSM only, `--roads off` = old rule.
  Small level: 316 -> 268 objects; the debug PNG shows the road outline, kept-on-road objects in
  purple and removed ones as grey outlines.
- **Jump (`Space`, `berlinDrive.jump()`):** a ~1.2 m hop (0.6 s) with two small landing
  bounces and a squash; frees a stuck car. In the air the car's fixtures are sensors and
  the tyres have no grip (velocity carries on; at standstill a push away from the contact).
  Touching down inside a wall, footprint or obstacle bounces on toward the nearest free
  spot. No second jump in mid-air; none while sinking; landing in the Spree still sinks.
- **Map edge + turn around (`U`, `js/edge.js`):** the level border (`level.json` extent, the
  Box2D border) carries a plexiglas wall: plain milky white, low alpha, a little
  denser near the ground, fading toward the top, no pattern, nothing animated; visible only
  within ~150 m of the car (drawn after the car, no depth writes, not a camera occluder, not
  mood-graded; look constants in `GLASS` at the top of `js/edge.js`). Heading for the edge
  within 120 m sets `berlinDrive.edge.hint` (state only, nothing on screen; U is in the menu's Steuerung page).
  In the last metres the speed toward the wall is capped to a gentle stop (~7 m/s2) about
  0.6 m before the glass; sliding along it stays free. Pushing into it for 3 s turns the
  car around by itself. `U` works anywhere: the car is
  lifted, swings round 180 deg over 1.8 s while gliding back ~20 m along the path it just
  drove (2 m breadcrumbs, checked for walls / obstacles / water / pits) and is set down there
  facing back the way it came, rolling at ~11 km/h. Short trail (just spawned): turns on the
  spot. U again goes back. Test hooks: `berlinDrive.turnAround()`, `berlinDrive.edge`
  (`dist`, `gap` = nearest car corner to glass, `opacity`, `hint`, `pushT`, `turning`, `trail`).
  **Border shimmer (`js/bordershimmer.js`):** near the border (fading in from 150 m, full at 40 m) a faint pale cyan curtain of fine vertical streaks stands on it, 28 m high on the ground, and every 2.5-4 s a band of light runs along it past the car, with a stronger pulse when the car touches the border or is turned around (additive, no collider, not a camera occluder, hidden in tunnels / while loading / on the map; moon a little brighter and bluer).
  Numbers in `SHIMMER` at the top of the file; `berlinDrive.borderShimmer` = `{ opts, pulse(), setEnabled(bool) }` (saved as `berlinDrive.shimmer`, default on).
- **Car drawing:** depth-tested against the mesh (buildings hide it) with a 3 m depth bias
  toward the camera, plus a faint ghost silhouette wherever it is hidden.
- **Camera collision** (`js/camcollide.js`): when the mesh is between camera and car (or around
  the camera, incl. 1.5 m near-plane clearance) the rig turns up over the car (steeper, up to
  83 deg, when the boom would otherwise drop below 60 %) and/or the boom shortens toward the car;
  the car keeps its place in the picture. Pulls in at once, eases back out after 0.6 s clear
  (lift: 1.2 s); shortest boom 12 m car / 26 m bus so it still fits. Occluders are all scene
  meshes with `userData.world` (the streamed tiles; an allow-list - other modules' props,
  balloon, edge glass are never occluders, just don't set that flag); each gets a lazy
  4 m triangle grid. **Only buildings move the camera:** a solid along the line counts only if
  >= half its length lies over an OSM building footprint (`levels/<name>/buildings.bin`, 1 m
  bits + 2 m buffer, from `python3 build_buildings.py --name <level>`, local Geofabrik extract
  via osmium; loaded lazily) and it is >= 2.5 m thick. Tree crowns, poles, signs, wires stay
  in front of the camera and the ghost silhouette shows the car. Without the mask file the old
  heuristic applies (thin < 2.5 m ignored).
  **Nothing over the car moves it** (bridges, viaduct, station roofs, arcades, gateways): a solid with free street at car height under it (horizontal probe from the car, 1 s memory, 1.5 s "under cover") is ignored, any data;
  the mask also drops `building=roof|bridge|carport|canopy`, `layer>0`, raised parts and cuts out bridge / passage corridors.
  Switch: `berlinDrive.setCamAvoid(false)` (saved as localStorage `berlinDrive.camAvoid`),
  `?camcollide=0|1` overrides for one page load.
- **Car in frame:** last camera rule - if the car's centre, nose or tail would leave the central
  75 % of the picture (NDC), the look point moves toward the car just enough (any slider values,
  speed zoom, look-ahead, head-up lag, north-up, sky camera, jump, bus).
- **Spawn:** `level.json["spawn"]` (`build_stream.py`; build_level's `--spawn LON LAT BEARING`
  snapped onto open street with the longest clear run ahead).
- **Frame:** ENU around the bbox centre, three.js X=E, Y=U, Z=-N, Box2D (x, y) = (X, Z).

Local disk only (the portal is down): the level needs the mesh tiles of the bbox in
`berlin_mesh_2025_wab/`.

Controls: arrows or W A S D drive (hold down at standstill = reverse), V head-up (default, camera behind the car) / north-up (`?northup=1`), B car/bus, R = Zum Start (back to the start position, progress kept), F show walls. Handling: `?handling=arcade` (default: grippier tyres, faster self-centring steering, less lock at speed, 2x engine, 1.6x brakes, engine braking, lighter turn-in: 0-100 in 6 s, 100-0 in 3 s) or `classic`. While driving the screen shows only the round map with speed and street name, the street plate when it appears, the credit line, context buttons (leave the S-Bahn tracks) and the touch pads on phones; everything else is in the Esc menu. Camera sliders (height, distance at standstill; standard 50 / 90, speed zoom-out on top, capped at 1.5x by `?zoomout=`) are in the menu's settings.

**Loading screen (`js/loading.js`, 2026-11-21; replaces the start screen):** the way into the game, from page load until the first view is in; then it fades out and the car can drive at once (no button). Title, "Du betrittst" + a yellow place-name sign (Ortstafel layout, CSS only: #EBA400, black inset frame, D-DIN Bold; "Berlin" large, the Ortsteil below at 45 %; areas.json at the start pose; only "Berlin" outside every Ortsteil; `ORT_CSS` / `ortSignHtml()` in `js/areasign.js`, height `--ort-h: clamp(60px, 12vh, 100px)`, 44-60 px on screens under 520 px high), one progress bar from real numbers (level files 0-30 %, then the first view's tiles: entered / (entered + still missing in the main view, `stream.mainMissing`), 100 % only on `stream.idle()`; after 60 s it lets go anyway), a status line, one line of keys (touch: the pad symbols) and the credits. The game view is the background: the canvas starts blurred (22 px) and dimmed and sharpens with the same progress; the CSS filter is removed at the end. Keys are swallowed and physics held (pause reason `load`) while it is up; the HUD is hidden (`body.loading`). Load errors show here in plain words. The driving plate names streets, so it never repeats the loading screen's Ortsteil. `berlinDrive.intro` is this object now (`open`, `named`; `hide()` / `show()` do nothing); the `localStorage` key `berlinDrive.intro` is no longer used.

**Esc menu (`js/menu.js`):** Esc pauses the game (physics, rescue / S-Bahn / roof / tunnel / balloon timelines, doves, dust, area-sign clock; the frozen picture stays, blurred and dimmed; tiles may finish loading) and opens a list under the title (no plate in the menu): **Karte, Einstellungen, Steuerung, Info, Zum Start, Neustart** (no "Weiter": Esc, the close button top right or the touch menu button resume; arrows / Enter / Esc, mouse, touch), plus a plain line "🐻 Bären 7 / 18" (found count only; no list, names or hints in the menu). Esc in a page goes back, Esc on the list resumes; H opens it on Steuerung. Opening is a short slow motion: game time (`timeScale` in `frame()`, the physics accumulator and every `update(dt)`) eases 1 → 0 over 0.35 s while one CSS transition blurs, dims and desaturates the canvas; then the pause begins and the list fades in (0.12 s). Closing: the menu goes at once, the picture sharpens and time eases back to 1 in 0.18 s; driving keys work at once. Durations in `MENU_FX` (`js/menu.js`); `prefers-reduced-motion`: instant. N (map) stays instant. On touch a round three-bar button top right opens it. Held keys are dropped on pause and resume, and the frame clock restarts (no jump). **Einstellungen**: Stimmung, Fahrzeug, Blinker (an / aus: `berlinDrive.setBlinkers` / `.blinkers`), Tempo, Hindernisse (still off on every load), Detail (`Handy` on touch devices only), Kamera (the sliders) - each row calls the old control's function, same storage keys. The old top-row controls stay as hidden elements (`#moodSel`, `#vehicleSel`, `#speedSel`, `#detailSel`, `#collide`, `#restart`, `#eggs`, `#camH` / `#camD` in `#toprow`); keys M, B, C, V, R, N, U, G, E, Space keep working while driving. `berlinDrive.menu` (`open(page)`, `close()`), `berlinDrive.paused`. **Zum Start** = key R (the old Restart: the car back at the spawn, rescue / jump / S-Bahn / tunnel / roof ended, progress kept). **Neustart** asks once in place ("Alles zurücksetzen? Alle Bären sind wieder versteckt." - Ja, neu starten / Abbrechen, Esc = cancel), then clears the progress keys (`localStorage` `berlinDrive.eggs.found`, `berlinDrive.balloon.cut`, `berlinDrive.pos`; `sessionStorage` `berlinDrive.resume`) and reloads without `?spot=` / `?at=` (the mood parameter stays); everything held in memory (balloon start rule, football score, street-plate history, skid marks, roof / S-Bahn / tunnel modes) starts fresh with the reload. Settings are kept (mood, vehicle, speed limit, detail, camera, blinkers, dust / doves / skid switches, minimap, map hint mode, occlusion test switch). `berlinDrive.newGame()` does it without asking. **Auf Standard zurücksetzen** (quiet text button at the bottom of Einstellungen, `berlinDrive.resetSettings()`): removes every `berlinDrive.*` setting key (progress keys kept) and reloads through the mood-switch path (car kept where it is, as the default car; `?mood=`, `?maxspeed=`, `?height=`, `?distance=`, `?camcollide=` dropped), so each default comes from the code that applies it when no key is stored; the menu reopens on Einstellungen.

**Help texts (`js/intro.js`):** the key list / touch layout (menu "Steuerung"), the two ways to play and the credits (menu "Info", loading screen) live here as shared pieces; there is no start screen any more.

**Speed (panorama drive):** the Tempo row in the settings (30 / 50 / 70 / frei) sets the top speed (default 70 km/h, saved as `berlinDrive.speedLimit`; `?maxspeed=` overrides without saving, `berlinDrive.speedLimit = 30` from the console, 0 = free = the old engine up to 160 km/h).
A governor in `js/vehicle.js` holds it for car and bus, both handlings, on ice too: calm 2.8 m/s2 pull, the push fades over the last ~10 km/h (0-50 in ~6 s, no overshoot), gentle braking downhill or after a jump; reverse has the same limit as forwards.

**Vehicle:** the Fahrzeug row in the settings (Rot / Blau / Gelb / Grün / Orange / Lila / Bus) swaps the vehicle in place (same spot, heading and speed) and is saved as `berlinDrive.vehicle` (`car:<paint>` or `bus`); B toggles car/bus and moves the menu with it. Paints are saturated mid-tones that read in every mood (no white/grey for snow, no black/navy for night). Ignored while the Rettungsbär is at work; works on the S-Bahn deck, in tunnels, in mid-air and during a balloon ride. A mood switch keeps the vehicle.

**Moods (prototype):** `?mood=day`
(blue sky, high sun, fair-weather clouds, near-neutral grade) or `?mood=moon` (full moon low in
the west, stars, cold blue grade, headlights carry the picture). `?mood=snow` changes more than the
light: overcast, GPU-animated snowfall around the camera, snow lying on every
up-facing face of the mesh, slush on the streets, and the car cuts tyre tracks that stay (an R8
trail texture over the level that the mesh shader samples). It reads the level's height model as
a texture (street level vs roofs) and turns the car's ghost silhouette navy;
`berlinDrive.mood.time = 12` pins its clock (null = real time). The mesh
keeps its baked noon light, so `js/mood.js` fakes the mood: a colour grade in the mesh shader
(desaturate, split-tone, fake low-sun side-light from screen-space face normals), a gradient sky
with an HDR sun, distance/height fog in the sky's horizon colour that also thickens toward the
level border (no visible cliff), bloom + ACES in an `EffectComposer` (4x MSAA where float
targets render, `?msaa=0` turns it off), recoloured car lights, tail lights and a headlight pool.
A mood keeps the owner-tuned camera (50/90, the saved slider values) - that view shows no sky,
so the mood is carried by grade, fog and lights. `?skycam=1` opts into a low camera (height
20 m / distance 50 m, looking at a point 10 m above the road, `cam.lookUp`) that puts the horizon
in frame; its values are saved under their own keys `berlinDrive.cam4.<mood>.*`, and the sliders
and `?height=`/`?distance=` still override them (camera collision below keeps it out of buildings). Live tuning from the console: `berlinDrive.mood.set('fogDist', 400)` (any preset key,
e.g. `sunAz`, `sunEl`, `exposure`, `sat`, `bloomStrength`, `toneExposure`; nested ones as a whole:
`berlinDrive.mood.set('snow', { ...berlinDrive.mood.preset.snow, street: 0.4 })`), `berlinDrive.mood.preset`
lists them. Without `?mood=` nothing of this runs.

Obstacles: the height channel is built; the colour-anomaly channel (flat furniture, construction sites) is still open - see `OBSTACLES_PLAN.md`.
**All of Ortsteil Mitte, streamed (`mitte_all`, the level):** 4.4 x 4.1 km (bbox `13.3640 52.5040
13.4290 52.5410`), the mesh is never merged: `build_stream.py` indexes the local 3D Tiles
(`berlin_mesh_2025_wab/`, L1 finest, L4 roots: 3,470 tiles, `tiles.json` 0.7 MB with parent,
bounding sphere and one matrix per tile into the level frame), builds the height grid (4 m, L2
mesh top surface, 20th percentile per 50 m block, despiked and smoothed, OSM water left out) and
the water mask. `serve.py` serves the tiles under `/tiles/`. `js/stream.js` picks tiles by
screen-space error (`tau` 24 px: L1 near the camera, coarser further out, hysteresis 0.7;
coarser at speed above 50 km/h, at the screen edge and far away, and when the view nears the
budget), refines a tile only once all its children are in and fit the budget (REPLACE, parents
first, no holes, a sharp spot never falls back), cross-fades parent/children with a 350 ms
dither, looks ahead with the camera predicted 1.5 s / 3 s ahead (velocity + yaw rate) plus L1
120 m around the car, aborts requests nobody wants any more, keeps all 49 L4 roots loaded as a
base layer (L4/L3 textures halved at load), gives the car's surroundings top priority after a
teleport, uploads time-sliced and evicts LRU over a GPU budget (1024 MB incl. the base layer,
never what the view uses). `stream.prefetchAt(x, z, radius, { level, seconds })` loads and pins
a far spot. On-screen "Detail" low / normal / high = 512 MB tau 32 aniso 2 / 1024 MB tau 24
aniso 4 / 1536 MB tau 18 aniso 8 (saved; `?tilebudget=` overrides; `berlinDrive.stream.setBudget(mb)`
/ `setTau(px)` at runtime; `berlinDrive.state().stream` shows counts, MB, peak, `jump` timing
and `events`: downgrade / hole / evict / thrash / cancel / obsolete...).
Tiles hidden behind buildings (from the camera and the poses 0.75-3 s ahead, outside the 120 m ring) are not refined
(occlusion step, data from `nice -n 19 python3 racing/build_occluders.py --name mitte_all`, ~5 min; mostly a gain with a
low camera in a street canyon): `berlinDrive.stream.setOcclusion(false)` switches it off (saved), `stats().occlusion` counts it.
Details and options (KTX2 etc.): `MITTE_STREAMING_PLAN.md`. Rebuild: `python3 racing/build_stream.py --name mitte_all --bbox 13.3640
52.5040 13.4290 52.5410` (~6 min). Remaining steps in `MITTE_STREAMING_PLAN.md`.

**Building walls on `mitte_all` (`build_walls.py`, `js/walls.js`):** buildings are solid (trunks and street
obstacles: next paragraph). Source: OSM `building=*` footprints from the local Geofabrik extract (osmium, no network;
LoD2 is not on disk for the box). Outer rings and courtyard rings stand; dropped: `building=roof|carport|canopy|bridge|viaduct`,
`bridge=*`, `min_height`/`building:min_level` > 0, underground, sheds < 6 m2 (this also drops the 2,600
stelae of the Holocaust memorial - the no-drive zone handles it), `layer > 0` only for station halls or footprints
mostly over a bridge (`layer=1` alone is common on ground buildings over tunnels). Shared walls of terraced houses
are removed, Douglas-Peucker 0.4 m, segments <= 16 m. **Carved** (wall pieces inside a capsule removed, so both
ends of a passage open at once): `tunnel=building_passage|passage|covered`, `covered=yes|arcade|colonnade` and short
`tunnel=yes` ways (width/2 + 0.3 m, >= 2 m); every drivable highway that runs inside a footprint (viaduct arches,
station halls, roads OSM draws through a building - no tags needed) by its width / lanes / class default; every
drivable road centre line keeps 1.5 m to the wall face; the S-Bahn doorways (one per station door in sbahn.json). Raised
`building:part`s with no ground part below open the outline where the opening is passage-like (<= 12 m, <= 30 %
of the outline) and the ground parts become the walls there: the Brandenburger Tor's columns stand, its passages
are open. Underground ways (layer < 0, long tunnels, indoor) carve nothing. The script checks road centre lines every
2 m (outside, clearance), flood-fills from the spawn on a 0.5 m raster (car disc 0.9 m): roads, bears, pitches, goals,
balls, the Weltballon platform, S-Bahn entrance and drop-off points; a bear in a closed courtyard would get one
car-wide gateway toward the nearest reachable street (printed). Output `levels/mitte_all/walls.bin` + `walls.json`
(int16 0.1 m: wall segments, footprint rings for the inside test, carved corridors; layout in `walls.json`).
Rebuild: `python3 racing/build_walls.py --name mitte_all` (~5 min, ~4 GB RAM; `--png` writes the reachability raster).
In the game `js/walls.js` loads the file after start (a level without `walls.json` is unchanged); Box2D fixtures exist
only in the 3x3 cells of 64 m around the car (one static body per cell, destroyed beyond 5x5), always on (not the
Obstacles switch), off in S-Bahn rails mode (the buildings under the viaduct deck). Its data tests work anywhere:
the jump's landing test, `U`, teleport / map "drive here" (nearest clear spot within 40 m) and the start position
use them. Truly enclosed for > 1.5 s (centre in a footprint and all four corners too, or no wall contact; pressing
against a wall never counts): one hop straight to the nearest free spot; safe poses (Rescue Bear set-downs) are never inside. `F` draws the active
walls. Test hooks: `berlinDrive.walls` (`inside(x, z)`, `hits(x, z, h, halfL, halfW)`, `stats()`).
**Wall impacts** (`js/vehicle.js` `SOLID`, `IMPACT`): every static collider is friction 0.35 / restitution 0 (no bounce), an impact keeps 30 % of its
yaw kick (a glancing redirect toward parallel stays whole), the load shift is capped at 1.2 g, a glancing scrape turns parallel; nose-dip <= 2.6 deg, look-ahead eased.
**Parking hold** (`js/vehicle.js` `HOLD`): no key and < 0.5 km/h -> all bodies at rest, no forces, drawn pose frozen; slope force only with throttle / brake held.

**Trunks + street obstacles on `mitte_all` (`build_clutter.py`, `js/clutter.js`):** the small level's rules on the
whole box, built in 500 m chunks (+40 m margin, objects kept by outline centre, resumable per chunk in
`levels/mitte_all/clutter_chunks/`, deleted after a complete run): L1 leaf tiles -> `build_level.raster_top` (0.25 m)
-> `obstacle_layer` (> 0.5 m over a local 16 m street ground, vegetation / facade / texture filters) with road
clearing (`road_mask`, Strassenbefahrung 2014 WFS + OSM fill: on the road only > 2 m), plus `blocks=True`:
flat-topped blocks (3x3 top relief < 0.5 m over >= 10 m2, >= 2.5 m wide, not green, p90 top >= 2.3 m over a street
ring 1-3 m around them, >= 2 m under the roof next to them) are kept whole even in the facade band or with a cut
side - site containers against a house (the blue Baucontainer at 52.51829 N 13.3811 E were lost to the facade band
and the ground opening, which took their top for ground next to the wall); parked cars and vans (< 2.3 m, ~8 m2)
stay drive-through. Buildings = OSM footprints
+ 2 m (`buildings.bin`); road model = the level's 4 m height grid. Kept free: spawn (15 m), bears, pitches + goals +
balls, Weltballon platform (14 m), S-Bahn entrance / street drop-offs (10 m), no-drive zones, construction pits (`level.json` pit outline + 2 m, the
way in stays open), the viaduct corridor
(+3 m) and every OSM bridge (street level only). Obstacles under 2.3 m on drivable OSM centre lines (motorway ... service) and
trunks within r + 0.5 m of one are dropped; taller ones there (sites narrowing a street, lorries, buses) stay
(`--clear-centre-lines` drops them too). Whole box (81 chunks, 18.2 km2, ~55 min with 2 workers): 27,594 trunks, 15,941
obstacle outlines (~880 / km2), road clearing 30,807 -> 20,060 objects (counted per chunk incl. margin), 437 tall
objects kept on centre lines, 156 low ones dropped. Trunks: Baumkataster (`trees_wfs.json`) where the mesh rises >= 3 m within
2 m. The script prints its checks (centre lines, footprints, kept-free places, density). Output `clutter.bin` +
`clutter.json` (float32 trees `[x, z, r, vis]`, obstacle outlines, uint32 index on the 64 m cells of `js/walls.js`).
Caches: `trees_wfs.json`, `roads_wfs.json` (one request per WFS layer, made once), `osm_roads.json` (from
`osm_map.json`, no Overpass). Rebuild: `nice python3 racing/build_clutter.py --name mitte_all` (2 workers, ~0.7 GB
each; `--area X0 Z0 X1 Z1` for a part, `--debug-chunk I J --scratch DIR` writes build_level's debug PNG).
**Only what is visible at car height blocks (2026-11-21):** an obstacle cell stays only where the mesh is at car height
there (its top 0.3-2 m over the street, or steep mesh faces in that band >= 0.5 m2 within 1 m) - tree crowns, lamp
heads and signs over the street no longer block. Rows built before this carry no `ev` and get `js/clutter.js`'s size
guess instead. `python3 racing/audit_roads.py --name mitte_all` walks every drivable OSM road lane with a car-wide
corridor against all static colliders (walls, obstacles, trunks, bridge rails, tunnel walls) and lists every blocked
place, visible or DEFECT, with a `berlinDrive.teleport` line (`levels/mitte_all/road_audit.txt`); details in
`ROAD_CLEARANCE_PLAN.md`.
In the game `js/clutter.js` builds the 3x3 cells around the car (one static body per cell, destroyed beyond 5x5)
and deactivates them with the Obstacles switch off and in S-Bahn rails mode; `inside(x, z)` feeds the jump's
landing test. `F` draws the loaded trunks (red rings + crown pole) and obstacles (orange). Test hook:
`berlinDrive.clutter` (`inside(x, z)`, `stats()`).

**Easter egg - driving on the map screen (index.html `startMapDrive`, `js/minimap.js` `setDriving`):**
hidden, no hint anywhere (no spot link, not on the Steuerung page). The full-screen map (N / "Karte")
opens paused; a driving key (arrows / W A S D; not touch) on it starts the drive: the pause is
lifted, physics, walls, speed limit and obstacles run as in 3D, but `frame()` renders no 3D
(`mapDrive`; tile streaming continues). The map follows the car (eased, north up, zoom kept; a
drag stops following until re-centre or the car leaves the view), redraws at ~25 Hz, shows the
speed top left and a fading ~100 m trail. On the map only the driving keys, Space, Esc and N pass.
Any sequence closes the map at once (rescue, pit, no-drive zone, S-Bahn door, roof lift, tunnel in /
out, edge turn, balloon). Esc / N / close: back in the 3D view at the car's new place (from the
menu's "Karte" too: the menu closes when the drive starts). `berlinDrive.mapDrive`.

**Easter egg - Weltballon (`js/balloon.js`):** the tethered WELT balloon at Zimmerstrasse /
Wilhelmstrasse (OSM way 1250081894, 52.507932 N 13.386118 E; on `mitte_all` x -704.9, z 1621.0),
procedural and abstracted: a 22 m blue globe (pear-shaped below; canvas texture with stylised
continents, grid lines, WELT in plain white capitals round the equator, a line net to a load ring),
a ring gondola (~6 m), one tether to a round platform (r 10 m, ground from the level height grid).
Cycle 360 s: 60 s down, 90 s up to 150 m, 120 s aloft, 90 s down; it sways on the taut cable and
turns slowly. Own scene drawn after the car (depth-tested; no `userData.world`, so no camera
occluder and no ghost trigger), own lighter fog, lights from the mood's car values; night/moon glow
from below, snow puts a white cap on top. Its ground shadow (a soft ellipse cast along the car's
`SUN_OFFSET`, draped on the height grid, tunable via `berlinDrive.balloon.shadow`) lies dark under it on
the platform, slides off along the sun, widens and fades out by 100 m (back in on the way down, off
with it after a cut); the height grid knows no roofs, so buildings hide it. On `mitte_all` the platform is a static Box2D circle on its
own body (always on); stopping next to it while the balloon is down (no prompt), `E` there =
ride: the camera goes up with the gondola for one cycle and turns slowly round over the city, any
key ends it.
Hidden extra (nothing in the menu): the cable runs from the winch house over the platform rim
to a sheave in the pavement 1.1 m outside the rim on the Wilhelmstrasse side (the side the
`?spot=weltballon` start faces); rising, the balloon drifts over the sheave. While it is off the
platform (gondola > 1.5 m up, cycle 65.5-354.5 s) the free cable can be cut: the cable is sampled in
the car's height band (0.3-1.5 m above the street) and tested against the car body polygon + 0.12 m,
so brushing the platform rim there cuts it, driving past more than ~1 m off the rim does not. Not by
a car on the ride, on the S-Bahn rails, in a tunnel or on a roof. Then: snap (the upper end whips up,
the balloon hops), the stub tips over and 7 m of slack
runs out onto the street (~2 s); the balloon rises and drifts east-north-east, slowly at first
(up to 7 m/s up and 9 m/s across within a minute), turning a little, the cut cable trailing under it
(30-point rope), fades out 150-180 s after the cut and is gone. Gone for good: `localStorage`
`berlinDrive.balloon.cut = '1'`; on load (also after a mood change) the platform stands empty with
the slack cable, no ride, no replay. Console: `berlinDrive.balloon.cutNow()` (plays it; puts the
balloon aloft first if needed), `berlinDrive.balloon.restore()` (back on the platform, flag cleared),
`berlinDrive.balloon.state` (`tethered` / `free` / `gone`).
Tests: `berlinDrive.balloon` (`position`, `height`, `phase`, `setPhase(s)`, `startRide()`, `riding`,
`state`, `cutNow()`, `restore()`, `sheave`, `items()` for the map / minimap).

**Ambient - white doves (`js/doves.js`):** every 3-5 min (random, `DOVES.every`) a pair of low-poly white doves
(15 triangles each, wing beat in the vertex shader, soft grey outline; 2 draw calls) flies across the picture
between the camera and the street, in its own scene after the car (depth-tested, no ghost, no occluder, no
collider). None in the moon mood (doves sleep) or in a tunnel. On by default, saved as `berlinDrive.doves`
(`'0'` = off); console: `berlinDrive.doves.release()` (a pair now), `.setEnabled(false)`, `.opts` (tuning).

**Street dust (`js/dust.js`):** soft beige dust puffs kick up at the rear wheels when the car does something
with the street: pulling away from standstill, hard braking (>= 0.65 x full braking), a sharp turn (lateral
>= 5 m/s2, bus 3), landing after a hop, a wall hit, a kerb-like bump, and now and then a light puff while
cruising (more on rough ground). No constant trail. Snow mood: white snow spray; moon: dim and bluish;
S-Bahn rails: sparser dark-brown ballast dust; none in a tunnel, in the air or during a rescue / lift
sequence. Own scene after the car (depth-tested, no ghost, no occluder), pool of 56 points, 1 draw call,
nothing drawn while no puff lives. On by default, saved as `berlinDrive.dust` (`'0'` = off); console:
`berlinDrive.dust.puff()` (one now; kinds `'pull' 'brake' 'turn' 'land' 'wall' 'bump' 'cruise'`),
`.setEnabled(false)`, `.opts` (tuning: `scale`, `alpha`, `size0/size1`, `life`, trigger thresholds).

**Easter eggs - football and the bear hunt (`js/eggs.js`, data `levels/<name>/eggs.json` from
`build_eggs.py`):** somewhere there is a pitch with two goals and an oversized ball (1.3 m, 30 kg Box2D
circle: the car pushes it, it rolls, hops when hit hard and comes to rest); a ball wholly over the line
(sensor in the goal mouth) gives confetti + stars and counts in the session score (`⚽ n` next to the bear counter), then the ball goes back to
the centre spot (also when it ends up far off the pitch or in the water). On `mitte_all` the pitches are
real OSM sports pitches (goals on their short sides) plus one on a big lawn. And Berlin bears are hidden
around Mitte (19 on `mitte_all`): chubby brown teddy cubs built from primitives (no pedestal), each with a small accessory in its own
colour (scarf, bow tie, hat or belly heart), about 4.5 m tall (`BEAR_SCALE`; colours `BEAR_COLORS` / `ACCENTS`), sparkling when you are near; touch one with the car (sensor, no stop,
also in a hop) and it pops into confetti in its own colours, leaving a paw print (no text; the counter counts). The `🐻 n/N` button top left lists them (found
ones by name, the rest as `???` with a vague hint), sets the map hints (`exact / area / off`, default
area = an 80 m circle that holds the bear, not centred on it; saved as `berlinDrive.eggs.hints`) and
resets the hunt. Progress: `localStorage` `berlinDrive.eggs.found` (bear ids carry the level name).
Roof bear: Lotte auf dem Lüders-Haus (`mitte_all.bear.17`) stands on the Bundestag roof deck (`eggs.json` `roof` + `y` = deck height, `build_eggs.py` checks her on the deck instead of the street); only a car in roof mode on that roof finds her, and street bears are not found from the roof (`?spot=baer-lotte` starts on the roof 33 m from her).
Garden at Albrechtstraße 14 (`js/doorway.js`, data `levels/<name>/doorway.json`, written by `build_eggs.py` from `DOORWAYS` / `FOUNTAINS`, loaded by `js/eggs.js` under the eggs' lights): a small hidden homage in the garden set back behind the fence - a simple cartoon of a young woman with bright red hair, pale blue-grey tank top and light green trousers, about 2.4 m tall, mid-stride in front of a plain dark door (frame, no lettering) on the garden facade of the red balconied house on the east side of the garden, facing out as if about to run off; and a round stone garden fountain (3 m basin, column with a small bowl, a point-sprite jet about 1.5 m high, ripple rings). No colliders, no text, not on the map or minimap (kept out of `eggs.json`); her bounce / swaying hair and the water move only within 150 m of the car. Bear Lola in der Albrechtstraße (`mitte_all.bear.18`) stands in the garden 5.8 m north of the fountain (`build_eggs.py` keeps bears >= 8 m from a doorway figure and >= basin radius + 4 m from a fountain). `?spot=lola` starts on Albrechtstraße south-west of the garden, facing figure, bear and fountain.
Hint frames (same module, `doorway.json` `hint-frame` items from `build_eggs.py` `HINTS`): a thin, softly breathing green outline (#1fbf6a, no fill, no text) of an entrance that leads to an unfound bear, hidden once that bear is found and back after a reset. One so far: the building passage off Mauerstraße to Maura (`mitte_all.bear.19`, `?spot=baer-maura` starts in front of it).
Photo group (same module, `photo-group` from `build_eggs.py` `PHOTO_GROUPS`): at Checkpoint Charlie two cartoon performers in plain olive costumes (no insignia, no weapons) and two tourists pose in front of the guard hut for a selfie-stick photo, with a tiny phone flash every 6-10 s (`?spot=checkpoint`).
Watcher (same module, `watcher` from `build_eggs.py` `WATCHERS`): a watcher in the lone window of the gable wall on Mauerstraße; no spot link, on purpose.
Sights (`js/sights.js`, data `levels/<name>/sights.json` from `build_sights.py --pbf <extract>`; OSM extract + L1 mesh, no network): decorations on real buildings, no colliders, no text (the Berlinale banner's one word aside). **Debt clock** over the entrance of Reinhardtstraße 52 (OSM node "Die Schuldenuhr Deutschlands" = a vertex of that footprint; the panel stands 0.25 m in front of the outermost mesh wall behind it, bottom 3.3 m over the pavement, 6.6 x 1.6 m, face turned up 15 deg toward the street camera): black panel, red seven-segment LED digits redrawn 8 times a second, big row = `base + rate x seconds since at`, small row = the rate (6.918 EUR/s) and EUR per inhabitant; the numbers are `CLOCK_NUMBERS` at the top of build_sights.py (from the owner's photo of 13 Jan 2026: 2.638.033.084.257). **Stork's nest** on Charitéstraße 3 (the footprint holding the NABU node): the highest flat part of the L1 roof, its point nearest the street; a 2 m twig nest with two storks 2.3 m tall (larger than life) turning their heads, now and then one throws its head back and clatters. The digits and storks move only within 200 m of the car; the bodies go through the mood grade, the LEDs are never graded (moon: they glow, with a soft red halo). `?spot=schuldenuhr` starts 15 m in front of the clock facing it, `?spot=nabu` on Charitéstraße with the nest up to the left. **Berlinale** at the Theater am Potsdamer Platz (Marlene-Dietrich-Platz 1; the owner's car pose there, `BERLINALE` in build_sights.py: the theatre node within 80 m, its footprint's facade nearest the car; else the footprint along the car's heading, else the nearest facade): the forecourt lies under the theatre's glass canopy, which the chase camera cannot see under, so the 12 m red carpet (3.2 m, darker edges, a hem across each end) starts where its whole width is clear of the canopy and runs straight out across the square, its height one straight line fitted to the open mesh ground; gold stanchions every ~2 m with sagging red ropes, six grey crowd barriers and a ~2 m gold bear statue (our own, the game's teddy proportions) on a low plinth at the open end; a level 9 x 1.8 m banner square to the carpet on a two-post truss, bottom 9.5 m up, tilted 8 deg toward the camera, reading `Berlinale!` with our own small white standing bear beside the word (plain white on deep red in the bundled D-DIN Bold, no festival logo); now and then a camera flash, warm light pools on the carpet in the moon mood; `?spot=berlinale` starts on the square 2 m beyond the carpet, facing the theatre.
Ball, goals and bears have their own static/dynamic bodies, so they work with obstacles off; none of
them is a camera occluder. Markers go to the minimap (`setMarkers`) and to `map.html` via `eggs.json`.
`build_eggs.py` holds the lat/lon lists and checks every item (in the level, not in water or a
building, clear of mesh obstacles, >= 100 m from memorial sites - nothing playful there) and
rebuilds the files: `python3 racing/build_eggs.py`. Tests: `berlinDrive.eggs` (`items()`, `found()`,
`reset()`, `ball`, `goals`, `placeBall(x, z, vx, vz)`).

**Easter egg - the Stadtbahn (`js/sbahn.js`, `levels/<name>/sbahn.json` from `build_sbahn.py`,
`mitte_all` only):** at every S5/S7 station of the route one door is not just a door (`entrances` in sbahn.json). The door is on the station's own building and on the side that is easiest to drive to (`door_sides()` in build_sbahn.py, `--doors-only [--dry-run] [--only <door id>]`): every edge of that station's OSM footprint (`STATION_BUILDING`, outlines + entrance nodes in sbahn.json `footprints`, written by `--footprints --pbf <extract>`) is a candidate (every 4 m, plus the OSM entrance nodes on it, which get a 40 bonus); its approach is the straight line from a drivable lane point 12-80 m away, at most 75 deg off the face normal; cost = 100 per wall / obstacle outline / trunk in that corridor (4 m wide for walls, 6 m for clutter and trunks) + its length + 5 per obstacle or trunk within 30 m of the door + 0.2 per m away from the old door; the zone 3 m in front of the face must have open sky (L1 mesh within 1.5 m of the local ground) and the roll-in end 10 m inside must be covered (the car disappears). Result (2026-11-21): Jannowitzbruecke 5 m from the old door, same face (corridor 15 m, clean); Alexanderplatz 62 m west, north-east side (12 m, clean, 1 obstacle + 3 trunks within 30 m); Hackescher Markt to the south side, 27 m (13 m, clean; the north side faces the market square: 11 obstacles + 6 trunks within 30 m); Friedrichstrasse on the north face of the station hall (Reichstagufer side, 2.5 m from OSM entrance node 11034242431, 12 m, clean; the morning's rule had put it 75 m east on the NH hotel, way 65598154, which led to the footprint rule); Hauptbahnhof keeps the Washingtonplatz door. Each entry has `approach` (the corridor head). Hard check `check_doors()` (`--check-doors`; also run by `--doors-only`, `--carve-doors` and the full build): the door point within 1.5 m of its station's footprint and the roll-in end inside it, else the build fails. The doorways are carved in walls.bin in place by `build_sbahn.py --carve-doors` (zone -> door capsule, 2.2 m: segments clipped, a corridor record added; build_walls.py makes the same carve from `entrances` on its next rebuild). The only marker is a steady green column of light standing exactly on the spot to drive into (`makeLiftBeacon` from `js/liftpad.js`: 22 m, brightest at the base with a soft glow at its foot, no pulsing, no lettering), full within 250 m of the car and fading out to 650 m; the minimap and the N overview show each door as a green dot with a white up-arrow (`setMarkerGroup('sbahn-stations', ...)`). Drive in: the car rolls on by itself into the station until it is gone (camera on the doorway), a short black blink (0.25 s in, 0.35 s out), and the car is on the open deck beside the tracks at that station, rolling at 30 km/h toward the longer ride (west from Jannowitzbruecke, Alexanderplatz, Hackescher Markt; east from Friedrichstrasse and the Hauptbahnhof). That deck spot is `lifts[i].deck` in sbahn.json (from the short-lived platform version; `lift_pads()` / `--lifts-only` still compute it, the street slabs in the same entries are unused): open deck with no roof 8 m either side, 2.7 m inside the corridor edge (Jannowitzbruecke s 474, Alexanderplatz s 1284, Hackescher Markt s 1950, Friedrichstrasse s 3254 west of the hall, Hauptbahnhof s 4318). On the tracks the same spot is the station's stop, marked by a shorter (7 m) green light beside the track; drive into it (3.5 m), blink, and the car rolls out of that station's street door, 5 m in front of the face, facing away, at walking pace (2.8 m/s). The door waits until the car is 8 m beyond its zone, a deck stop until the car is 11.5 m away. No bear, no text. Then the car drives on the viaduct (rails mode) between Jannowitzbruecke and the Hauptbahnhof (4.4 km, over the Spree and the Museumsinsel). The car's height is the deck profile: OSM viaduct tracks, mesh top sampled on
the tracks (median per track, 2nd lowest track - parked trains and gaps drop out), train sheds
(Alexanderplatz, Friedrichstrasse) and platform roofs bridged by straight lines, smoothed
(6 m); the ground probes only look at the band around it, so roofs are never hit. A corridor
(outermost tracks + 2.4 m, 15-43 m wide) is a loop of Box2D boxes active only in rails mode, plus a
clamp on the car centre for jumps. At both route ends (buffer stop, a faint green strip) the
Rescue Bear carries the car down to the street. Anywhere in between, **"🐻 Runter von den Gleisen"** (a button
above the speed readout, only while on the tracks and no bear scene runs; key **G**) calls the bear
at once (hovering 11 m over the car, the camera's look point at their height so both stay in frame): the car stops where it is and is carried to the nearest of `bailouts` in sbahn.json (same
'sbahnOut' timing as a station exit), set down along that street (the direction nearer the car's,
one-way streets as signed). No text tells the player (quiet game); the button is the hint, and the
menu does not list it (hidden egg). `bailouts` = one spot per 25 m of route (141 spots), chosen
offline from lane centres of drivable OSM surface roads within 150 m, each checked against the game's
own data: car box >= 0.8 m from walls.bin / clutter.bin faces and trunks (140 also fit the bus), no
water within 4 m, not in buildings.bin or any OSM building / part / man_made=bridge outline + 1 m
(viaduct arches, station halls), not on a bridge deck, >= 6 m outside the corridor and >= 9 m from
every viaduct track, >= 15.5 m from every door zone (beyond the 8 m re-arm), away from tunnels,
pits and the memorial, flat street model. Carry p50 25 m, p95 88 m, worst 150 m at the Hauptbahnhof
end (Humboldthafen / Alexanderufer). `--bailouts-only` recomputes only this list (~3.5 min, ~4 GB
RAM, no mesh); the full build writes it too. **Tiefgarage (spatial joke):** the underground-garage entrance on Am Friedrichshain (OSM node 2971353420, driveway "Am Schweizer Garten") is a door of a different kind: crossing a 6 m line at the entrance node (inward only: facing in and moving in) hands the car to the game as at a station door (kind 'sbahn'): it rolls on ~10 m along the driveway axis, slowing to 2.5 m/s and sinking 3.5 m down the ramp until it is gone (2-4 s, camera on the mouth), the screen fades to black (0.25 s), and the car is on the open deck just east of the Friedrichstrasse hall (s 3065, 25 m east of the roof edge, 100 m of open deck ahead), rolling east toward Jannowitzbruecke at the speed it had at the line (8-30 m/s), while the black fades out (0.35 s). No bear, no text. `sbahn.json` `portal`, `PORTAL` in build_sbahn.py, `--portal-only` rewrites just that key (seconds); test `berlinDrive.sbahn.portal(kmh)` (puts the car 4 m before the line, rolling in) or `portal(kmh, true)` (straight onto the deck). No water rescue or ice on the viaduct; R, teleport and the map
drop rails mode; a mood switch on the deck stays on it. On the deck the camera sliders edit their own
set (same standard as the street since 2026-11-22, was 30 / 50; `berlinDrive.cam7.sbahn.*`; street set `berlinDrive.cam7.*`, 50/90 (the owner's standard since 2026-11-21; older saved `cam4` / `cam5` street values are ignored),
`?height=`/`?distance=` apply to it); entering or leaving rails mode blends between the two over 1.5 s. Rebuild (~2 min, local mesh + the
`build_map.py` OSM cache): `python3 racing/build_sbahn.py --name mitte_all [--png]`; it prints
its checks (deck vs mesh, height above street, slope, corridor margin to the border, exits on
open ground, each door: zone on open ground, lift point clear of exit spots). Tests:
`berlinDrive.sbahn` (`active`, `enter(s | station name | door id)`, `exit(name?)`, `bail()` (= the button), `data.bailouts`, `route`,
`items()`, `entrances`).

**Road tunnels (`js/tunnels.js`, `levels/<name>/tunnels.json` from `build_tunnels.py`):** the Tunnel Tiergarten
Spreebogen (B96, two tubes of ~2.8 km incl. branches: portals Schöneberger Ufer / Potsdamer Platz, Ben-Gurion-Strasse,
Invalidenstrasse and Heidestrasse/Minna-Cauer-Strasse; under the Spree and the Humboldthafen) and the Tunnel
Alexanderplatz (Grunerstrasse - Otto-Braun-Strasse, two tubes of ~300 m) are drivable. The mesh only shows the open ramps;
before, the car rolled on under the surface at the last road height (`js/ground.js` "carry on") and drowned under the Spree.
Data: OSM tunnel ways (drivable classes, `tunnel=yes`, `layer<0`, no service / foot / rail) from the `build_map.py` cache,
the open ways at their ends followed outward (the ramps); one tube = one connected set of tunnel ways (Y-junctions kept).
Mesh windows around the portals only (L1, `raster_top`): ramp floor (25th percentile across the carriageway, overpasses
bridged), street beside it, and the **face** = where the mesh jumps up over the road and stays up for 30 m. Profile: the
mesh ramp up to 3 m before the face, then the highest profile with grades <= 5 % that keeps 7 m under the street and 10.5 m
under a river (water level from the mesh over the river, ~33.5 m; ponds < 2 ha do not count), as a slope-limited envelope over the
tube graph, smoothed with the ramp ends fixed (no step at the handover). Deepest roadway ~23 m (10 m under the street, at the
Humboldthafen / Spree). Corridor: lanes x 3.5 m + 1.25 m each side (narrowed where two tubes run close), walls where the ramp is
>= 1 m deep and underground, opened at junctions. Tubes leaving the level would stop 40 m before the border with a glass cap
(none does). The script prints its checks (grades, kinks, portal faces vs OSM, ramp / wall starts, distances to the border).
In the game: driving down a ramp past its face (inward, car height within 3 m of the roadway) switches **tunnel mode** on; out
through any face of the same tube switches it off - no cut, no bear. On the deep part of an open ramp the corridor walls are
on (one static body, SOLID material, own collision category) while the car follows the mesh; never from position alone, a car
on the street above a tube is not touched. In tunnel mode the roadway profile replaces the mesh under the car (pitch follows the
ramps), the car collides only with the tunnel walls (Box2D filter mask: no buildings, clutter, ball, bears from above), its
centre is clamped into the corridor, Space is a small hop, `U` turns round inside the tube; no water rescue, pit, no-drive
zone, hop-out, safe poses, snow tyre tracks, camera avoidance, contact / sun shadow. The camera stays as on the street; the car
shows as the ghost silhouette and the tube as an outline in the same colour drawn through the ground (floor + ceiling edges,
a faint centre dash, ribs every 20 m, portal frames; static, not mood-graded), only in a tunnel or within 80 m of a portal,
fading out 150-300 m from the car. R, teleport and the map drop tunnel mode; a mood switch inside a tube keeps it. The minimap
already draws tunnel roads dashed. Rebuild: `nice -n 19 python3 racing/build_tunnels.py --name mitte_all [--debug DIR]`
(DIR: profile plots + mesh window cache). Tests: `berlinDrive.tunnels` (`active`, `guided`, `items()`, `routes`,
`enter(portal id | index)`, `portals()`, `stats()`).

**Roof mode (`js/roofs.js`, `levels/<name>/roofs_deck.*` from `build_roofs.py`):** the Bundestag roof is drivable:
the Paul-Löbe-Haus glass hall roof and wings, the roof of the upper Spree skywalk (2.5-5 m wide, about 24 m up) and the
Marie-Elisabeth-Lüders-Haus (27,000 m² of deck from the L1 mesh, 0.5 m grid). Getting up: a grey lift slab (14 x 5 m, `js/liftpad.js`) on the forecourt at the west entrance (x -1582, z 259.4): drive onto it, the
car is rolled to its centre, the slab rises 27 m, slides 26.5 m east over the canopy and docks on the hall roof, and the car rolls off (19 s, no bear, no text). Direct:
`?spot=bundestag-dach` or `berlinDrive.roofs.enter()`. On the roof the car rides the stored roof height and only collides
with the large roof structures (the two drums, the wall round the raised east part of the Lüders-Haus, one long inner wall: 199 Box2D boxes in 4 groups);
small clutter (vents, frames, housings, outer parapets) and holes under 30 m² are driven over as flat roof, and the deck is smoothed; walls, clutter, water, pits, doors
and bears below are off, and so is camera avoidance. There are no rails: when the car centre leaves the deck, it goes over the edge
and falls to the street, a courtyard or the Spree, and the bear puts it back on the roof at the last checkpoint at least 1 s before
the fall (checkpoints every 0.5 s). Steps of up to 1.4 m between roof parts are ridden as short ramps. In roof mode the slab waits at the
dock on the hall roof (x -1555.5): driving onto it takes the car back down, and it rolls off west onto the forecourt. The Rescue Bear only brings the car back after a fall, on a short 10 m line so he stays in frame. R, teleport and the map leave roof mode; a mood switch keeps it.
Rebuild: `nice -n 19 python3 racing/build_roofs.py --work DIR [--check]` (about 30 s, or 5 min with `--check`: deck heights against the L1/L2 mesh,
skywalk width), then `python3 racing/build_spots.py --only bundestag-dach`. Tests: `berlinDrive.roofs` (`active`, `enter()`, `exit()`,
`deckAt(x, z)`, `checkpoints`, `stats()`).

**Obstacle switch:** the Hindernisse row in the settings (key `C`) turns the
street clutter off: tree trunks and mesh obstacles (their own static Box2D body). Buildings
(OSM walls, `js/walls.js`) and the level border always block; height, water and the jump's footprint test for
buildings stay. Saved in `localStorage` `berlinDrive.collision`; from code
`berlinDrive.setCollision(bool)`. Disabled (shows off) on a level without trunks/obstacles. On `mitte_all`
it switches the `js/clutter.js` cells (needs `clutter.json`); the switch never touches buildings.

**Spot map (`map.html`, the owner's tool page; no longer linked from the game or published):** an OpenStreetMap street map (Leaflet 1.9.4
from cdnjs) showing the level border with its size and a play link, the spawn and the pits.
On `mitte_all` it also shows the footprint of the finest L1 tiles (from `tiles.json`, a square of
half side r/sqrt2 per tile), with "coarse only" or "no mesh" marked where they occur. A table
gives the distance from the spawn, and from the car when the game is open, to the border going N/E/S/W.
Each line names the nearest street at the end (from `map.json`), and the map draws dashed lines.
Points of interest come from `levels/<name>/eggs.json` (optional), with found bears from localStorage
`berlinDrive.eggs.found`. Live link: the game posts `{type:'pos', level, x, z, heading, speed, lat, lon, t}`
4x/s on `BroadcastChannel('berlinDrive')` (fallback localStorage `berlinDrive.pos`). The map
sends `{type:'teleport', level, x, z, heading}` (the game ignores one for another level). Click the map, pick a heading, then "drive here". With the game closed,
the button opens `index.html?at=lat,lon,bearing` instead. A target in a building, water or a pit
moves to the nearest clear spot within 40 m. `?at=` is removed from the URL after use. `window.mapDebug` holds the numbers.

**Spot links (`?spot=<slug>`, data `levels/<name>/spots.json` from `build_spots.py`):** every easter-egg
spot has its own link, e.g. `http://127.0.0.1:8765/?spot=fussball-reichstag` (`&level=mitte_all` may stay,
it is ignored). The car starts a short drive before the spot, facing it. Start order: mood-switch resume,
then `?spot=`, then `?at=`, then the level spawn; an unknown slug gives a console warning and the normal
spawn. `?spot=` stays in the URL, so a reload starts at the spot again. `map.html`: click a point of
interest for "drive there" (moves the car when the game is open) and "copy link"; console:
`berlinDrive.spots()` (slug, name, kind, url), `berlinDrive.spot(slug)`. The poses are a table in
`build_spots.py` (known tested starts, or chosen there along OSM roads) and every one is checked offline
(car box clear of walls / footprints, 3 m from clutter, water, pits, no-drive zone, level border;
reachable by driving and not in a closed pocket): `python3 build_spots.py` (exit 1 on a failed check).
Re-run it after `clutter.bin`, `walls.bin` or `eggs.json` change. To add a spot: one row in `SPOTS`
(e.g. another S-Bahn door: `("sbahn", "sbahn-<station>", name, ("sbahn", "<entrance id>"), {"start": (x, z, h)})`
or without `start` for an automatic pose).

| Spot | slug |
|---|---|
| Bolzplatz Stallschreiberstraße | `fussball-stallschreiberstrasse` |
| Bolzplatz an der Kleinen Hamburger Straße | `fussball-kleine-hamburger` |
| Bolzplatz an der Holzmarktstraße | `fussball-holzmarktstrasse` |
| Wiese vor dem Reichstag | `fussball-reichstag` |
| Bär Republika am Platz der Republik | `baer-republika` |
| Bär Paula am Pariser Platz | `baer-paula` |
| Bär Gustav am Gendarmenmarkt | `baer-gustav` |
| Bär Luise im Lustgarten | `baer-luise` |
| Bär Ursula an der Weltzeituhr | `baer-ursula` |
| Bär Hacki am Hackeschen Markt | `baer-hacki` |
| Bär Leo am Leipziger Platz | `baer-leo` |
| Bär Niko im Nikolaiviertel | `baer-niko` |
| Bär Mona im Monbijoupark | `baer-mona` |
| Bär Hugo am Hauptbahnhof | `baer-hugo` |
| Bär Maxi im Köllnischen Park | `baer-maxi` |
| Bär Wilma im Weinbergspark | `baer-wilma` |
| Bär Hilde im Hinterhof | `baer-hilde` |
| Bär Fritzi am Kronprinzenpalais | `baer-fritzi` |
| Bär Jana an der Jannowitzbrücke | `baer-jana` |
| Bär Philippa am Campus Nord | `baer-philippa` |
| Bär Lola in der Albrechtstraße | `baer-lola` |
| Bär Maura an der Mauerstraße (behind the building passage) | `baer-maura` |
| Checkpoint Charlie: photos at the guard hut | `checkpoint` |
| Bär Lotte auf dem Lüders-Haus (on the roof) | `baer-lotte` |
| Garten in der Albrechtstraße (doorway figure, fountain, Lola the bear) | `lola` |
| Weltballon (E: mitfahren) | `weltballon` |
| Schuldenuhr, Reinhardtstraße 52 (debt clock) | `schuldenuhr` |
| Storchennest auf dem NABU-Haus, Charitéstraße 3 | `nabu` |
| Berlinale: red carpet at the Theater am Potsdamer Platz | `berlinale` |
| Holocaust-Mahnmal (no-drive zone) | `mahnmal` |
| S-Bahn, secret door at Jannowitzbrücke | `sbahn` |
| S-Bahn door at Alexanderplatz | `sbahn-alexanderplatz` |
| S-Bahn door at Hackescher Markt | `sbahn-hackescher-markt` |
| S-Bahn door at Friedrichstraße | `sbahn-friedrichstrasse` |
| S-Bahn door at Hauptbahnhof | `sbahn-hauptbahnhof` |

The `sbahn-*` spots start the car at the head of the door's clear corridor (`approach`; Hauptbahnhof: (-1832.5, -176.2) on Washingtonplatz, the corridor head there lies under a structure), and build_spots.py checks the straight drive start -> door zone: walls, clutter and trunks at least car half width + 1 m (1.9 m) from the line.
| Tiefgarage Am Friedrichshain (garage ramp -> Friedrichstraße hall) | `tiefgarage` |
| Baugrube Wilhelmstraße | `baugrube-wilhelmstrasse` |
| Baugrube Elisabeth-Selbert-Haus (east side open) | `baugrube-elisabeth-selbert-haus` |
| Tunnel Tiergarten, north entrance (Minna-Cauer-Straße) | `tunnel-tiergarten-nord` |
| Tunnel Tiergarten, south entrance (Schöneberger Ufer) | `tunnel-tiergarten-sued` |
| Tunnel Alexanderplatz (Grunerstraße) | `tunnel-alexanderplatz` |
| Gustav-Heinemann-Brücke | `heinemann-bruecke` |
| Bundestag roof (straight onto the roof, roof mode) | `bundestag-dach` |

**Minimap (bottom left, `js/minimap.js`):** north-up map around the car (car = red arrow, N
marker, scale bar; streets by class, S-Bahn/tram, Spree, parks, building footprints, level
border), above it the street the car is on (nearest named OSM way within 25 m; footways and
tunnels lose against a road, the way along the heading wins at crossings, small hysteresis),
the nearest landmark within 150 m and the quarter (nearest OSM quarter/neighbourhood node, a
rough guess), below it the car's WGS84 position (`52.51634° N, 13.38050° E`, exact inverse of
the level's ENU frame; click copies `lat, lon`). `N`, "Karte" in the menu or a click on the disc
opens the **overview**: a full-screen dark street map (own palette, separate from the disc's grey)
centred on the car at street level; drag pans, wheel / pinch / `+` `−` zoom, a crosshair button
re-centres, `✕`, `N` or `Esc` close it (from the menu: back to the menu). Street names along the
streets (major roads first, more when zoomed in; placed once per zoom level with a collision grid),
quarter names in spaced capitals, and nothing but the car: an arrow with a soft cone in the view
direction - no bears, pitches, goals, station doors, hints, legend or found count. The game is
paused while it is open. Coordinates (click copies) bottom left; the disc-hide control top right. Mouse
wheel on the map zooms (saved), it zooms out a little at speed. The `−` button hides the map
(the position line stays; `Map` brings it back), saved in `localStorage` `berlinDrive.minimap`.
Static layers are drawn once into 256 px tiles; per update (15 Hz) only a blit and the arrow.
Data: `levels/<name>/map.json` from `build_map.py` (one Overpass request for highways, rail,
water, parks, places, building footprints, cached raw as `osm_map.json`, 33 MB for mitte_all;
a level inside another level's bbox would reuse that cache). Without
`map.json` the panel shows the water mask only. Rebuild:
`python3 racing/build_map.py` (`--name mitte_all` is the default; ~1 min from the cache;
delete `osm_map.json` to fetch fresh OSM). Tests: `berlinDrive.minimap` (`street`, `near`,
`latlon()`, `refresh()`, `setOverview(bool)`, `setVisible(bool)`).
Markers for other features: `berlinDrive.minimap.setMarkers([{id, kind, x, z, label, found, mode,
radius}])` replaces the set (level metres); `setMarkerGroup(name, list)` for other groups. Since
2026-11-21 only kind `lift` (S-Bahn station doors: green dot) is drawn, on the round disc only;
the other kinds are kept but never shown (no easter egg given away). Calls before the module has
loaded are kept and handed over.

**Street plate (`js/areasign.js`; quarters: `build_areas.py`):** when the car has turned onto a
new street, a Berlin street-name plate with its name fades in top centre (white enamel, thin black
frame line set in from the edge, rounded corners, tall black condensed lettering in mixed case;
46 px high, 34 px on touch / narrow screens; 0.4 s in, 4 s, 0.8 s out; not clickable; long names
shrink the type to 80 % before an ellipsis). The name is the minimap's street lookup
(`minimap.street` / `streetKind`, handed in by index.html). Calm on purpose: only named streets of
the major classes (motorway, trunk, primary, secondary + links) or minor ones (tertiary,
residential, unclassified, living street, pedestrian); never service ways or paths; the car must
have driven > 10 km/h for 6 s on that street (standing pauses the count, another name restarts
it); at most one plate per 90 s, the same name not again within 10 min, a minor street only when
no plate showed for 3 min; once at the start (1.5 s after the loading screen, the street the car
starts on, if one is found within 8 s); never during rescue / S-Bahn / roof / tunnel / balloon
sequences, edge turns, the loading screen or a pause. A blocked candidate is dropped, not queued.
`berlinDrive.areaSign.state()` gives the candidate, its class, the dwell, `why` and the last
decision; numbers in `.opts`; `.show('Unter den Linden')` to try the look. The quarter (below)
data is now only used as the Ortsteil, "Berlin-<Ortsteil>" (`districtAt()`), on the loading
screen ("Du betrittst Berlin-Mitte") and in the menu header; the historic quarter points are kept
in areas.json but no longer shown. On touch it
keeps clear of the round map (narrower, or below it when there is no room beside it).
`build_areas.py` reads the local OSM extract (`--pbf` / `OSM_PBF`, osmium, no network):
Ortsteile = `boundary=administrative` + `admin_level=10` relations overlapping the level,
simplified (5 m) and clipped to the extent + 600 m, stored as flat rings (even-odd); the
historic quarters are the `quarter` / `neighbourhood` points of map.json `places`, each tagged
with its Ortsteil. `mitte_all` (2026-11-21): Mitte, Tiergarten, Moabit, Wedding,
Gesundbrunnen, Prenzlauer Berg, Friedrichshain, Kreuzberg, Schöneberg; 24 quarters; 8 KB.
(`locateArea()` still returns the nearest quarter within 600 m for tools; nothing in the game shows it.)
`.state().area` is "Berlin-<Ortsteil>" at the car. Font: family `BerlinSign` = D-DIN Condensed Bold
(`assets/fonts/`, weight 700, declared once by `ensureSignFont()` in `js/areasign.js`, which the
loading screen calls at page start; fallback `"Liberation Sans Narrow", "Arial Narrow", sans-serif`).
One plate style (`PLATE_CSS`, `.bplate`, sized by `--ph`: type 70 % of the height, frame line set
in, rounded corners, `#fff` / `#000`) for the street plate, the loading screen and the menu; the
title "Driving Berlin" is plain white lettering in the same font (no plate).

## Publishing (GitHub Pages + Hugging Face)

The public copy is a static site: game code on GitHub Pages, the 3,470 mesh tiles (1,992 MB)
as the Hugging Face dataset `driving-berlin-tiles`. Local play is unchanged: without a
`site.json` the game streams from `serve.py`'s `/tiles/` and loads plain `.bin` files.

- **`site.json`** (optional, next to `index.html`; read by `js/site.js`):
  `{"tiles": "<tile root URL>/", "gz": true}`. `tiles` replaces `tiles.json`'s `"base"`
  (`js/stream.js`); `gz` makes `fetchBin()` load `<name>.bin.gz` and unpack it with
  `DecompressionStream('gzip')` (index.html height / water / pits / buildings, js/walls.js,
  js/clutter.js, js/roofs.js, the occlusion grid in js/stream.js). JSON files stay plain (hosts
  compress those themselves).
- **`tools/stage_tiles.py [--out driving-berlin-tiles/]`**: hard-links every tile in
  `levels/mitte_all/tiles.json` from `../berlin_mesh_2025_wab/` into the same `L#/<REGION>/…`
  layout (no extra disk) and writes the dataset card `README.md`. Expect 3,470 files,
  1,991,704,704 bytes.
- **`tools/publish_site.py --out site/ --tiles <URL>`**: copies `index.html`, `js/`,
  `Box2D.js`, `assets/`, `models/` and the runtime level files (explicit list in the script;
  build inputs such as `osm_*.json`, `*_wfs.json`, scans and audits stay home), gzips the
  `.bin` files (29.4 MB → 6.3 MB; `water.bin` 18 MB → 49 KB), writes `site.json` and
  `.nojekyll`, and exits non-zero if any staged text file contains `/home/` or a mail address.
  Staged size 12.2 MB, 53 files.
- Tile URL for the Hugging Face dataset:
  `https://huggingface.co/datasets/<account>/driving-berlin-tiles/resolve/main/`.
- `serve.py` sends `Access-Control-Allow-Origin: *` on `/tiles/`, so a staged `site/` on
  another port can stream from it (`--tiles http://127.0.0.1:8765/tiles/`) for a local check.
- `site/` and `driving-berlin-tiles/` are git-ignored. The build scripts that read the OSM extract
  (`build_walls.py`, `build_buildings.py`, `find_roofs.py`, `build_areas.py`) take `--pbf` or env `OSM_PBF`.

## Licence and credits

*Driving Berlin* is a free, non-commercial hobby project. The 3D mesh belongs to its provider
(below); the project is not affiliated with or endorsed by Berlin Partner or the State of Berlin.

- **3D mesh:** *3D-Meshmodell Berlin 2025 © Berlin Partner für Wirtschaft und Technologie GmbH*
  (attribution text from the open-data register entry).
  **Not an open licence.** The Berlin open-data register entry "3D-Meshmodell Berlin"
  (publisher Senatsverwaltung für Wirtschaft, Energie und Betriebe; harvested copy checked
  2026-11-21 at `https://www.govdata.de/ckan/api/3/action/package_show?id=lod2-gebaudedaten-berlin`,
  original `https://daten.berlin.de/datensaetze/3d-meshmodell-berlin`) lists the portal
  resource with licence `http://dcat-ap.de/def/licenses/other-closed` and points to the terms
  of use at `https://www.businesslocationcenter.de/berlin3d-downloadportal/resources/terms/terms.de.html`
  (on 2026-11-21 that URL answered with the portal's maintenance page; no archived copy found).
  The terms could not be read while the portal was down; publishing the tiles is the owner's
  decision (2026-11-21), with full credit and without any claim of permission.
  In the game: the city picture (3D tiles) and the street heights.
- **OpenStreetMap:** © OpenStreetMap contributors, ODbL 1.0 (`https://www.openstreetmap.org/copyright`).
  In the game: streets and street names, building outlines (walls), water, bridges, tunnels, the
  S-Bahn route, Ortsteile, the map.
- **Baumkataster Berlin** (street trees and park trees, WFS `https://gdi.berlin.de/services/wfs/baumbestand`,
  layers `baumbestand:strassenbaeume`, `baumbestand:anlagenbaeume`; `build_clutter.py` → cached
  `trees_wfs.json`): Geoportal Berlin, dl-de/zero-2.0. In the game: tree trunks as obstacles (only
  where the mesh shows a crown).
- **Straßenbefahrung 2014** (WFS `https://gdi.berlin.de/services/wfs/strassenbefahrung`, layers
  `cm_fahrbahn`, `ck_parkflaeche`, `ca_haltebereich_bus`, `bz_gleiskoerper_strab`; `build_level.road_mask`
  → cached `roads_wfs.json`, used by `build_clutter.py`): Geoportal Berlin, dl-de/zero-2.0. In the
  game: the clear carriageway (no obstacles on the road).
- **three.js** (MIT, from the jsDelivr CDN), **Box2D** (`Box2D.js`, box2dweb, © Erin Catto, zlib
  licence), **Leaflet** in `map.html` (BSD-2, from cdnjs; tool page, not published).
- **Sign fonts:** D-DIN Bold and D-DIN Condensed Bold, © 2017 Datto Inc., SIL Open Font License 1.1
  (`assets/fonts/D-DIN-Bold.woff2`, `assets/fonts/D-DINCondensed-Bold.woff2`, licence
  `assets/fonts/OFL-1.1.txt`, `FONTLOG.txt`; shipped together by `tools/publish_site.py`). Condensed:
  street-name plates and the title; regular width: the yellow place-name sign.
- In the game: the small credit line bottom left (`level.attribution` + OSM), the short credit
  line on the loading screen (`CREDITS_HTML`) and the menu's Info page "Daten & Quellen" (one row
  per dataset / library: name, publisher, licence, use). All three come from one list,
  `DATASETS` / `SOFTWARE` in `js/intro.js`; keep this section in step with it.

# Plan: clear the roads — on the carriageway only things taller than 2 m block

> Note 2026-11-19: the small level `mitte` was retired; `mitte_all` is the only level.

Saved 2026-11-18, not started. For an Opus agent. Start only after the streaming agent has
finished (it refactors `build_level.py` and checks the `mitte` level rebuilds byte-identical).

## Goal (owner, 2026-11-18)
The car gets stuck on low clutter in the street. On actual roads only objects taller than
**2 m** stay obstacles (site containers, e.g. at the university; hoardings, kiosks, buses).
Everything lower on the road is cleared: parked cars, frozen traffic, bollards, barriers.
Off the road nothing changes (0.5 m rule). LoD2 walls and tree trunks are untouched.
Supersedes for road surfaces the 2026-11-16 decision "parked cars are obstacles"
(`OBSTACLES_PLAN.md`).

## Road surface: which data
1. **Preferred: Berlin Straßenbefahrung 2014 WFS** — `https://gdi.berlin.de/services/wfs/strassenbefahrung`
   (same host as the Baumkataster WFS already used for trees; reachable 2026-11-18).
   Layer `strassenbefahrung:cm_fahrbahn` = carriageway polygons. Look through
   GetCapabilities for the parking-lane / bus-bay / tram-track layers
   (`ca_haltebereich_bus`, `bz_gleiskoerper_strab`, a `park…` layer) and decide which belong
   to "road" — default: carriageway + parking lanes + bus bays + tram tracks in the street.
   Not road: `cl_gehweg`, `cj_fussgaengerzone`, green, `cg_baustelle`.
   One bbox request per layer, cached in `levels/<name>/roads_wfs.json` like `trees_wfs.json`
   (same request pattern, `build_level.py` trees section). Data is from 2014: check a few
   spots against the 2025 orthophoto (Unter den Linden was rebuilt for the U5).
2. **Fallback: OSM** — `way[highway]` buffered by `lanes × 3.25 m` or `ROAD_WIDTH[highway]`
   (`../osm_semantic.py`, `ROAD_WIDTH`, `OVERPASS` endpoint list; cache next to
   `osm_water.json`). Skip `tunnel=yes`, footways, paths, pedestrian areas, `service` driveways
   inside blocks stay road. Use it where the WFS has no polygon or the WFS is down.
Record in `level.json["obstaclesNote"]` which source was used. Attribution string: add
"Straßenbefahrung 2014: Geoportal Berlin, dl-de/by-2.0" (verify the licence in the capabilities).

## Build (`racing/build_level.py`, `obstacle_layer()`)
- Rasterise the road polygons to a bool mask on the obstacle grid (0.25 m), same polygon
  raster helper as water/buildings. Erode nothing; optionally dilate 0.25 m to cover kerb pixels.
- New options: `--road-min 2.0` (threshold on roads, m), `--roads wfs|osm|off` (default `wfs`
  with OSM fallback; `off` = today's behaviour, byte-identical output).
- Apply per pixel before component labelling: on road pixels `raised = nd > road_min`,
  elsewhere `nd > obst_min` (today line ~328). So a container straddling the kerb stays one
  object; a parked car half on the pavement keeps only its pavement part → then drop
  components whose road-cleared remainder is a sliver: after the per-pixel rule, apply the
  existing area filter (`--obst-min-area`) and additionally drop objects whose pre-clearing
  footprint was ≥ 60 % on the road and whose max height on the road part is < `road_min`.
- Keep the upper limit (`--obst-max` 12 m) and the vegetation/façade filters as they are.
- Print: road area, objects before/after, list of objects removed vs. kept on roads.
- Debug PNG (`--debug-obstacles`): draw the road mask outline; kept-on-road objects in a
  distinct colour; removed ones as thin grey outlines.

## Game
No code change needed: `index.html` already reads `level.obstacles`. Check the `F` overlay.

## Verification
1. `--roads off` → `level.json` identical to the current one (obstacles unchanged).
2. Rebuild `mitte` (`--name mitte --bbox 13.3745 52.5135 13.3830 52.5210 --no-mesh
   --spawn 13.3805 52.51634 80 --debug-obstacles`): report counts (today 316 objects).
   Look at the debug PNG: road mask sits on the carriageways of Unter den Linden,
   Wilhelmstraße, Dorotheenstraße, Ebertstraße, Straße des 17. Juni; pavements, Pariser
   Platz (pedestrian) and the promenade market stalls keep their 0.5 m obstacles.
3. Find at least one object > 2 m on a road in the level (container, bus, lorry) and confirm
   it stays; if the `mitte` box has none, say so and test the rule on a small scratch level
   around a known site-container spot at the Humboldt-Universität (`--out-dir` in the
   scratchpad, tiles are on disk in `../berlin_mesh_2025_wab/`, `--mesh-src`).
4. Headless drive test (`berlinDrive.teleport/simulate/state/showDebug`, helper `shot.mjs`):
   drive 300 m along a kerbside lane that had parked cars — never drops to 0 km/h; drive
   into a kept > 2 m object — stops; market stall on the promenade still stops the car.
5. Update `README.md` (Obstacles bullet) and `OBSTACLES_PLAN.md` (decision line). No commit.

## Open points for the agent to settle and report
- Do parked cars along the kerb lie in `cm_fahrbahn` or in a separate parking layer? The
  owner wants roads clear; default is to clear parking lanes too (visible parked cars become
  drive-through). Report how it looks so the owner can decide to limit it to driving lanes.
- 2014 survey vs. 2025 mesh: list places where the road layout changed.
- The big streamed level `mitte_all` has no obstacles yet; this plan only prepares the rule.

## Rule 2026-11-21: only what is visible at car height blocks (implemented)
Owner: "How can we be sure roads are 100% accessible if nothing VISIBLE(!!!) is in the way?" At
52.51677 N 13.38295 E (x -918.6, z 637.4, north lane of Unter den Linden) the car was stopped by
pieces of tree crown 8-10 m up: the obstacle scan looks at the mesh from above, so a crown, a
lamp head or a sign over the street became a collider on the ground with nothing under it.

**Rule:** the car may only be stopped by something the player can see at car height.

**Car-height test** (`build_level.car_band` + the car-height step at the end of
`obstacle_layer(..., prims=...)`, used by `build_clutter.py`): every mesh triangle that reaches
into the band 0.3-2.0 m over the local street (`street_ground`: road model + 16 m ground opening)
and is steeper than ~45 deg is sampled (25 points / m2); each 0.5 m cell gets the side-face area
it holds in the band. A container, a hoarding or a parked lorry has side faces there; under a
crown, a lamp or a sign there is nothing (measured at the spot: 0.0 m2 for all five crown pieces,
2.5 m2 per m of outline for the hoarding, 1.8 for the blue Baucontainer at 52.51829 N 13.3811 E).
A cell of an object stays only where its own top is in the band or where such side faces sum
to >= 0.5 m2 within 1 m (`CAR_SIDE`, `CAR_REACH`; a 1.7 m high face across that disc holds ~3.4
m2); holes enclosed by kept cells are filled (a container roof); what is left under 1 m2 goes. Each kept outline carries `ev = [side m2 per m of outline, kept
share]` in `clutter.bin` (section `ev`). `js/clutter.js` trusts rows with an `ev`; rows built
before the test (NaN) fall back to the size guess (>= 4.5 m high and <= 20 m2: no collider).
Tree trunks still come from the Baumkataster, not from the mesh.

**Road audit** (`audit_roads.py`): walks every drivable OSM road of the level (classes of
`osm_semantic.ROAD_WIDTH`; tunnel ways only inside the game's tunnel tubes, against the tube walls;
bridge ways on drivable decks also against the rails), lanes across the width (lanes x 3.25 m or
the class width, one lane per 3.25 m), a corridor 2.27 m wide (car 1.67 m + 0.3 m each side) along
every lane in 0.5 m steps, tested against every static collider the game builds with the game's
geometry: walls.bin (minus bridge decks), clutter outlines and trunks (incl. the JS size guess),
bridge rails, tunnel walls. Pits are holes, intended; the level border (3 m) is skipped. Blocked
steps become places (same collider, contacts within 6 m). A place is "visible, intended" when the
mesh has steep surface in the car band >= 0.5 m2 within 1 m of a contact (the build's statistic),
or >= 4 collider cells (1 m2) whose top is in the band; anything else is a DEFECT. `ALL` = no lateral position across the road
is left where the car fits. Output `<out>.txt` (summary line, every defect with lat/lon, x/z, road,
collider, height/area, `berlinDrive.teleport(x, z, heading)`; the 40 longest visible ones) and
`<out>.json` (all places, counts).

```
python3 audit_roads.py --name mitte_all                    # whole level, ~1 h (mesh windows)
python3 audit_roads.py --area X0 Z0 X1 Z1 --out /tmp/a      # a part (level x/z)
python3 audit_roads.py --no-mesh                            # geometry only, ~1 min (places unchecked)
python3 audit_roads.py --clutter path/to/clutter --no-guess # another clutter.bin, without the JS guess
```
What it cannot see: roads not in OSM or mapped off their real position (the lanes follow the OSM
line, the width is a class estimate); squares and parking areas (area=yes); dynamic things
(bears, balls, the balloon platform, S-Bahn); the surface parts of tunnel ramps are tested
against the surface colliders only, not the tube walls; collisions in tunnel mode with anything
else; whether a "visible" thing is really an object and not mesh noise that reaches car height.

## Lane rule 2026-11-21: on the road itself the car drives (implemented)
Owner: "I am stuck again ON THE ROAD ITSELF: 52.528000 13.38149" (Hannoversche Strasse, x -1017.3,
z -611.9): two lumps (2.3 m / 4 m2 and 4.9 m / 1.5 m2) each closed one of the two lanes. They passed
the car-height test, because what the mesh froze into the carriageway on the flight day is real
geometry at car height: parked and moving cars, vans, lorries, bollards and poles, smeared lumps
at the kerb. After the full car-height rebuild the audit still counted 1,857 obstacle places in
lanes (area p50 11.5 m2, h p50 2.5 m; 857 under 10 m2; mostly parked cars and vans by the mesh
crops) and 115 + 80 trunks.

**Rule** (`build_clutter.lane_rule`, applied in `assemble` and by `--post-lanes` on the assembled
clutter.bin without a mesh pass): the lane corridors are the audit's (every lane of every drivable
OSM road outside tunnels, car half width + 0.3 m either side) widened by `LANE_WH` 0.3 m (the
collider box) and one 0.5 m cell (raster tolerance).
- An obstacle outline reaching into a corridor is **cut at the corridor edge**; what stays beside
  the lane (a parked car on the kerb side, a stall on the pavement) still blocks. Pieces under
  1 m2 go.
- **Exception, barriers:** >= 50 m2 (`BARRIER_A`), p90 height >= 2.3 m (`BARRIER_H`) and >= 8 m
  long along the main axis (`BARRIER_L`) stay whole: building sites, hoardings, container rows,
  pavilions OSM lacks. A bus is ~30 m2, an articulated bus / semi-trailer 41-45 m2. Examples: the
  hoarding on Unter den Linden (307 m2, 2.9 m, 90 m long), the blue containers (80 m2, 10 m, 41 m).
- **Trunks** whose circle reaches into the widened corridor are dropped: no tree stands in a lane,
  so either the register position or the OSM line is off.
- The audit names the exception class `barrier` and prints every one of them.
Corridor raster: exact distance to each OSM segment at 0.5 m (PIL's wide lines were up to a cell
narrow on diagonals and left 300 grazing outlines). First run on the 02:36 build
(`--post-lanes`, 4 min, no mesh): 13,978 outlines clear of the lanes, 163 barriers kept whole,
1,947 cut at the lane edge (9,254 m2), 614 dropped (6,738 m2), 666 trunks dropped.
`build_clutter.py --no-lane-rule` builds without it; `clutter_lanes.json` holds the counts and
the barrier list of the last run.

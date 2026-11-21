# Roof routes in Mitte: where could a car drive on the roofs?

An offline check for the "James Bond on the roofs" easter egg (level `mitte_all`).
Route #1 has since been built into the game (see "Built" at the end). Script: `find_roofs.py`. Candidate list:
`levels/mitte_all/roofs.json`. Crops: `roof_crops/`. Each crop has two panels: on the left
the height-shaded mesh (grey = street level, then blue, yellow and red up to 40 m), on the right
the mesh texture. Magenta outlines where the car's centre may be, the red line is the longest
drive, and the circles mark links (green = flush, orange = drop, cyan = parapet).

## Answer
Yes, there is one real house-to-house roof route. In the mesh, the **Bundestag band** runs from the
Paul-Löbe-Haus glass hall roof over the **roof of the upper Spree skywalk** to the
Marie-Elisabeth-Lüders-Haus: 467 m at about 24 m above the street, with no jump. The skywalk
roof is only about 3.5 m wide, so it is a tight drive for a 1.7 m car. Apart from that, Mitte has
plenty of long flat single roofs, 120 to 250 m each: Hauptbahnhof, Plattenbau slabs, perimeter
blocks, the BND and Pariser Platz. Roof-to-roof links across a street are rare. Of the OSM
skywalks, only the Bundestag one checked out as joining two drivable roofs on L1. No roof has a
ramp the mesh can see, so in practice the game has to lift the car up. The one exception is the
IHZ car park top deck, whose real ramps are inside the building.

## Method
1. **Whole level, coarse:** top surface of all 601 L2 tiles, 1 m raster (`raster`, 15 min).
   Street level is taken from the level's road model `height.bin`.
2. **Drivable cell:** a plane is fitted over 3 x 3 cells. The slope must be at most 10 degrees,
   the fit residual at most 0.15 m, and the step to a drivable neighbour at most 0.3 m. Roof
   clutter (vents, lift housings, parapets, panels, skylight frames) fails this test and is
   treated as an obstacle.
3. **Car fits:** drivable cells at least 3 m above the street are eroded by 1.5 m: the 1.7 m car
   plus margin needs a 3 m wide strip. The car-centre areas that remain must be at least 150 m²,
   with a median height of at least 6 m.
4. **Links** between areas less than 3 m apart are classified by the height profile across the
   gap. *Flush* is |dz| ≤ 0.3 m. *Drop* is 0.3–1.5 m and one-way. *Parapet* means something
   higher than both sides stands between them (that needs a hop). *Gap* means a void, and
   *cliff* means a bigger drop. Flush and drop links join areas into a network.
5. **Route:** the longest geodesic line through a network (two Dijkstra sweeps). "Buildings" is
   the number of OSM building polygons the network covers by at least 20 m². These are often
   `building:part`s, so read it as "sections".
6. **Ranking:** route length times (1 + 0.35 per extra building). Things already drivable in
   the game (`bridges.json`, the S-Bahn viaduct) are pushed down.
7. **Refine:** the top 24 networks are re-run on the **L1** mesh at 0.5 m with texture. Crops
   are made from this pass. They are re-run twice more with looser limits: a 15 degree slope,
   and a 2 m car-centre corridor (half-width 1.0 m). Nine hand-picked spots (skywalks, car
   parks) are checked the same way.
8. **Hidden bridges:** OSM `building=bridge`, `man_made=bridge`, `highway=*` + `bridge` and
   raised ways (`layer>0`) that are not in `bridges.json` are sampled on the L2 raster. For each
   one we record the deck (or skywalk roof) height above the street, the flat width across it,
   and whether there is water below.

Re-run: `nice -n 19 python3 find_roofs.py --name mitte_all --work DIR raster osm analyse refine bridges`
(about 25 minutes, most of it the L2 raster). Spots: `--cands spots.json refine`.

## Ranked candidates
`rel` is the roof height above the street. `route` is the longest drive in metres, at the
limits named in the notes.

| # | Place | lat, lon | x, z | rel | route | bld | weakest link | access | confidence | crop |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Bundestag band**: Paul-Löbe-Haus hall roof → upper Spree skywalk (OSM way/11355720) → Marie-Elisabeth-Lüders-Haus | 52.52018, 13.37556 | -1421, 258 | 23–26 | **467** | 6 | skywalk roof about 3.5 m wide (2 m corridor only); one-way drops of 1.0–1.3 m between the hall roof and the wings | none, lift | high for the geometry: the L1 profile is continuous across the Spree (23.2 → 25.3 → 23.1 m, 2.3 % grade). With the default 3 m corridor it splits into the 224 m Paul-Löbe-Haus roof alone | 01 |
| 2 | **Hauptbahnhof**, north–south hall roof between the office bows | 52.52502, 13.36944 | -1836, -281 | 27 | 229 | 1 | ends against the 45 m bow walls. The bow tops (46 m) give a 360 m loop, but only on a 2 m rim | none, lift | high (glass roof) | 02 |
| 3 | **Victoriahof** perimeter block, Köpenicker Str. 126 | 52.50864, 13.42368 | 1846, 1542 | 24 | 220 (232 at 15°) | 4 | steps ≤ 0.4 m, about 3 m bottleneck between clutter | none, lift | medium | 03 |
| 4 | Block Beuthstr. / Kommandantenstr. | 52.50945, 13.40160 | 346, 1452 | 25.5 | 197 (15°) / 97 (10°) | 4 | 0.9 m one-way drop | none, lift | medium | 04 |
| 5 | Retail block between Charlottenstr. and Markgrafenstr.: flat rim round a shed-roof hall | 52.50545, 13.39356 | -200, 1898 | 11.5 | 200 | 3 | rim 4–6 m wide | unknown (no ramp or parking tag in OSM) | medium | 05 |
| 6 | **BND headquarters**, Chausseestr. | 52.53367, 13.37631 | -1370, -1243 | 33–37 | 247 (15°) / 92 (10°) | 1 | flush | none, lift | medium | 06 |
| 7 | Plattenbau slab Michaelkirchstr. (10 storeys) | 52.50886, 13.42086 | 1654, 1518 | 33 | 154 | 3 | flush joints (0.11 m) | none, lift | high | 07 |
| 8 | Slab on the Spree canal, Unterwasserstr. | 52.51380, 13.40195 | 370, 968 | 22 | 159 | 2 | 4–5 m | none, lift | medium-high | 08 |
| 9 | Quartier 208, Friedrichstr. / Charlottenstr. | 52.51540, 13.39043 | -412, 790 | 29 | 146 | 3 | flush 0.26 m | none, lift | medium | 09 |
| 10 | Atrium, Friedrichstr. / Kronenstr. | 52.51091, 13.39076 | -390, 1289 | 29 | 164 (15°) / 115 | 2 | 0.78 m drop | none, lift | medium | 10 |
| 11 | Plattenbau slab Waldemarstr. | 52.50483, 13.41552 | 1291, 1966 | 23 | 125 | 5 | 0.66 m drop | none, lift | medium-high | 11 |
| 12 | **Pariser Platz**: Allianz Forum, French embassy, Palais am Pariser Platz | 52.51702, 13.37866 | -1211, 610 | 19.5 | 138 (15°) / 94 | 3 | 0.79 m drop, 3 m bottleneck | none, lift | medium; view of the Brandenburg Gate | 12 |
| 13 | **Parkhaus IHZ**, Friedrichstr.: open top deck of an 8-storey car park | 52.5193, 13.3897 | -380, 345 | 30 | 86 | 1 | flush 0.22 m | **real** (ramps inside the building, not in the mesh): drive in at the gate, warp to the deck | high (parked cars visible) | 14 |
| 14 | Stadtbahn viaduct west of Hbf + Humboldthafenbrücke (railway) | 52.52376, 13.36516 | -2127, -141 | 9 | 293 | 0 | 0.87 m drop at a deck change | extend the rails mode (`sbahn.json` stops at x = -1695) | high | 16 |

Also seen, but weaker:
- **Jakob-Kaiser-Haus skywalks over Dorotheenstraße** (way/25777061/62, 20 m up, 4.5 m wide):
  the L1 route stays on one side, at 134 m. The skywalks themselves did not join up.
- **Charité / Luisenstraße skywalks**: the roof is 123 m at 15 m, but the skywalks do not link it.
- **Mall of Berlin passage roof**: 129 m at 17 m with a 2 m corridor.
- **Rathauspassagen**: the route found is the 11 m green podium roof (120 m), not the car park deck.
- **Hilton car park deck**: 63 m.
- Plattenbau Holzmarktstraße: 162 m at 30 m, but only at 15°.

## Hidden bridges (OSM, not in `bridges.json`, more than 5 m above the street)
Widths come from the 1 m L2 raster across the way (`flatW`, median), or from the OSM polygon.

| What | OSM | where (lat, lon / x, z) | length | height | width | car fits? |
|---|---|---|---|---|---|---|
| Bundestag upper skywalk over the Spree (roof) | way/11355720 | 52.52060, 13.37632 / -1364, 211 | 135 m | 25 m | 3.6 m (polygon) | yes, tight; it is route #1 |
| Stadtbahn west of Hbf + Humboldthafenbrücke (rail) | way/342098476, rel/2625533 | 52.5241, 13.3659 / -2072, -183 | 850 + 630 m | 9–10 m | 10–17 m | yes (rails mode) |
| Stadtbahn east of x = 1860, towards Ostbahnhof (rail) | way/345095777 | 52.51211, 13.42656 / 2036, 1156 | 255 m | 7 m | 19 m | yes (rails mode) |
| Skywalk at Rathauspassagen / Grunerstr. | way/1474458460 | 52.51898, 13.41097 / 983, 390 | 50 m | 22 m | 7.5–9.9 m | yes, but it is isolated on L1 |
| Jakob-Kaiser-Haus skywalks over Dorotheenstr. | way/25777061, way/25777062 | 52.51798, 13.37876 / -1204, 504 | 45 m each | 21 m | 4.5 m | yes, tight |
| Charité skywalks, Luisenstr. | way/949811104, way/27779134, way/327481160 | 52.5266, 13.3783 / -1240, -460 | 57–122 m | 6–14 m | 3.7–13 m (flat about 3–5 m) | partly |
| Skywalks Behrenstr. / Glinkastr. | way/330965612, way/367983110 | 52.5146, 13.3849 / -790, 875 | 49–59 m | 12–15 m | 4.6–5.6 m | tight |
| Prinzessinnenpalais passage over Oberwallstr. | way/317728387 | 52.51706, 13.39638 / -8, 606 | 37 m | 14 m | 13.5 m (pitched roof, flat about 2.5 m) | no |
| Bridge building near Bebelplatz | way/1335912468 | 52.51628, 13.39651 / 1, 692 | 40 m | 11.5 m | 11.6 m (flat about 3 m) | maybe |
| Rail or road deck near Nordbahnhof / Gartenstr. (untagged `man_made=bridge`) | way/533541339, way/533541340 | 52.5402, 13.3797 / -1140, -1980 | 143–214 m | 11–15 m | 5–10 m | yes |
| Smaller skywalks (Invalidenstr., Chausseestr., Wallstr., Brunnenstr.) | way/391245009, way/43452272, way/1284684369, way/556291490 … | see `bridges_hidden.json` | 25–45 m | 9–17 m | 4–9 m | some |

Raised footways (Mall of Berlin, Paulette-Nardal-Terrasse, Hbf forecourt, the
Friedrichstraße station footbridges) come out about 1 m wide on the L2 raster. They are either
roofed passages or are not resolved at that scale.

## What the method cannot see
- **Resolution:** the whole-level pass works at 1 m on L2, the refine at 0.5 m on L1. Objects
  smaller than about 1 m (thin railings, cables, low edges) are invisible. Each drivable area also
  loses about one cell at every edge, so widths are conservative by 0.5–1 m.
- **Glass and skylights** look like flat roofs (#1, #2). The mesh has no material information.
- **Slope limit matters:** many roofs are 10–15° in the mesh (photogrammetry tilts flat roofs
  slightly, and some roofs really are shallow pitches). At 15°, BND, the Beuthstraße block and
  the Atrium roughly double. The report gives both values.
- **Only the top surface** is visible. Covered decks, car-park levels under a roof, and the
  internal ramps of car parks are not seen. That is why "access" is "none" almost everywhere.
- **Candidate selection:** the L1 refine covered only the 24 best coarse networks plus 9
  hand-picked spots. A roof that the L2 pass rated short or split could still be good on L1.
  The whole level was not run on L1 (that would take hours).
- The link classes look at a 3 m gap only. Wider street gaps (real jumps) are not reported.
  "Buildings" counts OSM polygons and parts, not separate houses.

## What the game feature would need
- **Getting up:** the Rescue Bear lift already exists (S-Bahn), so a "roof lift" at a marked spot
  would work: a crane or helicopter hook next to the Paul-Löbe-Haus, or the IHZ car park gate
  that warps to the top deck. A drivable ramp would have to be modelled by hand.
- **Staying on the roof:** a per-route height grid (like `pit_floor.bin`) of the L1 top surface,
  with clutter cells as Box2D obstacles, plus an edge mask. The walls in `walls.bin` are at
  street level and must be switched off while the car is on a roof (a "roof mode", like the
  rails mode).
- **The edge:** falling off is the fun part. Use the existing fall, then a bear rescue back to the
  last roof checkpoint, or back to the street.
- **Camera:** a higher chase camera, and keep the camera-collision code from snapping to
  roof clutter.
- **Effort:** about 1–2 days for one route (the Bundestag band: L1 height grid, obstacle mask,
  roof mode, lift spot, checkpoints). About half a day for each further single roof, using the
  same machinery. The rails-mode extension over the Humboldthafen is a separate job, about half
  a day of `build_sbahn.py` work.

## Built (2026-11-21): route #1, the Bundestag band
`build_roofs.py` → `levels/mitte_all/roofs_deck.json` + `.bin`, `js/roofs.js`, wired into `index.html`, spot
`bundestag-dach` (kind `roof` in `build_spots.py`).
- **Deck:** L1 top surface at 0.5 m over x -1600..-1080, z 180..340. Flat cells (the same test as above), at least 3 m
  above the street. Gaps of up to about 3 m are closed when they lie between the two sides' heights. This joins the
  hall roof to the wings at the 0.9–1.3 m steps, which the car drives as short ramps. The deck is grown 2 m into rough
  but level cells and cut where neighbouring cells differ by more than 1.4 m. Only the part that holds the seeds on the
  PLH hall roof, the skywalk and MELH is kept. Result: 27,163 m², heights 57.3–63.0 m, median 24.6 m above the street.
- **Clutter (reworked 2026-11-21, owner: "a completely straight roof"):** only large structures block: more than
  0.35 m above the deck next to them and at least 3 m thick and 20 m² big (the two round drums of the MELH). Also
  blocking: one long, high wall inside the roof (the 28 m wall at the west end of the hall roof) and cliffs (more than
  1.6 m within 1 m, at least 3 m long), which is the wall around the raised east part of the MELH. In total 199 Box2D
  rectangles in 4 groups (before: 254 in 54 groups, 48 of them under 10 m²). Vents, skylight frames, housings and
  parapets are driven over. No box runs along the outer edge or the skywalk (5 of 2,889 outer-edge cells and 0 of 656
  skywalk-edge cells touch a box).
- **Holes:** holes under 30 m² and edge notches up to 2 m are filled. Enclosed holes went from 66 (44 under 10 m²,
  4 of 10–50 m²) to 18, all of them 50 m² or more: courtyards, large light wells and a lower part of the MELH roof,
  where the car falls.
- **Smoothing:** filled cells are interpolated from the deck around them. Trenches and ridges narrower than 2.5 m are
  removed, and the deck gets an edge-aware 5 × 5 mean (only neighbours within 0.25 m). The mean step between
  neighbouring cells along lines across the roofs: PLH hall 0.1 → 0.0 cm, PLH wing 1.2 → 0.5 cm, MELH 2.2 → 1.7 cm,
  skywalk 0.7 → 0.4 cm. On flat parts the deck is within 2.0 cm of the mesh top (|p90|; |p99| 5.7 cm).
  Kept on purpose: the 0.9–1.4 m steps between roof parts, driven as short ramps. Also kept: the sunken ring
  (0.4–0.7 m, about 5 m wide) around the glass dome on the raised MELH part, which is real geometry and is now ridden
  as ramps with no boxes or holes in it.
- **Skywalk as built:** 2.5–5.0 m of deck (median 4.0 m) between x -1400 and -1325. It is narrowest (2.5–3.5 m)
  towards the MELH end, at a height of 57.9–58.2 m.
- **Height check** (`--check`, the deck against the mesh sampled independently at 0.1 m, after the smoothing): L1 roof
  (24 points) has a median of 0.00 m, |p90| 0.07 m and a maximum of 0.12 m. The L1 skywalk (16 points) has a median of
  -0.03 m and a maximum of 0.07 m. Against L2 the deck sits 0.15–0.27 m lower (maximum 0.75 m), which matters only if
  the streamer shows L2 under the car.
- **Missing:** no hand-made ramps. Steps up are ridden, not blocked. Glass is treated as roof.

### Lift (2026-11-21, owner: "a grey platform instead")
One grey slab (`js/liftpad.js`, 14 × 5 m, takes the bus) with two stops replaces the glowing discs, the signs and the
bear lift. The street stop is at x -1582, z 259.4 on the forecourt. The owner's spot (-1572.2, 259.4) was under
the canopy edge (canopy deck 58.0 m, ending at x -1573), so the slab moved 9.8 m west into open sky. The roof stop
(dock) is at x -1555.5 on the hall roof (flat within 0.02 m). The ride takes 19 s: roll to the centre 1.2 s,
rise 27 m 6.4 s, slide 26.5 m east at 61.8 m (clearing the canopy and the 61.1 m ridge at x -1568) 7.6 s,
settle 1.3 s, roll off 2.5 s. Down is the same in reverse. The roof has no lettering anywhere.
The bear used to be invisible in the lifts because his rod tip hovered 16 m above the roof. That put him about 40 m
above a car on the street, above the top edge of the 35° chase view. He now stays on a 10 m line over the car, which
matters for falls.

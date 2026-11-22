# After launch

Feature freeze until the game is online (owner, 2026-11-21). New ideas are collected here
and built afterwards.

## Known and deferred
- Phone test on the live address; touch layout fixes (portrait mode, top-right menu button).
- Render-resolution setting for weak graphics chips.
- Mention the first-load size (about 105 MB) on the loading screen.
- KTX2 textures to cut download size and GPU memory.
- A contact / takedown line for the data provider; optionally ask the provider in writing.
- Station doors: the deck stops at Alexanderplatz and Hackescher Markt were not re-derived
  after the Friedrichstraße fix; three bail-out points were removed by hand.
- Bundestag roof: the sunken ring round the dome still rides as ramps.
- Pit-scan candidates on construction sites (about 11) to review.
- Wall places in lanes (32) and barrier places without a gap (93) from the road audit.
- Car tyres are octagons in the model: slight bobbing when they spin.
- Pull-away squat for the car body.
- Dust cloud still uses the old, more generous turn trigger.

## Ideas
(add here)

## Ideas from looking at another photomesh game (Skyfall Protocol, Lyon; read for ideas only, no code taken)
1. A failed tile must never hide its parent: swap to finer tiles only when all of them loaded; retry failures with a growing delay.
2. Let detail follow the frame time: coarsen quickly when frames get slow or memory is full, refine slowly.
3. Keep tiles in the browser between visits (Cache Storage, keyed by tile address plus a dataset version, with a size cap), so a second visit downloads almost nothing.
4. Choose the memory budget from the device's memory instead of a fixed value.
5. Light fog to blend away the coarse tiles in the distance; a sky/light direction that matches the sun baked into the photos.
6. A water surface for the Spree made from the flat, low triangles of the mesh inside a river outline.

# Play-through before launch

One sitting, one browser tab (close every other game tab first: each holds over 1 GB).
Mark each line `ok` or `broken`. Only things that stop a visitor from playing are fixed
before launch; everything else goes to `TODO.md`.

Start: `http://127.0.0.1:8765/`

## 1. Loading and start
- [ ] The picture starts blurred and sharpens with the bar; the yellow sign reads "Berlin / Mitte".
- [ ] You can drive the moment the screen fades. Arrow keys and W A S D both work.
- [ ] The city is sharp around the car within about half a minute.

## 2. Driving
- [ ] Pull away, brake, a tight corner, reverse (hold brake at standstill), a jump (Space).
- [ ] The car sits on the road: shadow touches all four tyres, body leans outward in a corner.
- [ ] Scrape along a building wall: the car slides along it and does not get stuck.
- [ ] Hard braking leaves marks that fade; an ordinary corner leaves none.
- [ ] Blinkers come on only in a real turn.

## 3. Screen while driving
- [ ] Only the round map with speed and street name, and the credit line, are on screen.
- [ ] A street-name plate appears after turning onto a main road, and not too often.

## 4. Menu (Esc)
- [ ] The game slows to a stop and blurs, then the list appears; Esc closes it quickly.
- [ ] Einstellungen: change each row once (Stimmung, Fahrzeug, Blinker, Tempo, Hindernisse,
      Detail, Kamera). Reload: choices are kept, Hindernisse is off again.
- [ ] "Auf Standard zurücksetzen" brings the defaults back and keeps the bear count.
- [ ] Steuerung and Info open; Info lists the data sources.
- [ ] "Zum Start" (also key R): back at the start, bear count unchanged.
- [ ] "Neustart" asks first; after "Ja" the count is 0 / 19.

## 5. Map
- [ ] N or "Karte": dark map centred on the car, street names readable, nothing but the car on it.
- [ ] Drag, wheel zoom, the + / − and re-centre buttons, close with Esc.
- [ ] Press an arrow key on the map: the car drives. Close the map: you are where you drove to.

## 6. Places (each link once)
- [ ] `?spot=sbahn-friedrichstrasse` — green light at the station; driving in puts you on the tracks; G or the bear button takes you off.
- [ ] `?spot=bundestag-dach` — green lift platform takes you up; falling off puts you back on the roof at its start.
- [ ] `?spot=weltballon` — balloon lifts off a few seconds after you arrive; its shadow slides away and fades; the cable can be cut once it is up.
- [ ] `?spot=lola` — figure at the red house, fountain, bear.
- [ ] `?spot=baer-maura` — green frame at the passage; it disappears once the bear is found.
- [ ] `?spot=checkpoint` — the four figures in front of the guard hut, off the lanes.
- [ ] `?spot=berlinale` — straight carpet, level banner, gold bear.
- [ ] `?spot=nabu` — stork's nest on the roof.
- [ ] `?spot=schuldenuhr` — red digits counting up.
- [ ] Mauerstraße window: `berlinDrive.teleport(-415.0, 1654.0, -0.543)` in the console — a man with binoculars is visible.
- [ ] The memorial: driving onto the field of stelae shows "Respect is Everything."
- [ ] Monbijou bridge: cross from Am Kupfergraben to the Bode-Museum and back.

## 7. One mood
- [ ] Einstellungen → Stimmung → Mond: the page reloads at the same place and looks right.

## Notes
(what was broken, and where)

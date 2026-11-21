// Street plate (file name kept: areasign.js, berlinDrive.areaSign): when the car has turned onto a
// new street, a Berlin street-name plate (white enamel, thin black frame line set in from the
// edge, rounded corners, tall black condensed lettering in mixed case) fades in top centre, stays
// ~4 s and fades out. The one deliberate note in the otherwise quiet game; calm by design so it
// never gets on the player's nerves (owner, 2026-11-21: street names instead of quarters).
// Not clickable.
//
// Street = the minimap's lookup (js/minimap.js `street` / `streetKind`, ~4 Hz from map.json),
// handed in by index.html as update(..., { name, kind, kmh }). No second lookup here.
// When it shows (numbers in opts):
//   - only named streets of opts.major / opts.minor classes (no service ways, paths, steps ...);
//   - the car has been on that street for opts.dwell s of driving faster than opts.minKmh
//     (standing still pauses the count, another name restarts it: junctions, cut corners and a
//     flickering lookup never reach it);
//   - at most one plate per opts.minGap s; the same name not again within opts.repeatGap s;
//     a minor (residential ...) street only if no plate showed for opts.minorGap s;
//   - never during rescue / S-Bahn / roof / tunnel / balloon sequences / edge turns (busy), while
//     the game is paused (index.html does not call update then) or the loading screen is up
//     (`intro.open`); a candidate blocked by any rule is dropped, not queued (state().last says why);
//   - once at the start: opts.startDelay s after the loading screen has gone, the street the car
//     starts on (named, either class), if one is found within opts.startWindow s.
// Long names: the type shrinks down to opts.minScale before the plate truncates (ellipsis).
// state().area = "Berlin-<Ortsteil>" (districtAt, areas.json) for the menu header; the loading
// screen names the starting Ortsteil the same way. No skip logic between the two any more.
//
// Font: family "BerlinSign" = D-DIN Condensed Bold (assets/fonts/, SIL OFL 1.1, weight 700; the
// plates ask for 700 so nothing is synthesised), fallback "Liberation Sans Narrow", "Arial Narrow",
// sans-serif. ensureSignFont() declares the @font-face once (the loading screen calls it first,
// at page start; menu and area sign call it too) and starts the download. FONT_URL is relative to
// the page, so it works from a sub-path (GitHub Pages). Covers ß, ä, ö, ü, hyphen, en dash,
// apostrophe (checked against areas.json and map.json place names, 2026-11-21).
// Shared plate look: PLATE_CSS (.bplate, size from --ph = plate height). The title "Driving Berlin"
// (loading screen, menu) is plain lettering in the same font (js/loading.js, js/menu.js).
//
// berlinDrive.areaSign = { show(name), opts, state() }.

const FONT_URL = 'assets/fonts/D-DINCondensed-Bold.woff2';   // D-DIN Condensed Bold, (C) 2017 Datto Inc., SIL OFL 1.1 (assets/fonts/OFL-1.1.txt)
const ORT_FONT_URL = 'assets/fonts/D-DIN-Bold.woff2';        // D-DIN Bold (regular width), same licence: the yellow place-name sign only

export const AREA_SIGN = {
  dwell: 6,          // s on the new street, driving > minKmh, before its plate shows
  minKmh: 10,        // km/h: below this the dwell count waits
  minGap: 90,        // s, at most one plate per this
  repeatGap: 600,    // s, the same street name not again within this
  minorGap: 180,     // s, a minor street only if no plate showed for this long
  major: ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'],   // = the classes the map draws as major
  minor: ['tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'pedestrian'],
  startDelay: 1.5,   // s after the loading screen has gone
  startWindow: 8,    // s: no named street by then = no start plate
  minScale: 0.8,     // long names: type down to this x before the ellipsis
  nearM: 600,        // m, locateArea() only (quarter points; no longer shown)
  fadeIn: 0.4,       // s
  hold: 4,           // s fully visible
  fadeOut: 0.8,      // s
  checkEvery: 0.25,  // s between area lookups
};

// the plate (class .bplate): white enamel, a thin black line set in from the edge, clearly rounded
// corners, tall tight black condensed lettering (~70 % of the plate height), mixed case.
// --ph = plate height; at 34 px: 24 px type, frame 1.5 px set in 3 px, corners 6 px.
export const PLATE_CSS = `
.bplate { --ph: 34px; position: relative; display: inline-block; box-sizing: border-box; max-width: 100%;
  height: var(--ph); line-height: var(--ph); padding: 0 0.55em; border-radius: calc(var(--ph) * 0.17);
  background: #fff; color: #000; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25), 0 3px 8px rgba(0, 0, 0, 0.38);
  font-family: "BerlinSign", "Liberation Sans Narrow", "Arial Narrow", sans-serif; font-stretch: condensed;
  font-size: calc(var(--ph) * 0.7); font-weight: 700; letter-spacing: -0.005em; font-synthesis: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.bplate::after { content: ""; position: absolute; inset: calc(var(--ph) * 0.09); border: max(1px, calc(var(--ph) * 0.045)) solid #000;
  border-radius: calc(var(--ph) * 0.1); pointer-events: none; }
.bplate.small { --ph: 26px; }`;

// the sign font, declared once for every user (loading screen, menu, area sign)
export function ensureSignFont() {
  if (!FONT_URL || typeof document === 'undefined' || document.getElementById('bdSignFont')) return;
  const st = document.createElement('style');
  st.id = 'bdSignFont';
  st.textContent = `@font-face { font-family: "BerlinSign"; src: url("${FONT_URL}") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: "BerlinOrt"; src: url("${ORT_FONT_URL}") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }`;
  document.head.appendChild(st);
  try {
    document.fonts?.load('700 24px "BerlinSign"').catch(() => {});
    document.fonts?.load('700 24px "BerlinOrt"').catch(() => {});
  } catch { /* old browser: loads on first use */ }
}

// the yellow place-name sign (Ortstafel layout, our own drawing): traffic yellow #EBA400, a black
// frame line (2 % of the width) set in 2.5 %, rounded corners (4 %), black bold DIN lettering
// (D-DIN Bold, "BerlinOrt"), "Berlin" large (cap height 26 % of the height, ~62 % of the width) and
// the Ortsteil below at 45 % of that size; outside every Ortsteil only "Berlin", centred.
// --oh = sign height, width = 1.54 x. Used on the loading screen and in the menu header.
export const ORT_CSS = `
.ortsign { --oh: 120px; position: relative; display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  box-sizing: border-box; height: var(--oh); width: calc(var(--oh) * 1.54); padding: 0 calc(var(--oh) * 0.13);
  gap: calc(var(--oh) * 0.07); background: #eba400; color: #000; border-radius: calc(var(--oh) * 0.062);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
  font-family: "BerlinOrt", "DIN Alternate", "Arial", sans-serif; font-weight: 700; font-synthesis: none; text-align: center; }
.ortsign::after { content: ""; position: absolute; inset: calc(var(--oh) * 0.0385); border: max(1px, calc(var(--oh) * 0.031)) solid #000;
  border-radius: calc(var(--oh) * 0.03); pointer-events: none; }
.ortsign span { display: block; white-space: nowrap; line-height: 1; }
.ortsign .o1 { font-size: calc(var(--oh) * 0.377); letter-spacing: 0; }
.ortsign .o2 { font-size: calc(var(--oh) * 0.17); }`;
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// "Berlin-Mitte" -> two lines "Berlin" / "Mitte"; "Berlin" -> one line
export function ortSignHtml(name) {
  const n = String(name || 'Berlin'), m = /^Berlin-(.+)$/.exec(n);
  const [a, b] = m ? ['Berlin', m[1]] : [n, ''];
  return `<span class="o1">${escHtml(a)}</span>${b ? `<span class="o2">${escHtml(b)}</span>` : ''}`;
}
// long second lines shrink to fit inside the frame (never truncated); again once the fonts are in
export function fitOrtSign(el) {
  if (!el) return;
  const fit = () => {
    for (const s of el.querySelectorAll('span')) {
      s.style.fontSize = '';
      const room = el.clientWidth - 2 * parseFloat(getComputedStyle(el).paddingLeft || 0), w = s.scrollWidth;
      if (room > 0 && w > room) s.style.fontSize = (parseFloat(getComputedStyle(s).fontSize) * room / w * 0.98).toFixed(2) + 'px';
    }
  };
  fit();
  try { document.fonts?.ready.then(fit); } catch { /* no font API */ }
}

// area sign: position + show / hide on top of the shared plate look (.bplate)
const CSS = `
#areasign { --ph: 46px; position: absolute; left: 50%; top: calc(var(--toprow, 42px) + 10px); z-index: 1001;
  transform: translateX(-50%); pointer-events: none; opacity: 0; visibility: hidden;
  max-width: min(520px, calc(100vw - 32px)); display: block; }
#areasign.on { opacity: 1; visibility: visible; }
body.touch #areasign { --ph: 34px; }
@media (max-width: 599px) { #areasign { --ph: 34px; } }`;

// even-odd over flat rings [[x0, z0, x1, z1, ...], ...]
function inside(rings, x, z) {
  let c = false;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
  }
  return c;
}

// areas.json lookup: { o: Ortsteil or null, name: nearest quarter of that Ortsteil within nearM, else the Ortsteil }
export function locateArea(areas, x, z, nearM = AREA_SIGN.nearM) {
  const o = areas?.ortsteile?.find((a) => inside(a.rings, x, z));
  if (!o) return { o: null, name: null };
  let best = null, bd = nearM * nearM;
  for (const q of areas.quarters || []) {
    if (q.in !== o.name) continue;
    const d = (q.x - x) ** 2 + (q.z - z) ** 2;
    if (d <= bd) { bd = d; best = q.name; }
  }
  return { o: o.name, name: best || o.name };
}

// the plate on the loading screen and in the menu header: "Berlin-<Ortsteil>" (owner, 2026-11-21:
// "Du betrittst Berlin-Mitte"), "Berlin" outside every Ortsteil polygon; the historic quarter
// points in areas.json are no longer shown anywhere (data kept)
export function districtAt(areas, x, z) {
  const o = areas?.ortsteile?.find((a) => inside(a.rings, x, z));
  return o ? 'Berlin-' + o.name : 'Berlin';
}

export function createAreaSign({ base, intro }) {
  const opts = { ...AREA_SIGN };
  const style = document.createElement('style');
  ensureSignFont();
  style.textContent = PLATE_CSS + CSS;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'areasign'; el.className = 'bplate';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);

  let areas = null;   // the Ortsteil for state().area (menu header); the street plate itself needs no areas.json
  fetch(base + 'areas.json').then((r) => (r.ok ? r.json() : null)).then((a) => { areas = a; }).catch(() => { /* no areas */ });

  let clock = 0, checkT = 0, current = null, ortsteil = null;
  let cand = '', candKind = '', candT = 0, committed = '', started = false, startT = -1;
  let lastShow = -Infinity, shown = null, hideTimer = 0, offTimer = 0, why = 'waiting';
  let last = null;   // last decision: { name, kind, shown, reason, at }
  const seen = new Map();   // name -> clock of its last plate

  const locate = (x, z) => locateArea(areas, x, z, opts.nearM);

  // keep clear of the round map when it sits at the top (touch): narrower, or below it
  function place() {
    el.style.top = ''; el.style.maxWidth = '';
    const mm = document.getElementById('mm');
    if (!mm || !document.body.classList.contains('touch')) return;
    const m = mm.getBoundingClientRect(), s = el.getBoundingClientRect();
    if (!m.width || m.top > s.bottom + 4 || m.bottom < s.top - 4) return;   // not beside the plate
    const room = innerWidth - 2 * (m.right + 10);
    if (room >= 140) el.style.maxWidth = room + 'px';
    else el.style.top = (m.bottom + 10) + 'px';
  }

  function show(name) {
    if (!name) return false;
    name = String(name);
    clearTimeout(hideTimer); clearTimeout(offTimer);
    el.textContent = name;
    el.style.transition = 'none';
    el.classList.add('on'); el.style.opacity = '0';   // measurable for place(), still invisible
    place();
    el.style.fontSize = '';   // long names: smaller type first, ellipsis only below minScale
    const over = el.scrollWidth / Math.max(1, el.clientWidth);
    if (over > 1.001) el.style.fontSize = `calc(var(--ph) * ${(0.7 * Math.max(opts.minScale, 1 / over)).toFixed(3)})`;
    void el.offsetWidth;
    el.style.opacity = '';
    el.style.transition = `opacity ${opts.fadeIn}s ease-out, visibility 0s`;
    shown = name; lastShow = clock; seen.set(name, clock);
    hideTimer = setTimeout(() => {
      el.style.transition = `opacity ${opts.fadeOut}s ease-in, visibility 0s linear ${opts.fadeOut}s`;
      el.classList.remove('on');
      offTimer = setTimeout(() => { shown = null; }, opts.fadeOut * 1000);
    }, (opts.fadeIn + opts.hold) * 1000);
    return true;
  }

  const klass = (k) => (opts.major.includes(k) ? 'major' : opts.minor.includes(k) ? 'minor' : null);
  // the rules for a street that has just been committed (dwell done); returns the reason or ''
  function blocked(name, kind) {
    const s = seen.get(name), since = clock - lastShow;
    if (s !== undefined && clock - s < opts.repeatGap) return 'same name within repeatGap';
    if (since < opts.minGap) return 'minGap';
    if (kind === 'minor' && since < opts.minorGap) return 'minor street within minorGap';
    return '';
  }
  function decide(name, kind, start = false) {
    const k = klass(kind);
    const reason = !k ? 'not a street class that gets a plate (' + (kind || 'none') + ')' : start ? '' : blocked(name, k);
    last = { name, kind, shown: !reason, reason: reason || (start ? 'start' : 'ok'), at: +clock.toFixed(1) };
    if (!reason) show(name);
  }

  // per frame: car position (level x, z), busy = a scripted sequence runs, ready = spawn view loaded,
  // street = { name, kind, kmh } from the minimap's lookup (index.html)
  function update(dt, x, z, busy, ready, street = null) {
    dt = Math.min(dt, 0.25);
    clock += dt;
    if (areas && (checkT -= dt) <= 0) {   // the Ortsteil, for the menu header (state().area)
      checkT = opts.checkEvery;
      current = districtAt(areas, x, z); ortsteil = locate(x, z).o;
    }
    const name = street?.name || '', kind = street?.kind || '', kmh = Math.abs(+street?.kmh || 0);
    const quiet = busy || !ready || !!intro?.open;
    if (!started) {   // the start plate, once
      if (quiet) { startT = -1; why = 'start: waiting for the loading screen / sequence'; return; }
      if (startT < 0) startT = clock;
      if (clock - startT < opts.startDelay) { why = 'start: delay'; return; }
      if (name && klass(kind)) { started = true; committed = cand = name; candKind = kind; candT = 0; decide(name, kind, true); why = 'start plate'; return; }
      if (clock - startT > opts.startDelay + opts.startWindow) { started = true; committed = cand = name; candKind = kind; why = 'start: no named street, skipped'; }
      else why = 'start: no named street yet';
      return;
    }
    if (name !== cand) { cand = name; candKind = kind; candT = 0; }
    if (quiet) { candT = 0; why = 'quiet (sequence / loading)'; return; }
    if (!cand) { why = 'no street name'; return; }
    if (cand === committed) { why = 'same street as the last one committed'; return; }
    if (kmh > opts.minKmh) candT += dt;
    why = kmh > opts.minKmh ? 'dwell' : 'dwell paused (slow)';
    if (candT >= opts.dwell) { committed = cand; decide(cand, candKind); why = last.reason; }
  }

  return {
    update, show, opts,
    state() {
      return { area: current, ortsteil, candidate: cand, candidateKind: candKind, candidateClass: klass(candKind),
        candidateT: +candT.toFixed(2), committed, why, last, started, shown,
        sinceLast: lastShow === -Infinity ? null : +(clock - lastShow).toFixed(1),
        seen: Object.fromEntries([...seen].map(([k, v]) => [k, +(clock - v).toFixed(1)])) };
    },
  };
}

// Minimap HUD (bottom left): round north-up map around the car with an "N" on the rim, and a
// text column right of the disc (speed "50 km/h" plain, street name on a small navy pill). No panel, no other
// lettering on the HUD (quiet game). Overview (N, "Karte" in the Esc menu): a full-screen dark street map
// centred on the car (drag = pan, wheel / pinch / + - = zoom, re-centre, close), street names along the
// streets, quarter names in spaced capitals, and nothing but the car (arrow + soft view cone): no bears,
// pitches, goals, station doors or hints. It has the coordinates (click = copy) and the disc hide control.
// The HUD disc keeps its own grey palette (C); the overview has its own dark one (D). Of the marker groups
// (setMarkers / setMarkerGroup, still the API for js/eggs.js and js/sbahn.js) only the green station-door
// dots (kind 'lift') are drawn, on the disc only - no easter egg is given away anywhere.
// onOverview(on): called when the overview opens / closes (index.html pauses the game meanwhile).
//
// Data: levels/<name>/map.json (build_map.py: OSM roads with name + class, rail, water,
// parks, building footprints, places), loaded lazily. Without it the panel still shows
// the car on the level's water mask (isWater) and LoD2 walls when the level has them.
// Cheap: the static map is drawn once into 256 px tiles (LRU), per update only the
// tiles are blitted and the arrow drawn, throttled to ~15 Hz. The street name lookup
// (segment grid) runs at ~4 Hz.
//
//   const mm = createMinimap({ level, base, isWater });
//   mm.update(x, z, heading, kmh, showKmh = true)   // once per frame; heading clockwise from north;
//                                     // showKmh false = speed line empty (rescue / S-Bahn / roof, loading)
//   N or a click on the disc: the overview; N / Esc / the close button closes it.
//   The disc symbol in the overview's top-right corner hides the disc (localStorage
//   berlinDrive.minimap); a small round button bottom left brings it back. Speed and street
//   lines stay visible while the disc is hidden.
//
// Frame: level x = east, z = -north, so screen x = x, screen y = z gives north-up.

const ROAD_W = { motorway: 16, trunk: 16, primary: 14, secondary: 12, tertiary: 10, unclassified: 7,
  residential: 7, living_street: 5, service: 4.5, motorway_link: 7, trunk_link: 7, primary_link: 7,
  secondary_link: 7, tertiary_link: 7, pedestrian: 5, footway: 2.5, path: 2, cycleway: 2, steps: 2.5,
  track: 3, bridleway: 2 };
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
const FOOT = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'bridleway', 'pedestrian']);
// palette: greyscale except water - grey land, lighter grey streets (one grey for every class,
// wide soft bands), near-black buildings without outlines, flat light-blue water, parks barely
// different from land, rail a thin darker line
const C = { bg: '#474747', out: '#2c2c2c', park: '#414541', water: '#6aa3cc', bldg: '#1b1b1b',
            foot: '#545454', road: '#6b6b6b', rail: '#3a3a3a', border: '#141a2e' };
const WATER_RGB = [0x6a, 0xa3, 0xcc];   // = C.water (fallback water mask, per pixel)
const ARROW = '#46b4e8', ARROW_EDGE = '#0d1626';   // player arrow: cyan, thin dark edge
const RIM = '#141a2e';   // disc rim: thin dark navy ring
// overview palette (dark street map): ground, blocks, streets, main roads (warmer, wider), water, parks, labels
const D = { out: '#0f1012', bg: '#17181b', park: '#1c211f', water: '#16303a', bldg: '#222429', foot: '#25272c',
            road: '#3a3d44', major: '#4d4a45', rail: '#2a2c31', label: '#c3c6cb', major_label: '#d6d2cb', halo: '#17181b',
            quarter: '#8f939a', edge: '#30333a', cone: '70, 180, 232' };
const OV_LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8];   // overview tile scales (CSS px per metre)
const OV_MAX = 8, OV_START = 1.4;                    // zoom-in limit, opening zoom (street level)
const LABEL_MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const LABEL_MINOR = new Set(['residential', 'unclassified', 'living_street', 'pedestrian']);
const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M12 5 V19 M5 12 H19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const MINUS_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M5 12 H19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ME_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2.5 V5.5 M12 18.5 V21.5 M2.5 12 H5.5 M18.5 12 H21.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_MAP = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 5.5 L15 13.5 L12 12 L9 13.5 Z" fill="currentColor"/></svg>';
const SVG_HIDE = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 19 L19 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const TILE_PX = 256;
const ZOOMS = [0.6, 0.9, 1.3, 2, 3];   // metres per CSS pixel
const HZ = 15, NAME_HZ = 4;

// level (x, z) -> WGS84, exact inverse of build_level.py / build_stream.py to_en():
// en = R(lat0, lon0) . (ecef(lat, lon, 0) - ecef(lat0, lon0, 0)), x = e, z = -n.
// Newton-style fixed point on to_en (3 steps: well below a millimetre in a 5 km level).
const WGS_A = 6378137.0, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F), D2R = Math.PI / 180;
function geoToEcef(lat, lon) {
  const la = lat * D2R, lo = lon * D2R, N = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(la) ** 2);
  return [N * Math.cos(la) * Math.cos(lo), N * Math.cos(la) * Math.sin(lo), N * (1 - WGS_E2) * Math.sin(la)];
}
export function makeGeo(origin) {
  const lat0 = origin.lat, lon0 = origin.lon, o = geoToEcef(lat0, lon0);
  const sla = Math.sin(lat0 * D2R), cla = Math.cos(lat0 * D2R), slo = Math.sin(lon0 * D2R), clo = Math.cos(lon0 * D2R);
  const toEn = (lat, lon) => {
    const p = geoToEcef(lat, lon), d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [-slo * d[0] + clo * d[1], -sla * clo * d[0] - sla * slo * d[1] + cla * d[2]];
  };
  const kLon = 111320 * cla, kLat = 111132;
  return function toLatLon(x, z) {
    const E = x, Nn = -z;
    let lon = lon0 + E / kLon, lat = lat0 + Nn / kLat;
    for (let i = 0; i < 3; i++) { const [e, n] = toEn(lat, lon); lon += (E - e) / kLon; lat += (Nn - n) / kLat; }
    return { lat, lon };
  };
}
const fmtLatLon = ({ lat, lon }) => `${Math.abs(lat).toFixed(5)}\u00b0 ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}\u00b0 ${lon >= 0 ? 'E' : 'W'}`;

export function createMinimap({ level, base, isWater = null, onOverview = null, parent = document.body }) {
  const ex = level.extent;
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  // ---------- DOM ----------
  const css = document.createElement('style');
  css.textContent = `
  #mm { position: absolute; left: 14px; bottom: 20px; z-index: 1000; --mmd: 150px; display: flex; align-items: flex-start; gap: 12px;
        pointer-events: none; font-family: "Lato", "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
  #mm .mmdisc { position: relative; flex: none; width: var(--mmd); height: var(--mmd); }
  #mm canvas { display: block; width: 100%; height: 100%; border-radius: 50%; clip-path: circle(50%); pointer-events: auto; cursor: zoom-in; }
  #mm .mmn { position: absolute; left: 50%; top: 1px; transform: translate(-50%, -50%); pointer-events: none;
             color: #fff; font-size: 15px; font-weight: 700; line-height: 1;
             text-shadow: -1.5px 0 ${RIM}, 1.5px 0 ${RIM}, 0 -1.5px ${RIM}, 0 1.5px ${RIM},
                          -1px -1px ${RIM}, 1px -1px ${RIM}, -1px 1px ${RIM}, 1px 1px ${RIM}; }
  /* text column, starting a little below the disc's middle: speed (plain), street name on a navy pill */
  #mm .mmtxt { margin-top: calc(var(--mmd) * 0.54); color: #fff; pointer-events: none; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
  #mm .mmspd { font-size: 19px; font-weight: 400; line-height: 23px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  #mm .mmstreet { display: block; width: fit-content; max-width: min(220px, 40vw); box-sizing: border-box; margin-top: 4px;
                 padding: 2px 8px 3px; border-radius: 4px; background: rgba(20, 26, 46, 0.78); color: #f2f6fa; text-shadow: none;
                 font-size: 13px; font-weight: 400; line-height: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #mm .mmstreet:empty { display: none; }
  #mm.off { align-items: center; }
  #mm.off .mmtxt { margin-top: 0; }
  #mm.off .mmdisc { display: none; }
  #mmshow { display: none; flex: none; cursor: pointer; pointer-events: auto; width: 34px; height: 34px; padding: 6px; box-sizing: border-box;
            border-radius: 50%; color: #fff; background: rgba(20, 26, 46, 0.75); border: 1px solid rgba(255, 255, 255, 0.45); }
  #mmshow:hover { background: rgba(20, 26, 46, 0.95); }
  #mm.off #mmshow { display: block; }
  #mmov { position: absolute; inset: 0; z-index: 2600; display: none; background: ${D.out}; touch-action: none;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #mmov.on { display: block; }
  #mmov canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; cursor: grab; touch-action: none; }
  #mmov canvas.drag { cursor: grabbing; }
  #mmov .ovb { position: absolute; width: 44px; height: 44px; padding: 11px; box-sizing: border-box; cursor: pointer;
               border-radius: 50%; color: #e8e8e8; background: rgba(23, 24, 27, 0.88); border: 1px solid rgba(255, 255, 255, 0.28);
               -webkit-tap-highlight-color: transparent; }
  #mmov .ovb:hover, #mmov .ovb:focus-visible { background: rgba(60, 62, 68, 0.95); color: #fff; outline: none; }
  #mmov .ovclose { right: 14px; top: 14px; }
  #mmov .mmtog { right: 68px; top: 14px; }
  #mmov .ovzoom { position: absolute; right: 14px; bottom: 18px; display: flex; flex-direction: column; gap: 8px; }
  #mmov .ovzoom .ovb { position: static; }
  #mmov .mmll { position: absolute; left: 12px; bottom: 30px; font: 12px ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums;
                color: #bfc2c7; white-space: nowrap; cursor: copy; padding: 3px 6px; border-radius: 4px; background: rgba(23, 24, 27, 0.8); }
  #mmov .mmll:hover { color: #fff; background: rgba(40, 42, 47, 0.95); }
  #mmov .ovspd { position: absolute; left: 16px; top: 14px; display: none; color: #fff; font-size: 19px; line-height: 23px;
                 font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
  #mmov.driving .ovspd { display: block; }
  #mmov .ovattr { position: absolute; left: 12px; bottom: 8px; font-size: 11px; color: #7d8187; pointer-events: none; }
  `;
  document.head.appendChild(css);
  const root = document.createElement('div'); root.id = 'mm';
  root.innerHTML = `<div class="mmdisc"><canvas></canvas><div class="mmn">N</div></div>
    <div id="mmshow" title="show minimap">${SVG_MAP}</div>
    <div class="mmtxt"><div class="mmspd"></div><div class="mmstreet"></div></div>`;
  parent.appendChild(root);
  const ov = document.createElement('div'); ov.id = 'mmov';
  ov.innerHTML = `<canvas></canvas>
    <button type="button" class="ovb ovclose" title="Karte schließen (N, Esc)" aria-label="Karte schließen">${CLOSE_SVG}</button>
    <button type="button" class="ovb mmtog"></button>
    <div class="ovzoom"><button type="button" class="ovb" data-z="in" title="näher" aria-label="näher">${PLUS_SVG}</button>
      <button type="button" class="ovb" data-z="out" title="weiter weg" aria-label="weiter weg">${MINUS_SVG}</button>
      <button type="button" class="ovb" data-z="me" title="zum Auto" aria-label="zum Auto">${ME_SVG}</button></div>
    <div class="mmll" title="WGS84 - Klick kopiert Breite, Länge"></div>
    <div class="ovspd"></div>
    <div class="ovattr">&copy; OpenStreetMap-Mitwirkende</div>`;
  parent.appendChild(ov);
  const cv = root.querySelector('canvas'), ctx = cv.getContext('2d');
  const spdEl = root.querySelector('.mmspd'), streetEl = root.querySelector('.mmstreet');
  const llEl = ov.querySelector('.mmll'), togEl = ov.querySelector('.mmtog');
  const toLatLon = makeGeo(level.origin);
  llEl.addEventListener('click', (e) => {
    e.stopPropagation();   // a click on the coordinates copies, it does not close the overview
    const { lat, lon } = toLatLon(lastPos.x, lastPos.z);
    try { navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`).catch(() => {}); } catch { /* no clipboard */ }
  });
  const ovCv = ov.querySelector('canvas'), ovG = ovCv.getContext('2d');

  // per-frame state (declared before the handlers below use it)
  let last = 0, ovOn = false, lastPos = { x: level.spawn?.x ?? 0, z: level.spawn?.z ?? 0, h: 0, v: 0 };
  const ovV = { x: lastPos.x, z: lastPos.z, s: OV_START };   // overview view: centre (level x, z), CSS px per metre
  let curName = -1, curKind = '', nameT = 0, nearTxt = '', spdTxt = '';
  let on = store.get('berlinDrive.minimap') !== '0';
  let zoomI = Math.min(ZOOMS.length - 1, Math.max(0, +(store.get('berlinDrive.minimapZoom') ?? 2) | 0));
  const setOn = (v) => {
    on = !!v; root.classList.toggle('off', !on); store.set('berlinDrive.minimap', on ? '1' : '0'); last = 0;
    togEl.innerHTML = on ? SVG_HIDE : SVG_MAP; togEl.title = on ? 'kleine Karte ausblenden' : 'kleine Karte zeigen';
  };
  setOn(on);
  togEl.addEventListener('click', (e) => { e.stopPropagation(); setOn(!on); });
  root.querySelector('#mmshow').addEventListener('click', () => setOn(true));
  cv.addEventListener('click', () => setOverview(true));
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomI = Math.min(ZOOMS.length - 1, Math.max(0, zoomI + (e.deltaY > 0 ? 1 : -1)));
    store.set('berlinDrive.minimapZoom', String(zoomI)); last = 0;
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
    if (e.key === 'n' || e.key === 'N') setOverview(!ovOn);
    else if (e.key === 'Escape' && ovOn) setOverview(false);
  });

  // ---------- data ----------
  let map = null, feats = null, segGrid = null;
  const SEG_CELL = 40;
  function prepare(m) {
    // per-feature bbox for the tile renderer; road segment grid for the name lookup
    const bb = (f) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (let i = 0; i < f.length; i += 2) { const x = f[i], z = f[i + 1]; if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z; }
      return [a, b, c, d]; };
    const areas = (list) => list.map((rings) => ({ rings, bb: rings.map(bb).reduce((p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])]) }));
    feats = {
      water: areas(m.water || []), parks: areas(m.parks || []),
      buildings: (m.buildings || []).map((p) => ({ p, bb: bb(p) })),
      rail: (m.rail || []).map(([k, p]) => ({ k, p, bb: bb(p) })),
      roads: (m.roads || []).map(([k, n, tun, p]) => ({ k, n, tun, p, bb: bb(p) })),
    };
    segGrid = new Map();
    for (const r of feats.roads) {
      if (r.n < 0) continue;
      const p = r.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x0 = Math.floor(Math.min(p[i], p[i + 2]) / SEG_CELL), x1 = Math.floor(Math.max(p[i], p[i + 2]) / SEG_CELL);
        const z0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / SEG_CELL), z1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / SEG_CELL);
        for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) {
          const k = a + ',' + b; let l = segGrid.get(k); if (!l) segGrid.set(k, l = []);
          l.push(r, i);
        }
      }
    }
  }
  const loaded = fetch(base + 'map.json').then((r) => (r.ok ? r.json() : null)).then((m) => {
    if (!m) return false;
    map = m; prepare(m); tiles.clear(); ovTiles.clear(); labelCache.clear(); last = 0; nameT = 0; if (ovOn) ovRequest();
    const cr = document.getElementById('credit');   // level attribution line
    if (cr && !/map: ©/.test(cr.textContent)) cr.textContent += '; map: © OpenStreetMap contributors';
    return true;
  }).catch(() => false);   // no map.json: plain panel with water + walls

  // ---------- static layer renderer (tiles and overview) ----------
  const hit = (bb, x0, z0, x1, z1) => bb[2] >= x0 && bb[0] <= x1 && bb[3] >= z0 && bb[1] <= z1;
  function path(g, p, close) {
    g.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
    if (close) g.closePath();
  }
  // draw the static map for world box (x0, z0)-(x1, z1) into g at s px per metre
  function drawStatic(g, x0, z0, x1, z1, s, wpx, hpx, overview = false) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.out; g.fillRect(0, 0, wpx, hpx);
    g.setTransform(s, 0, 0, s, -x0 * s, -z0 * s);
    g.fillStyle = C.bg; g.fillRect(ex.minX, ex.minZ, ex.maxX - ex.minX, ex.maxZ - ex.minZ);
    const px = 1 / s;   // one pixel in metres
    if (feats) {
      const fillAreas = (list, col) => {
        g.fillStyle = col;
        for (const a of list) {
          if (!hit(a.bb, x0, z0, x1, z1)) continue;
          g.beginPath(); for (const r of a.rings) path(g, r, true); g.fill('evenodd');
        }
      };
      fillAreas(feats.parks, C.park);
      fillAreas(feats.water, C.water);
      if (s > 0.25) {
        g.fillStyle = C.bldg; g.beginPath();
        for (const b of feats.buildings) if (hit(b.bb, x0, z0, x1, z1)) path(g, b.p, true);
        g.fill();
        // no outlines: a stroke in the fill colour only rounds the corners (soft blocks)
        if (s > 0.6) { g.lineJoin = 'round'; g.strokeStyle = C.bldg; g.lineWidth = 1.2; g.stroke(); }
      }
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = C.rail; g.lineWidth = Math.max(1, 1.5 * s) * px;
      g.beginPath(); for (const r of feats.rail) if (hit(r.bb, x0, z0, x1, z1)) path(g, r.p, false); g.stroke();
      g.setLineDash([]);
      // roads come sorted (tunnels first, then footways ... motorways): batch by style
      let style = null;
      const flush = () => { if (style) g.stroke(); style = null; };
      for (const r of feats.roads) {
        if (!hit(r.bb, x0, z0, x1, z1)) continue;
        const foot = FOOT.has(r.k);
        if (foot && overview && r.k !== 'pedestrian') continue;
        const col = foot && r.k !== 'pedestrian' ? C.foot : C.road;   // one grey for every street class
        const w = Math.max((ROAD_W[r.k] || 4) * (foot ? 0.6 : 1.15), (foot ? 0.8 : MAJOR.has(r.k) ? 2.2 : 1.6) * px);
        const key = col + w + r.tun;
        if (key !== style) {
          flush(); style = key; g.beginPath();
          g.strokeStyle = col; g.lineWidth = w; g.globalAlpha = r.tun ? 0.35 : 1;
          g.setLineDash(r.tun ? [6 * px, 4 * px] : []);
        }
        path(g, r.p, false);
      }
      flush(); g.globalAlpha = 1; g.setLineDash([]);
    } else {
      if (isWater) {   // fallback: the level's water mask, sampled per pixel
        g.setTransform(1, 0, 0, 1, 0, 0);
        const img = g.getImageData(0, 0, wpx, hpx), d = img.data;
        for (let j = 0; j < hpx; j++) for (let i = 0; i < wpx; i++) {
          if (!isWater(x0 + (i + 0.5) / s, z0 + (j + 0.5) / s)) continue;
          const o = 4 * (j * wpx + i); d[o] = WATER_RGB[0]; d[o + 1] = WATER_RGB[1]; d[o + 2] = WATER_RGB[2];
        }
        g.putImageData(img, 0, 0);
        g.setTransform(s, 0, 0, s, -x0 * s, -z0 * s);
      }
      if (level.walls?.length) {
        g.fillStyle = C.bldg; g.beginPath();
        for (const loop of level.walls) { g.moveTo(loop[0][0], loop[0][1]); for (const [x, z] of loop) g.lineTo(x, z); g.closePath(); }
        g.fill('evenodd');
      }
    }
    g.strokeStyle = C.border; g.lineWidth = 1.5 * px;
    g.strokeRect(ex.minX, ex.minZ, ex.maxX - ex.minX, ex.maxZ - ex.minZ);
  }

  // tiles: key zoom/i/j -> canvas, LRU
  const tiles = new Map();
  function tile(s, i, j, allowNew) {
    const key = s + '/' + i + '/' + j;
    let t = tiles.get(key);
    if (t) { tiles.delete(key); tiles.set(key, t); return t; }
    if (!allowNew) return null;
    t = document.createElement('canvas'); t.width = t.height = TILE_PX;
    const m = TILE_PX / s;
    drawStatic(t.getContext('2d'), i * m, j * m, (i + 1) * m, (j + 1) * m, s, TILE_PX, TILE_PX);
    tiles.set(key, t);
    while (tiles.size > 30) tiles.delete(tiles.keys().next().value);
    return t;
  }

  // ---------- street name lookup ----------
  function lookupName(x, z, h, kmh) {
    if (!segGrid) return;
    const ci = Math.floor(x / SEG_CELL), cj = Math.floor(z / SEG_CELL), MAXD = 25;
    const fx = Math.sin(h), fz = -Math.cos(h), moving = kmh > 8;
    let best = -1, bs = Infinity, curS = Infinity, bestK = '';
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
      const l = segGrid.get(a + ',' + b); if (!l) continue;
      for (let k = 0; k < l.length; k += 2) {
        const r = l[k], i = l[k + 1], p = r.p;
        const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, L2 = dx * dx + dz * dz;
        const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
        const d = Math.hypot(x - ax - u * dx, z - az - u * dz);
        if (d > MAXD) continue;
        // footways / tunnels lose against a street the car can be on; along-heading wins at crossings
        let sc = d + (FOOT.has(r.k) && r.k !== 'pedestrian' ? 10 : 0) + (r.k === 'service' ? 3 : 0) + (r.tun ? 15 : 0);
        if (moving && L2 > 0) sc -= 4 * Math.abs((dx * fx + dz * fz) / Math.sqrt(L2));
        if (sc < bs) { bs = sc; best = r.n; bestK = r.k; }
        if (r.n === curName && sc < curS) curS = sc;
      }
    }
    if (curName >= 0 && curS < bs + 3) best = curName;   // hysteresis: no flicker at crossings
    if (best !== curName) { curName = best; curKind = best >= 0 ? bestK : ''; streetEl.textContent = best >= 0 ? map.names[best] : ''; }
    // nearest landmark within 150 m, nearest quarter / neighbourhood
    let lm = null, ld = 150 * 150, pl = null, pd = Infinity;
    for (const [kind, name, px, pz] of map.places || []) {
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (kind === 'landmark') { if (d < ld) { ld = d; lm = name; } }
      else if (kind !== 'suburb' && d < pd) { pd = d; pl = name; }
    }
    const t = [lm && 'near ' + lm, pl].filter(Boolean).join(' · ');
    nearTxt = t;   // not shown on the HUD (quiet); berlinDrive.minimap.near
  }

  // ---------- markers (setMarkers: other features, e.g. js/eggs.js) ----------
  // {id, kind: bear|ball|goal|pitch|*, x, z, label, found, mode: 'area' + radius (m)}
  // groups: setMarkers(list) = the default group (js/eggs.js), setMarkerGroup(name, list) for other
  // features (js/sbahn.js 'sbahn-lifts'); all groups are drawn. Kind 'lift': a green dot with a white
  // up-arrow, no letter, not in the legend / found count.
  let markers = [];
  const groups = new Map();
  function setMarkerGroup(name, list) {
    groups.set(name, Array.isArray(list) ? list.filter((m) => m && Number.isFinite(+m.x) && Number.isFinite(+m.z)) : []);
    markers = [...groups.values()].flat();
    last = 0;
  }
  const setMarkers = (list) => setMarkerGroup('', list);
  // draw markers into g (the HUD disc only): world (x, z) -> screen via sx(x), sy(z).
  // Owner (2026-11-21): only the station doors (kind 'lift', green dot); bears, pitches, goals and
  // area hints are kept in the groups (API) but never drawn - no easter egg is given away.
  function drawMarkers(g, sx, sy, s, r, W, H) {
    for (const m of markers) {
      const X = sx(+m.x), Y = sy(+m.z);
      if (m.kind === 'lift') {   // station lift: green dot, white up-arrow
        const R = 5.5 * r;
        if (X + R < 0 || Y + R < 0 || X - R > W || Y - R > H) continue;
        g.beginPath(); g.arc(X, Y, R, 0, 2 * Math.PI); g.fillStyle = '#1fbf6a'; g.fill();
        g.lineWidth = 1.2 * r; g.strokeStyle = '#0b3d22'; g.stroke();
        g.beginPath(); g.moveTo(X, Y - 3.4 * r); g.lineTo(X + 3 * r, Y + 0.4 * r); g.lineTo(X + 1.1 * r, Y + 0.4 * r);
        g.lineTo(X + 1.1 * r, Y + 3.2 * r); g.lineTo(X - 1.1 * r, Y + 3.2 * r); g.lineTo(X - 1.1 * r, Y + 0.4 * r); g.lineTo(X - 3 * r, Y + 0.4 * r);
        g.closePath(); g.fillStyle = '#fff'; g.fill();
      }
    }
  }

  // ---------- per-frame ----------
  const dpr = () => Math.min(2, devicePixelRatio || 1);
  function arrow(g, x, y, h, size) {
    g.save(); g.translate(x, y); g.rotate(h);
    g.beginPath(); g.moveTo(0, -size); g.lineTo(size * 0.62, size * 0.75); g.lineTo(0, size * 0.38); g.lineTo(-size * 0.62, size * 0.75); g.closePath();
    g.fillStyle = ARROW; g.fill(); g.lineWidth = Math.max(1, size * 0.12); g.strokeStyle = ARROW_EDGE; g.stroke();
    g.restore();
  }
  function drawMini(x, z, h, kmh) {
    const r = dpr(), wCss = cv.clientWidth || 150, W = Math.round(wCss * r);
    if (cv.width !== W) { cv.width = cv.height = W; }
    // a bit further out at speed (tiles drawn at the base zoom, scaled down on the blit)
    const mpp = ZOOMS[zoomI] * (1 + 0.4 * Math.min(1, Math.max(0, (kmh - 30) / 70)));
    const sTile = r / ZOOMS[zoomI];          // tile px per metre
    const s = r / mpp;                       // screen px per metre
    const tm = TILE_PX / sTile;              // tile size, metres
    const halfM = W / 2 / s, c = W / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, W);   // corners outside the disc stay transparent
    ctx.save(); ctx.beginPath(); ctx.arc(c, c, c, 0, 2 * Math.PI); ctx.clip();
    ctx.fillStyle = C.out; ctx.fillRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = true;
    const i0 = Math.floor((x - halfM) / tm), i1 = Math.floor((x + halfM) / tm);
    const j0 = Math.floor((z - halfM) / tm), j1 = Math.floor((z + halfM) / tm);
    let budget = 3;   // new tiles per update (spreads the cost when the view jumps)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const t = tile(sTile, i, j, budget > 0); if (!tiles.has(sTile + '/' + i + '/' + j)) continue;
      if (t && t.__new !== false) { t.__new = false; budget--; }
      const sx = c + (i * tm - x) * s, sy = c + (j * tm - z) * s, sz = tm * s;
      ctx.drawImage(t, sx, sy, sz + 0.5, sz + 0.5);
    }
    if (markers.length) drawMarkers(ctx, (mx) => c + (mx - x) * s, (mz) => c + (mz - z) * s, s, r, W, W);
    arrow(ctx, c, c, h, 8 * r);
    ctx.restore();
    // rim: a thin dark navy ring, nothing else (the "N" is a DOM letter on top)
    ctx.beginPath(); ctx.arc(c, c, c - 1.5 * r, 0, 2 * Math.PI); ctx.lineWidth = 3 * r; ctx.strokeStyle = RIM; ctx.stroke();
  }

  // ---------- overview: full-screen dark street map ----------
  // Static layer in 256 px tiles per scale level (OV_LEVELS, LRU), drawn only on a redraw
  // (open, pan, zoom, resize; the game is paused meanwhile). Labels are placed once per scale
  // level for the whole level (collision on a grid, major roads and quarters first) and drawn
  // in screen space, so they never jump while panning; the placement level is the next
  // coarser one than the view, so zooming in only spreads them.
  const ovR = () => Math.min(1.5, devicePixelRatio || 1);
  const ovTiles = new Map();
  const ovLevelFor = (s) => { let k = 0; while (k < OV_LEVELS.length - 1 && OV_LEVELS[k] < s * 0.999) k++; return k; };   // tiles: sharp enough
  const labelLevelFor = (s) => { let k = 0; while (k < OV_LEVELS.length - 1 && OV_LEVELS[k + 1] <= s * 1.001) k++; return k; };   // labels: never denser than the view
  function drawDark(g, x0, z0, x1, z1, S, cs, wpx, hpx) {   // S: device px per metre, cs: CSS px per metre
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = D.out; g.fillRect(0, 0, wpx, hpx);
    g.setTransform(S, 0, 0, S, -x0 * S, -z0 * S);
    g.fillStyle = D.bg; g.fillRect(ex.minX, ex.minZ, ex.maxX - ex.minX, ex.maxZ - ex.minZ);
    const px = 1 / S;
    if (feats) {
      const fillAreas = (list, col) => {
        g.fillStyle = col;
        for (const a of list) {
          if (!hit(a.bb, x0, z0, x1, z1)) continue;
          g.beginPath(); for (const r of a.rings) path(g, r, true); g.fill('evenodd');
        }
      };
      fillAreas(feats.parks, D.park);
      fillAreas(feats.water, D.water);
      if (cs >= 0.25) {
        g.fillStyle = D.bldg; g.beginPath();
        for (const b of feats.buildings) if (hit(b.bb, x0, z0, x1, z1)) path(g, b.p, true);
        g.fill();
      }
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = D.rail; g.lineWidth = Math.max(1, 1.5 * S) * px;
      g.beginPath(); for (const r of feats.rail) if (hit(r.bb, x0, z0, x1, z1)) path(g, r.p, false); g.stroke();
      let style = null;
      const flush = () => { if (style) g.stroke(); style = null; };
      for (const r of feats.roads) {
        if (!hit(r.bb, x0, z0, x1, z1)) continue;
        const foot = FOOT.has(r.k) && r.k !== 'pedestrian';
        if (foot && cs < 2) continue;                        // footways only close up
        if (r.k === 'service' && cs < 0.5) continue;
        const major = MAJOR.has(r.k);
        const col = foot ? D.foot : major ? D.major : D.road;
        const w = foot ? Math.max(1.6, 1 * px) : Math.max((ROAD_W[r.k] || 4) * (major ? 1.35 : 1.1), (major ? 2.6 : r.k === 'service' ? 1 : 1.5) * px);
        const key = col + w + r.tun;
        if (key !== style) {
          flush(); style = key; g.beginPath();
          g.strokeStyle = col; g.lineWidth = w; g.globalAlpha = r.tun ? 0.4 : 1;
          g.setLineDash(r.tun ? [6 * px, 5 * px] : []);
        }
        path(g, r.p, false);
      }
      flush(); g.globalAlpha = 1; g.setLineDash([]);
    } else if (isWater) {   // no map.json: the water mask, coarse
      g.fillStyle = D.water;
      const st = Math.max(2, 4 / S);
      for (let z = Math.max(z0, ex.minZ); z < Math.min(z1, ex.maxZ); z += st)
        for (let x = Math.max(x0, ex.minX); x < Math.min(x1, ex.maxX); x += st) if (isWater(x, z)) g.fillRect(x, z, st, st);
    }
    g.strokeStyle = D.edge; g.lineWidth = 1.5 * px;
    g.strokeRect(ex.minX, ex.minZ, ex.maxX - ex.minX, ex.maxZ - ex.minZ);
  }
  function ovTile(k, i, j, allowNew) {
    const key = k + '/' + i + '/' + j;
    let t = ovTiles.get(key);
    if (t) { ovTiles.delete(key); ovTiles.set(key, t); return t; }
    if (!allowNew) return null;
    const r = ovR(), S = OV_LEVELS[k] * r, m = TILE_PX / S;
    t = document.createElement('canvas'); t.width = t.height = TILE_PX;
    drawDark(t.getContext('2d'), i * m, j * m, (i + 1) * m, (j + 1) * m, S, OV_LEVELS[k], TILE_PX, TILE_PX);
    ovTiles.set(key, t);
    while (ovTiles.size > 90) ovTiles.delete(ovTiles.keys().next().value);
    return t;
  }

  // labels per scale level: [{ x, z, a, text, font, col, kind }] in level coords
  const labelCache = new Map();
  const mctx = document.createElement('canvas').getContext('2d');
  const widths = new Map();
  const textW = (font, t) => { const k = font + '|' + t; let w = widths.get(k); if (w === undefined) { mctx.font = font; w = mctx.measureText(t).width; widths.set(k, w); } return w; };
  const spaced = (t) => t.toUpperCase().split('').join(' ');
  const F_MAJOR = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const F_MINOR = '500 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const F_QUARTER = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const F_SUBURB = '700 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  function labelsFor(k) {
    let L = labelCache.get(k);
    if (L) return L;
    L = [];
    labelCache.set(k, L);
    if (!map) return L;
    const cs = OV_LEVELS[k], CELL = 64, grid = new Map(), byName = new Map();
    const boxes = (cx, cy, hw, hh) => [cx - hw, cy - hh, cx + hw, cy + hh];
    const free = (b) => {
      for (let i = Math.floor(b[0] / CELL); i <= Math.floor(b[2] / CELL); i++)
        for (let j = Math.floor(b[1] / CELL); j <= Math.floor(b[3] / CELL); j++)
          for (const o of grid.get(i + ',' + j) || []) if (o[0] < b[2] && b[0] < o[2] && o[1] < b[3] && b[1] < o[3]) return false;
      return true;
    };
    const take = (b) => {
      for (let i = Math.floor(b[0] / CELL); i <= Math.floor(b[2] / CELL); i++)
        for (let j = Math.floor(b[1] / CELL); j <= Math.floor(b[3] / CELL); j++) {
          const key = i + ',' + j; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(b);
        }
    };
    // quarter names first (spaced capitals): Ortsteile far out, quarters in between, neighbourhoods close
    for (const [kind, name, x, z] of map.places || []) {
      if (kind === 'landmark') continue;
      if (kind === 'suburb' ? cs > 0.5 : kind === 'quarter' ? cs < 0.25 || cs > 4 : cs < 0.5 || cs > 4) continue;
      const text = spaced(name), font = kind === 'suburb' ? F_SUBURB : F_QUARTER;
      const b = boxes(x * cs, z * cs, textW(font, text) / 2 + 6, 10);
      if (!free(b)) continue;
      take(b); L.push({ x, z, a: 0, text, font, col: D.quarter, kind: 'q' });
    }
    // street names: per way the longest nearly straight run that holds the text, major roads first
    const showMinor = cs >= 1, showService = cs >= 2, showMajor = cs >= 0.35;
    const cands = [];
    for (const r of feats?.roads || []) {
      if (r.n < 0 || r.tun) continue;
      const major = LABEL_MAJOR.has(r.k);
      if (major ? !showMajor : LABEL_MINOR.has(r.k) ? !showMinor : r.k === 'service' ? !showService : true) continue;
      const p = r.p;
      let best = null, runA = 0, runLen = 0, runAng = null;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const a = Math.atan2(dz, dx);
        const bend = runAng === null ? 0 : Math.abs(Math.atan2(Math.sin(a - runAng), Math.cos(a - runAng)));
        if (runAng === null || bend > 0.14) { runA = i; runLen = 0; runAng = a; }
        runLen += l;
        if (!best || runLen > best.len) best = { len: runLen, i0: runA, i1: i + 2 };
      }
      if (!best) continue;
      cands.push({ r, major, best });
    }
    cands.sort((A, B) => (B.major - A.major) || (B.best.len - A.best.len));
    for (const { r, major, best } of cands) {
      const text = map.names[r.n], font = major ? F_MAJOR : F_MINOR, w = textW(font, text);
      if (best.len * cs < w + 18) continue;
      const p = r.p, ax = p[best.i0], az = p[best.i0 + 1], bx = p[best.i1], bz = p[best.i1 + 1];
      const x = (ax + bx) / 2, z = (az + bz) / 2;
      const same = byName.get(text);
      if (same && same.some(([qx, qz]) => Math.hypot(qx - x, qz - z) * cs < 260)) continue;
      let a = Math.atan2(bz - az, bx - ax);
      if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;   // never upside down
      const hw = w / 2 + 4, hh = 7, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      const b = boxes(x * cs, z * cs, hw * c + hh * sn, hw * sn + hh * c);
      if (!free(b)) continue;
      take(b);
      if (same) same.push([x, z]); else byName.set(text, [[x, z]]);
      L.push({ x, z, a, text, font, col: major ? D.major_label : D.label, kind: 's' });
    }
    return L;
  }

  let ovRaf = 0;
  function ovRequest() { if (ovOn && !ovRaf) ovRaf = requestAnimationFrame(() => { ovRaf = 0; drawOverview(); }); }
  function ovFit() { return Math.min(innerWidth / (ex.maxX - ex.minX), innerHeight / (ex.maxZ - ex.minZ)) * 0.9; }
  function ovClamp() {
    ovV.s = Math.min(OV_MAX, Math.max(Math.min(OV_START, ovFit()), ovV.s));
    ovV.x = Math.min(ex.maxX, Math.max(ex.minX, ovV.x));
    ovV.z = Math.min(ex.maxZ, Math.max(ex.minZ, ovV.z));
  }
  function ovSize() {
    const r = ovR(), W = Math.round(innerWidth * r), H = Math.round(innerHeight * r);
    if (ovCv.width !== W || ovCv.height !== H) { ovCv.width = W; ovCv.height = H; }
  }
  function drawOverview() {
    const r = ovR(), W = ovCv.width, H = ovCv.height, g = ovG;
    const s = ovV.s * r;   // device px per metre
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = D.out; g.fillRect(0, 0, W, H);
    const k = ovLevelFor(ovV.s), S = OV_LEVELS[k] * r, tm = TILE_PX / S;
    const x0 = ovV.x - W / 2 / s, z0 = ovV.z - H / 2 / s, x1 = ovV.x + W / 2 / s, z1 = ovV.z + H / 2 / s;
    let budget = 6, missing = false;
    g.imageSmoothingEnabled = true;
    for (let i = Math.floor(x0 / tm); i <= Math.floor(x1 / tm); i++) for (let j = Math.floor(z0 / tm); j <= Math.floor(z1 / tm); j++) {
      const has = ovTiles.has(k + '/' + i + '/' + j);
      const t = ovTile(k, i, j, has || budget > 0);
      if (!has && t) budget--;
      if (!t) { missing = true; continue; }
      const sx = (i * tm - x0) * s, sy = (j * tm - z0) * s, sz = tm * s;
      g.drawImage(t, Math.floor(sx), Math.floor(sy), Math.ceil(sz + 1), Math.ceil(sz + 1));
    }
    // labels (screen space, halo)
    const L = labelsFor(labelLevelFor(ovV.s));
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (const l of L) {
      const X = (l.x - x0) * s, Y = (l.z - z0) * s;
      if (X < -200 * r || Y < -40 * r || X > W + 200 * r || Y > H + 40 * r) continue;
      g.setTransform(r, 0, 0, r, X, Y);
      if (l.a) g.rotate(l.a);
      g.font = l.font;
      g.lineWidth = 3; g.strokeStyle = D.halo; g.strokeText(l.text, 0, 0.5);
      g.fillStyle = l.col; g.fillText(l.text, 0, 0.5);
    }
    // map drive: the trail, fading toward its old end
    if (driving && trail.length > 1) {
      g.setTransform(1, 0, 0, 1, 0, 0); g.lineCap = 'round'; g.lineWidth = 3 * r; g.strokeStyle = `rgb(${D.cone})`;
      const n = trail.length;
      for (let i = 1; i < n; i++) {
        g.globalAlpha = 0.55 * i / n;
        g.beginPath(); g.moveTo((trail[i - 1][0] - x0) * s, (trail[i - 1][1] - z0) * s); g.lineTo((trail[i][0] - x0) * s, (trail[i][1] - z0) * s); g.stroke();
      }
      g.globalAlpha = 1;
    }
    // the car: soft view cone + arrow with a glow
    const X = (lastPos.x - x0) * s, Y = (lastPos.z - z0) * s;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const va = lastPos.v - Math.PI / 2, R = 95 * r;
    const grad = g.createRadialGradient(X, Y, 4 * r, X, Y, R);
    grad.addColorStop(0, `rgba(${D.cone}, 0.42)`); grad.addColorStop(1, `rgba(${D.cone}, 0)`);
    g.beginPath(); g.moveTo(X, Y); g.arc(X, Y, R, va - 0.55, va + 0.55); g.closePath();
    g.fillStyle = grad; g.fill();
    g.save(); g.shadowColor = `rgba(${D.cone}, 0.9)`; g.shadowBlur = 14 * r;
    arrow(g, X, Y, lastPos.h, 10 * r);
    g.restore();
    const t = fmtLatLon(toLatLon(lastPos.x, lastPos.z)); if (llEl.textContent !== t) llEl.textContent = t;
    if (missing) ovRequest();   // more tiles next frame (spreads the cost)
  }
  function zoomAt(f, cx = innerWidth / 2, cy = innerHeight / 2) {
    const wx = ovV.x + (cx - innerWidth / 2) / ovV.s, wz = ovV.z + (cy - innerHeight / 2) / ovV.s;
    ovV.s *= f; ovClamp();
    ovV.x = wx - (cx - innerWidth / 2) / ovV.s; ovV.z = wz - (cy - innerHeight / 2) / ovV.s;
    ovClamp(); ovRequest();
  }
  // drag = pan, two fingers = pinch zoom, wheel = zoom at the cursor
  const ptrs = new Map();
  let pinch = null;
  ovCv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { ovCv.setPointerCapture(e.pointerId); } catch { /* gone */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ovCv.classList.add('drag'); pinch = null;
  });
  ovCv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 1) {
      ovV.x -= (e.clientX - p.x) / ovV.s; ovV.z -= (e.clientY - p.y) / ovV.s;
      if (e.clientX !== p.x || e.clientY !== p.y) follow = false;   // map drive: a drag stops following
      p.x = e.clientX; p.y = e.clientY; ovClamp(); ovRequest();
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinch && d > 0 && pinch.d > 0) {
      ovV.x -= (mx - pinch.mx) / ovV.s; ovV.z -= (my - pinch.my) / ovV.s;
      zoomAt(d / pinch.d, mx, my);
    }
    pinch = { d, mx, my };
  });
  const ptrUp = (e) => { ptrs.delete(e.pointerId); pinch = null; if (!ptrs.size) ovCv.classList.remove('drag'); };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) ovCv.addEventListener(t, ptrUp);
  ovCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    zoomAt(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0018), e.clientX, e.clientY);
  }, { passive: false });
  ov.querySelector('.ovclose').addEventListener('click', () => setOverview(false));
  ov.querySelector('[data-z="in"]').addEventListener('click', () => zoomAt(1.6));
  ov.querySelector('[data-z="out"]').addEventListener('click', () => zoomAt(1 / 1.6));
  ov.querySelector('[data-z="me"]').addEventListener('click', () => { ovV.x = lastPos.x; ovV.z = lastPos.z; follow = true; ovClamp(); ovRequest(); });

  // ---------- hidden map drive (index.html startMapDrive): the car moves on the open map ----------
  // setDriving(true): the view follows the car (eased, north up, zoom kept; a drag stops it until
  // re-centre or the car leaves the view), redraws at ~25 Hz, the speed in the top-left corner and
  // a fading trail (last ~100 m) behind the arrow. Labels / tiles stay cached per zoom level.
  const ovSpdEl = ov.querySelector('.ovspd');
  const TRAIL_M = 100, TRAIL_STEP = 2, DRIVE_HZ = 25;
  let driving = false, follow = true, trail = [], trailLen = 0, driveT = 0;
  function setDriving(v) {
    driving = !!v; follow = true; trail = []; trailLen = 0; driveT = 0;
    ov.classList.toggle('driving', driving);
    if (driving) ovSpdEl.textContent = '';
  }
  function driveStep(x, z, kmh, now) {
    const l = trail[trail.length - 1];
    if (!l || Math.hypot(x - l[0], z - l[1]) >= TRAIL_STEP) {
      if (l) trailLen += Math.hypot(x - l[0], z - l[1]);
      trail.push([x, z]);
      while (trail.length > 2 && trailLen > TRAIL_M) { trailLen -= Math.hypot(trail[1][0] - trail[0][0], trail[1][1] - trail[0][1]); trail.shift(); }
    }
    if (now - driveT < 1000 / DRIVE_HZ) return;
    const dt = driveT ? Math.min(0.2, (now - driveT) / 1000) : 0;
    driveT = now;
    const t = Math.round(Math.abs(kmh)) + ' km/h';
    if (ovSpdEl.textContent !== t) ovSpdEl.textContent = t;
    if (!follow) {   // dragged away: follow again once the car leaves the view
      const hw = innerWidth / 2 / ovV.s, hh = innerHeight / 2 / ovV.s;
      if (Math.abs(x - ovV.x) > hw * 0.95 || Math.abs(z - ovV.z) > hh * 0.95) follow = true;
    }
    if (follow && !ptrs.size) {
      const k = dt ? 1 - Math.exp(-6 * dt) : 1;
      ovV.x += (x - ovV.x) * k; ovV.z += (z - ovV.z) * k; ovClamp();
    }
    ovRequest();
  }

  function setOverview(v) {
    v = !!v;
    if (v === ovOn) return;
    ovOn = v; ov.classList.toggle('on', ovOn);
    if (ovOn) {   // opens on the car at street level
      ovV.x = lastPos.x; ovV.z = lastPos.z; ovV.s = OV_START;
      ovSize(); ovClamp(); drawOverview();
      ov.querySelector('.ovclose').focus({ preventScroll: true });
    } else {
      ptrs.clear(); pinch = null;
      if (document.activeElement && ov.contains(document.activeElement)) document.activeElement.blur();
    }
    try { onOverview?.(ovOn); } catch (e) { console.warn('minimap onOverview:', e); }
  }
  addEventListener('resize', () => { if (ovOn) { ovSize(); ovClamp(); ovRequest(); } last = 0; });

  function update(x, z, h, kmh = 0, showKmh = true, view = h) {
    lastPos.x = x; lastPos.z = z; lastPos.h = h; lastPos.v = Number.isFinite(view) ? view : h;
    const now = performance.now();
    if (ovOn && driving) driveStep(x, z, kmh, now);
    if (now - last < 1000 / HZ) return;
    last = now;
    // speed line: integer km/h, empty where the old readout was empty (showKmh false)
    const st = showKmh && Number.isFinite(kmh) ? Math.round(Math.abs(kmh)) + ' km/h' : '';
    if (st !== spdTxt) { spdTxt = st; spdEl.textContent = st; }
    if (now - nameT > 1000 / NAME_HZ) { nameT = now; lookupName(x, z, h, kmh); }
    if (on && !ovOn) drawMini(x, z, h, kmh);   // the disc is hidden under the overview
    if (ovOn && !driving) ovRequest();
  }
  return {
    update, loaded, setVisible: setOn, get visible() { return on; },
    setOverview, get overview() { return ovOn; }, setDriving, get driving() { return driving; },
    // overview by a game controller (js/gamepad.js): pan by screen px, zoom about the centre, re-centre on the car
    pan(dx, dy) { if (!ovOn) return; ovV.x += dx / ovV.s; ovV.z += dy / ovV.s; follow = false; ovClamp(); ovRequest(); },
    zoom(f) { if (ovOn) zoomAt(f); },
    recentre() { if (!ovOn) return; ovV.x = lastPos.x; ovV.z = lastPos.z; follow = true; ovClamp(); ovRequest(); },
    get street() { return curName >= 0 ? map.names[curName] : ''; }, get near() { return nearTxt; },
    get streetKind() { return curName >= 0 ? curKind : ''; },   // OSM highway class of that street (js/areasign.js street plate)
    get map() { return map; }, canvas: cv, tiles,
    latlon(x = lastPos.x, z = lastPos.z) { return toLatLon(x, z); },
    setMarkers, setMarkerGroup, get markers() { return markers.slice(); },
    // force a name lookup + redraw now (tests): refresh(x, z, h)
    refresh(x = lastPos.x, z = lastPos.z, h = lastPos.h) { last = 0; nameT = 0; update(x, z, h, 0, spdTxt !== ''); return { street: this.street, near: nearTxt }; },
  };
}

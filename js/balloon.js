// Easter egg: the "WELT" balloon (Weltballon / HiFlyer) at Zimmerstrasse / Wilhelmstrasse,
// near Checkpoint Charlie. Procedural and abstracted: a ~22 m blue globe (slightly pear-shaped
// toward the bottom) with lighter continents, latitude lines and the word WELT in plain white
// capitals round the equator, a line net over the top converging to a load ring, a ring-shaped
// open gondola below, one tether cable to a winch on a round ground platform.
//
// Position: OSM way 1250081894 "Weltballon" (attraction=balloon_ride, balloon:height=150),
// centroid of its 11.2 m circle. Converted with the exact level frame of build_level.py /
// build_stream.py: en = R(lat0, lon0) . (ecef(lat, lon, 0) - ecef(lat0, lon0, 0)), x = e, z = -n.
//
// Cycle (360 s): 60 s on the platform, 90 s up to 150 m, 120 s aloft, 90 s down; gentle sway on
// the taut cable (the rig is placed along the cable, so cable and gondola stay in line) and a
// slow turn about its axis.
//
// Drawing: own scene, rendered by draw() after the car pass (index.html drawPasses), depth-tested
// against world + car. Nothing has userData.world -> not a camera-collision occluder, and it is not
// in the main scene -> it never triggers the car's ghost silhouette. Own fog (lighter than the mesh
// fog: a landmark you can navigate by), own lights from the mood's car values; night/moon: a faint
// inner glow and a light from below; snow: a white cap. ~6 draw calls incl. the ground shadow
// (sun-cast soft ellipse draped on groundAt, fades out by ~100 m: see SHADOW below).
//
// Interaction (only where the platform lies inside the level; it does on mitte_all): the platform
// is a static Box2D circle on its own body (always on). Stopping next to it while the balloon is
// down (no prompt: quiet game, README Rules) + E there = a ride: the camera goes up with the gondola for one cycle and looks
// slowly round over the city; the car waits; any key ends it. On a level that does not contain the
// platform (none since the small level was retired) the balloon would show only as distant scenery
// while it is up (no platform, no collider): the inLevel guard below.
//
// Cut (hidden): driving the car body through the free cable (sheave outside the rim, see SHEAVE_*)
// snaps it; the balloon flies off with the wind and is gone for good (localStorage CUT_KEY).
// Console: cutNow(), restore().
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BALLOON = { lat: 52.507932, lon: 13.386118, name: 'Weltballon' };
const R = 11;                 // envelope radius (m), 22 m across
const PEAR = 0.14, STRETCH = 0.08;   // lower half: narrower and a little longer
const ENV_Y = 8.5 + R * (1 + STRETCH);   // envelope centre above the gondola floor
const LOAD_Y = 6.5, LOAD_R = 2.2;        // load ring
const G_OUT = 3.05, G_IN = 1.7, RAIL_Y = 1.15;   // gondola: open ring walkway ~6 m across
const PLAT_R = 10, PLAT_TOP = 0.8;       // ground platform (radius, top above the height model)
const ALT = 150;
const SEG = [60, 90, 120, 90];           // ground, up, aloft, down (s)
const CYCLE = SEG.reduce((a, b) => a + b, 0);
const RIDE_DIST = PLAT_R + 14;
// Cable exit: the drum's cable runs out of the winch house, over the platform rim, through a sheave
// set flush in the pavement just outside the rim (the platform collider would keep a car 10 m off a
// cable in the middle), then up to the gondola. Rising, the balloon drifts over the sheave, so aloft
// the cable is near vertical above it. The sheave faces Wilhelmstrasse, the open side (no wall
// within 40 m from 150 to 240 deg; the ?spot=weltballon start lies at 164 deg).
const SHEAVE_R = PLAT_R + 1.1;
const SHEAVE_A = Math.atan2(15.4, -53.4);    // level frame angle, x = cos, z = sin
const DRIFT_H = 25;                          // m: by this height the gondola is over the sheave
const LEAN = 0.03;                           // aloft the cable leans this much outward (m per m)
const START_DIST = 120, WAIT_GROUND = 8;     // m: the car this near starts the cycle; s on the ground before lift-off
const FREE_H = 1.5;                          // gondola above this = a free cable (cuttable)
const CABLE_Y = 0.3;                         // cable leaves the sheave this high above the street
const CAR_TOP = 1.5, CUT_MARGIN = 0.12;      // car body height; cable radius + tolerance (m)
const WIND = [0.86, -0.51];                  // freed balloon drifts east-north-east (z = -north)
const CUT_KEY = 'berlinDrive.balloon.cut';   // '1' = the cable was cut, the balloon is gone for good
const SLACK_L = 7;                           // m of cable that flops out of the sheave onto the street
const FLY_FADE = [150, 180];                 // s after the cut: fade out in the sky, then gone

// WGS84 -> level frame (same maths as build_stream.py to_en / minimap.js makeGeo)
const WGS_A = 6378137.0, WGS_F = 1 / 298.257223563, WGS_E2 = WGS_F * (2 - WGS_F), D2R = Math.PI / 180;
function geoToEcef(lat, lon) {
  const la = lat * D2R, lo = lon * D2R, N = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(la) ** 2);
  return [N * Math.cos(la) * Math.cos(lo), N * Math.cos(la) * Math.sin(lo), N * (1 - WGS_E2) * Math.sin(la)];
}
export function toLevel(origin, lat, lon) {
  const o = geoToEcef(origin.lat, origin.lon), p = geoToEcef(lat, lon), d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const sla = Math.sin(origin.lat * D2R), cla = Math.cos(origin.lat * D2R), slo = Math.sin(origin.lon * D2R), clo = Math.cos(origin.lon * D2R);
  const e = -slo * d[0] + clo * d[1], n = -sla * clo * d[0] - sla * slo * d[1] + cla * d[2];
  return { x: e, z: -n };
}

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
// gondola altitude (m above the platform) at cycle time t
function altitude(t) {
  t = ((t % CYCLE) + CYCLE) % CYCLE;
  if (t < SEG[0]) return 0;
  t -= SEG[0]; if (t < SEG[1]) return ALT * ease(t / SEG[1]);
  t -= SEG[1]; if (t < SEG[2]) return ALT;
  t -= SEG[2]; return ALT * (1 - ease(t / SEG[3]));
}

// pear shape: the lower half narrower and slightly drawn out
function deform(v) {
  if (v.y < 0) { const t = -v.y / R, k = 1 - PEAR * t * t; v.x *= k; v.z *= k; v.y *= 1 + STRETCH * t; }
  return v;
}

// ---- globe texture (equirectangular): deep blue, lighter stylised continents, latitude /
// longitude lines, WELT in plain bold sans-serif white capitals round the equator ----
const CONTINENTS = [   // very coarse (lon, lat) outlines - an abstraction, not a map
  [[-168, 66], [-140, 70], [-95, 72], [-62, 60], [-55, 48], [-80, 25], [-97, 18], [-83, 9], [-105, 22], [-118, 33], [-125, 48], [-150, 60]],
  [[-80, 10], [-60, 8], [-35, -6], [-40, -22], [-58, -38], [-70, -54], [-75, -40], [-72, -18], [-81, -4]],
  [[-10, 36], [-17, 15], [-8, 4], [10, 4], [13, -18], [20, -35], [33, -26], [40, -12], [51, 11], [43, 12], [32, 31], [10, 37]],
  [[-10, 36], [-9, 44], [-2, 48], [5, 54], [10, 58], [20, 70], [40, 68], [60, 70], [100, 77], [140, 72], [178, 66], [160, 58], [140, 52],
   [122, 40], [121, 30], [108, 20], [100, 8], [80, 8], [73, 20], [57, 25], [48, 30], [35, 36], [27, 41], [15, 40]],
  [[114, -22], [122, -18], [131, -12], [142, -11], [153, -27], [148, -38], [138, -35], [130, -32], [116, -34]],
  [[-50, 60], [-30, 68], [-22, 76], [-40, 83], [-60, 80], [-60, 72]],
];
function globeCanvas() {
  const W = 2048, Hc = 1024, c = document.createElement('canvas'); c.width = W; c.height = Hc;
  const g = c.getContext('2d');
  const sea = g.createLinearGradient(0, 0, 0, Hc);
  sea.addColorStop(0, '#0d3f96'); sea.addColorStop(0.5, '#0a3687'); sea.addColorStop(1, '#072a6c');
  g.fillStyle = sea; g.fillRect(0, 0, W, Hc);
  const px = (lon, lat) => [(lon + 180) / 360 * W, (90 - lat) / 180 * Hc];
  g.fillStyle = '#3f86d6'; g.strokeStyle = '#6aa8ec'; g.lineWidth = 4; g.lineJoin = 'round';
  for (const poly of CONTINENTS) {   // smooth closed curve through the midpoints
    const P = poly.map(([lo, la]) => px(lo, la)), n = P.length;
    g.beginPath();
    g.moveTo((P[n - 1][0] + P[0][0]) / 2, (P[n - 1][1] + P[0][1]) / 2);
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; g.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
    g.closePath(); g.fill(); g.stroke();
  }
  g.strokeStyle = 'rgba(200, 225, 255, 0.35)'; g.lineWidth = 3;
  for (let la = -60; la <= 60; la += 30) { if (la === 0) continue; const y = px(0, la)[1]; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  for (let lo = -180; lo < 180; lo += 30) { const x = px(lo, 0)[0]; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hc); g.stroke(); }
  // equator band + WELT three times round the globe (readable from every side)
  g.fillStyle = 'rgba(4, 22, 70, 0.55)'; g.fillRect(0, Hc / 2 - 120, W, 240);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 190px "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
  for (let k = 0; k < 3; k++) g.fillText('WELT', (k + 0.5) / 3 * W, Hc / 2 + 6);
  return c;
}
// night glow: the same picture fading toward the top (lit from below / inside)
function glowCanvas(src) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const gr = g.createLinearGradient(0, 0, 0, c.height);
  gr.addColorStop(0, 'rgba(0,0,0,0.12)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-in'; g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  return c;
}

// merged geometry with a flat vertex colour per part (one draw call)
function merged(parts) {
  const geos = parts.map(([geo, col]) => {
    const g = geo, n = g.attributes.position.count, c = new THREE.Color(col), a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    return g;
  });
  return mergeGeometries(geos);
}

// car body polygon (local Box2D vertices) contains the point or is within m of it
function nearPoly(px, py, vs, n, m) {
  let inside = false, d2 = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = vs[i], c = vs[j];
    if ((a.y > py) !== (c.y > py) && px < (c.x - a.x) * (py - a.y) / (c.y - a.y) + a.x) inside = !inside;
    const dx = c.x - a.x, dy = c.y - a.y, L = dx * dx + dy * dy || 1e-9;
    const u = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L));
    d2 = Math.min(d2, (a.x + u * dx - px) ** 2 + (a.y + u * dy - py) ** 2);
  }
  return inside || d2 < m * m;
}

// busy(): the car is somewhere else (S-Bahn rails, tunnel, roof) - it cannot touch the cable
export function createBalloon({ level, groundAt, world = null, mood = null, camera, vehicle = () => null, busy = () => false, sunOffset = null, parent = document.body }) {
  const { x, z } = toLevel(level.origin, BALLOON.lat, BALLOON.lon);
  const ex = level.extent;
  const inLevel = x - PLAT_R > ex.minX && x + PLAT_R < ex.maxX && z - PLAT_R > ex.minZ && z + PLAT_R < ex.maxZ;
  // height model there (on the streamed level the tiles may not be in yet); platform reaches
  // 1.5 m below it, so a mesh street a little lower or higher never shows a gap
  const g0 = groundAt(Math.min(ex.maxX, Math.max(ex.minX, x)), Math.min(ex.maxZ, Math.max(ex.minZ, z)));
  const top = g0 + PLAT_TOP;
  const P = mood?.preset || null, mname = mood?.name || '';
  const night = mname === 'night' || mname === 'moon';

  const scene = new THREE.Scene();
  // fog: lighter than the mesh fog (a landmark), toward the mood's horizon colour
  if (mood) scene.fog = new THREE.Fog(mood.uniforms.uHorizon.value.clone(), P.fogDist, P.fogDist * 7);
  else scene.fog = new THREE.Fog(0x9fb4c8, 1500, 6000);
  // lights: the mood's car values (tuned per mood), sun from the mood's sun direction
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667080, P ? P.carHemi : 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, P ? P.carSun : 1.6);
  const sd = mood?.uniforms?.uSunDir?.value;
  if (sd && sd.length() > 0.1) sun.position.copy(sd).normalize(); else sun.position.set(-0.5, 1, 0.3);
  scene.add(sun);
  const lineK = mname === 'night' ? 0.35 : mname === 'moon' ? 0.3 : 1;

  // ---- rig: everything that rides up (origin = gondola floor centre = cable attachment) ----
  const rig = new THREE.Group(); scene.add(rig);
  const globe = globeCanvas();
  const map = new THREE.CanvasTexture(globe); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const envGeo = new THREE.SphereGeometry(R, 64, 40);
  { const p = envGeo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { deform(v.fromBufferAttribute(p, i)); p.setXYZ(i, v.x, v.y, v.z); }
    envGeo.computeVertexNormals(); }
  const envMat = new THREE.MeshLambertMaterial({ map });
  if (night) {   // faint internal glow, strongest at the bottom
    const em = new THREE.CanvasTexture(glowCanvas(globe)); em.colorSpace = THREE.SRGBColorSpace;
    envMat.emissiveMap = em; envMat.emissive.set(0xffffff); envMat.emissiveIntensity = mname === 'night' ? 0.55 : 0.4;
  }
  const envelope = new THREE.Mesh(envGeo, envMat); envelope.position.y = ENV_Y; rig.add(envelope);
  if (mname === 'snow') {   // a little white cap on top
    const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 1.006, 48, 8, 0, Math.PI * 2, 0, 0.55),
      new THREE.MeshLambertMaterial({ color: 0xf4f7fb }));
    cap.position.y = ENV_Y; rig.add(cap);
  }
  if (night) {   // floodlit from below (the real one is lit up at night)
    const pl = new THREE.PointLight(mname === 'night' ? 0xffd2e6 : 0xd8e6ff, mname === 'night' ? 300 : 200, 0, 2);
    pl.position.set(0, 2.5, 0); rig.add(pl);
  }
  // gondola + load ring: one merged mesh
  const parts = [];
  parts.push([new THREE.LatheGeometry([new THREE.Vector2(G_IN, 0), new THREE.Vector2(G_OUT, 0), new THREE.Vector2(G_OUT, 0.35),
                                       new THREE.Vector2(G_IN, 0.35), new THREE.Vector2(G_IN, 0)], 40), 0x2b3a4f]);   // walkway
  for (const r of [G_OUT, G_IN]) {
    parts.push([new THREE.TorusGeometry(r, 0.06, 5, 48).rotateX(Math.PI / 2).translate(0, RAIL_Y, 0), 0xe8edf2]);    // railings
    parts.push([new THREE.TorusGeometry(r, 0.035, 4, 48).rotateX(Math.PI / 2).translate(0, 0.75, 0), 0xc9d2dc]);
    const n = r === G_OUT ? 16 : 10;
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2;
      parts.push([new THREE.CylinderGeometry(0.045, 0.045, RAIL_Y - 0.35, 4).translate(r * Math.cos(a), 0.35 + (RAIL_Y - 0.35) / 2, r * Math.sin(a)), 0xe8edf2]); }
  }
  for (let k = 0; k < 4; k++)   // spokes to the hub the cable hangs from
    parts.push([new THREE.BoxGeometry(2 * G_IN, 0.16, 0.22).rotateY((k / 4) * Math.PI).translate(0, 0.1, 0), 0x55606e]);
  parts.push([new THREE.CylinderGeometry(0.4, 0.4, 0.45, 12).translate(0, 0.05, 0), 0x404a57]);
  parts.push([new THREE.TorusGeometry(LOAD_R, 0.13, 6, 36).rotateX(Math.PI / 2).translate(0, LOAD_Y, 0), 0x9aa4ae]);   // load ring
  const gondola = new THREE.Mesh(merged(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  rig.add(gondola);
  // net (meridians over the upper half, two latitude rings) + lines down to the load ring + suspension lines
  const L = [], v = new THREE.Vector3(), w = new THREE.Vector3();
  const sp = (theta, phi, s = 1.006) => deform(v.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)).multiplyScalar(R)).multiplyScalar(s).add(new THREE.Vector3(0, ENV_Y, 0));
  const NM = 16, TH_END = 2.75;   // net down to near the bottom (lines to the load ring stay outside the envelope)
  for (let m = 0; m < NM; m++) {
    const phi = (m / NM) * Math.PI * 2;
    for (let k = 0; k < 16; k++) { const a = sp(TH_END * k / 16, phi).clone(), b = sp(TH_END * (k + 1) / 16, phi); L.push(a.x, a.y, a.z, b.x, b.y, b.z); }
    const e = sp(TH_END, phi), ang = phi;   // from the net's lower edge to the load ring
    w.set(-Math.cos(ang) * LOAD_R, LOAD_Y, Math.sin(ang) * LOAD_R);
    L.push(e.x, e.y, e.z, w.x, w.y, w.z);
  }
  for (const th of [0.45, 0.95, 1.45]) for (let m = 0; m < 48; m++) {
    const a = sp(th, (m / 48) * Math.PI * 2).clone(), b = sp(th, ((m + 1) / 48) * Math.PI * 2); L.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  for (let k = 0; k < 12; k++) {   // load ring -> outer railing
    const a = (k / 12) * Math.PI * 2;
    L.push(LOAD_R * Math.cos(a), LOAD_Y, LOAD_R * Math.sin(a), G_OUT * Math.cos(a), RAIL_Y, G_OUT * Math.sin(a));
  }
  const lineCol = new THREE.Color(0xe6ebf0).multiplyScalar(lineK);
  const net = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(L, 3)),
                                     new THREE.LineBasicMaterial({ color: lineCol }));
  rig.add(net);

  // ---- base (static): platform + winch; only where it lies inside the level ----
  // sheave (cable exit) outside the rim on the Wilhelmstrasse side; the base is turned so its +x
  // (winch house, drum) points there
  const cA = Math.cos(SHEAVE_A), sA = Math.sin(SHEAVE_A);
  const at = (r) => [x + cA * r, z + sA * r];
  const [sx, sz] = at(SHEAVE_R);
  const gS = groundAt(Math.min(ex.maxX, Math.max(ex.minX, sx)), Math.min(ex.maxZ, Math.max(ex.minZ, sz)));
  const sheave = new THREE.Vector3(sx, gS + CABLE_Y, sz);   // where the free cable leaves the street
  const cableMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0x3a3f46).multiplyScalar(mname === 'snow' || !mname || mname === 'day' ? 1 : 1.6) });
  if (inLevel) {
    const sp2 = [];
    sp2.push([new THREE.BoxGeometry(1.0, 0.22, 0.8).translate(0, 0.11, 0), 0xf2c230]);                     // fitting
    sp2.push([new THREE.TorusGeometry(0.26, 0.06, 6, 16).translate(0, 0.2, 0), 0x2a2e33]);                 // sheave wheel
    const sm = new THREE.Mesh(merged(sp2), new THREE.MeshLambertMaterial({ vertexColors: true }));
    sm.position.set(sx, gS, sz); sm.rotation.y = -SHEAVE_A; scene.add(sm);
    // cable from the winch house over the rim down to the sheave (stays after a cut, as evidence)
    const [hx, hz] = at(PLAT_R - 1.5), [rx, rz] = at(PLAT_R + 0.05), [fx, fz] = at(PLAT_R + 0.35);
    const gR = groundAt(Math.min(ex.maxX, Math.max(ex.minX, fx)), Math.min(ex.maxZ, Math.max(ex.minZ, fz)));
    const run = [hx, top + 0.5, hz, rx, top + 0.03, rz, rx, top + 0.03, rz, fx, gR + 0.06, fz, fx, gR + 0.06, fz, sx, sheave.y, sz];
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(run, 3)), cableMat));
  }
  if (inLevel) {
    const bp = [];
    bp.push([new THREE.CylinderGeometry(PLAT_R, PLAT_R + 0.3, PLAT_TOP + 1.5, 56).translate(0, (PLAT_TOP - 1.5) / 2 - PLAT_TOP, 0), 0x8d9095]);
    bp.push([new THREE.RingGeometry(PLAT_R - 1.4, PLAT_R - 0.8, 56).rotateX(-Math.PI / 2).translate(0, 0.02, 0), 0xf2c230]);
    bp.push([new THREE.CylinderGeometry(4.2, 4.2, 0.08, 40).translate(0, 0.04, 0), 0x5d636b]);   // landing pad
    // cable guide flush in the middle (the gondola lands over it), winch house at the rim
    bp.push([new THREE.TorusGeometry(0.35, 0.08, 6, 16).rotateX(Math.PI / 2).translate(0, 0.06, 0), 0x2a2e33]);
    const wx = PLAT_R - 2.6;
    bp.push([new THREE.BoxGeometry(2.2, 1.4, 1.6).translate(wx, 0.7, 0), 0x3d6fa8]);              // winch house
    bp.push([new THREE.CylinderGeometry(0.45, 0.45, 1.8, 14).rotateX(Math.PI / 2).translate(wx - 1.6, 0.5, 0), 0x2a2e33]);   // drum
    bp.push([new THREE.BoxGeometry(wx - 1.6, 0.12, 0.3).translate((wx - 1.6) / 2, 0.06, 0), 0x2a2e33]);   // cable duct to the middle
    const base = new THREE.Mesh(merged(bp), new THREE.MeshLambertMaterial({ vertexColors: true }));
    base.position.set(x, top, z); base.rotation.y = -SHEAVE_A; scene.add(base);
  }
  const tetherGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
  const tether = new THREE.Line(tetherGeo, cableMat);
  tether.frustumCulled = false; scene.add(tether);
  // after a cut: the upper piece trailing under the balloon (verlet rope) and the slack on the street
  const ROPE_N = 30, SLACK_N = 24;
  const ropeGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((ROPE_N + 1) * 3), 3));
  const ropeMat = cableMat.clone();
  const rope = new THREE.Line(ropeGeo, ropeMat); rope.frustumCulled = false; rope.visible = false; scene.add(rope);
  const slackGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((SLACK_N + 1) * 3), 3));
  const slack = new THREE.Line(slackGeo, cableMat); slack.frustumCulled = false; slack.visible = false; scene.add(slack);
  // where the slack lies: out from the sheave away from the platform, in a loose wave
  const slackGround = [];
  for (let i = 0; i <= SLACK_N; i++) {
    const s = SLACK_L * i / SLACK_N, wv = 0.7 * Math.sin(s * 1.25) * Math.min(1, s / 1.5);
    const px = sx + cA * s * 0.85 - sA * wv, pz = sz + sA * s * 0.85 + cA * wv;
    const gy = inLevel ? groundAt(Math.min(ex.maxX, Math.max(ex.minX, px)), Math.min(ex.maxZ, Math.max(ex.minZ, pz))) : gS;
    slackGround.push(new THREE.Vector3(px, gy + 0.04, pz));
  }

  // ---- collider: static circle on its own body (always on) ----
  let body = null;
  if (inLevel && world && typeof Box2D !== 'undefined') {
    body = world.CreateBody(new Box2D.Dynamics.b2BodyDef());
    const c = new Box2D.Collision.Shapes.b2CircleShape(PLAT_R);
    c.SetLocalPosition(new Box2D.Common.Math.b2Vec2(x, z));
    const fd = new Box2D.Dynamics.b2FixtureDef(); fd.shape = c; fd.friction = 0.4; fd.restitution = 0.15;
    body.CreateFixture(fd);
  }

  // ---- state ----
  // 'tethered' = the 360 s cycle; 'free' = cable cut, flying off; 'gone' = for good (CUT_KEY, survives reloads)
  let stored = false;
  try { stored = localStorage.getItem(CUT_KEY) === '1'; } catch (e) { /* no storage: stays tethered */ }
  let state = stored ? 'gone' : 'tethered';
  let t = 0, h = 0, yaw = 0, near = false, started = !inLevel;   // started: the cycle clock runs (see update)
  const tilt = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), up = new THREE.Vector3(), e1 = new THREE.Euler();
  const pos = new THREE.Vector3();
  function pose() {
    h = altitude(t);
    // sway: slow cable angle (two incommensurate periods), more aloft
    const k = 0.006 + 0.034 * (h / ALT);
    e1.set(k * Math.sin(t * 2 * Math.PI / 23), 0, k * Math.sin(t * 2 * Math.PI / 31 + 1.3));
    tilt.setFromEuler(h > 0.3 ? e1 : e1.set(0, 0, 0));
    up.set(0, 1, 0).applyQuaternion(tilt);
    // rising it drifts over the sheave (landing it drifts back), aloft the cable leans a little outward
    const off = SHEAVE_R * ease(h / DRIFT_H) + LEAN * h;
    pos.set(x + cA * off, top, z + sA * off).addScaledVector(up, h);
    rig.position.copy(pos);
    qYaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    rig.quaternion.copy(tilt).multiply(qYaw);
    rig.visible = inLevel || h > 40;   // outside the level: distant scenery while it is up
    const tp = tetherGeo.attributes.position;
    tp.setXYZ(0, sheave.x, sheave.y, sheave.z); tp.setXYZ(1, pos.x, pos.y + 0.05, pos.z); tp.needsUpdate = true;
    tether.visible = h > FREE_H && (inLevel || h > 40);
  }

  // ---- fading out in the sky ----
  const fadeMats = [], lights = [];
  rig.traverse((o) => { if (o.material && !fadeMats.includes(o.material)) fadeMats.push(o.material); if (o.isLight) lights.push([o, o.intensity]); });
  fadeMats.push(ropeMat);
  let faded = false;
  let fadeA = 1;   // current sky fade (the shadow follows it)
  function setFade(a) {
    fadeA = a;
    const on = a < 1;
    if (on !== faded) { faded = on; for (const m of fadeMats) { m.transparent = on; m.needsUpdate = true; } }
    for (const m of fadeMats) m.opacity = a;
    for (const [l, i0] of lights) l.intensity = i0 * a;
  }

  // ---- the cut ----
  // trigger: the free cable from the sheave to the gondola, sampled in the car's height band
  // (street + CABLE_Y .. street + CAR_TOP), tested against the car body polygon + CUT_MARGIN
  const hv = new THREE.Vector3();
  function cableHit(car) {
    const b = car.body, fx = b?.GetFixtureList?.();
    if (!fx || typeof Box2D === 'undefined') return null;
    const p = car.getPosition();
    if (Math.hypot(p.x - sheave.x, p.y - sheave.z) > 8) return null;
    const sh = fx.GetShape();
    if (!sh?.GetVertices) return null;
    const vs = sh.GetVertices(), n = sh.GetVertexCount();
    const dy = pos.y + 0.05 - sheave.y;
    if (dy < 0.5) return null;
    for (let k = 0; k <= 6; k++) {
      const y = sheave.y + (gS + CAR_TOP - sheave.y) * k / 6;
      hv.lerpVectors(sheave, pos, Math.min(1, (y - sheave.y) / dy));
      const l = b.GetLocalPoint(new Box2D.Common.Math.b2Vec2(hv.x, hv.z));
      if (nearPoly(l.x, l.y, vs, n, CUT_MARGIN)) return hv.clone();
    }
    return null;
  }
  let fl = null;   // free flight: { t, cutY, acc, rest }
  const ropeP = [], ropeQ = [];
  for (let i = 0; i <= ROPE_N; i++) { ropeP.push(new THREE.Vector3()); ropeQ.push(new THREE.Vector3()); }
  const RDT = 1 / 60;
  function cut(cp) {
    if (state !== 'tethered') return false;
    if (ride) endRide();
    state = 'free';
    try { localStorage.setItem(CUT_KEY, '1'); } catch (e) { /* no storage: gone until the reload */ }
    const dy = Math.max(1, pos.y - sheave.y);
    const c = cp || new THREE.Vector3().lerpVectors(sheave, pos, (0.9 - CABLE_Y) / dy);
    fl = { t: 0, cutY: Math.min(CAR_TOP, Math.max(CABLE_Y + 0.05, c.y - gS)), acc: 0, rest: 0 };
    // upper piece: straight from the gondola hub to the cut, a touch shorter (it was taut) and
    // its free end recoiling upward - the snap
    hv.set(pos.x, pos.y + 0.05, pos.z);
    fl.rest = 0.97 * hv.distanceTo(c) / ROPE_N;
    for (let i = 0; i <= ROPE_N; i++) {
      ropeP[i].lerpVectors(hv, c, i / ROPE_N);
      ropeQ[i].copy(ropeP[i]); ropeQ[i].y -= 6 * (i / ROPE_N) ** 2 * RDT;
    }
    tether.visible = false; rope.visible = true; slack.visible = inLevel;
    ropeMat.opacity = 1;
    return true;
  }
  // slack on the street: the stub below the cut tips over, the winch lets SLACK_L m run out
  function setSlack(ft, cutY) {
    const sp = slackGeo.attributes.position, stub = cutY - CABLE_Y;
    const Lvis = stub + (SLACK_L - stub) * ease((ft - 0.2) / 1.8);
    const fall = ease((ft - 0.1) / 0.8), bounce = 0.12 * Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (ft - 0.9) / 0.5))));
    for (let i = 0; i <= SLACK_N; i++) {
      const s = Lvis * i / SLACK_N, f = Math.min(SLACK_N, s / SLACK_L * SLACK_N), i0 = Math.floor(f), i1 = Math.min(SLACK_N, i0 + 1);
      const g0p = slackGround[i0], g1p = slackGround[i1], u = f - i0;
      const gx = g0p.x + (g1p.x - g0p.x) * u, gy = g0p.y + (g1p.y - g0p.y) * u, gz = g0p.z + (g1p.z - g0p.z) * u;
      const k = s > stub ? 1 : fall;   // the paid-out part slides along the street
      const vy = sheave.y + Math.min(s, stub);
      sp.setXYZ(i, sx + (gx - sx) * k, vy + (gy - vy) * k + bounce * (s / SLACK_L), sz + (gz - sz) * k);
    }
    sp.needsUpdate = true;
  }
  function ropeStep(vw) {
    const hub = ropeP[0]; hub.set(pos.x, pos.y + 0.05, pos.z); ropeQ[0].copy(hub);
    const wx = WIND[0] * vw * RDT, wz = WIND[1] * vw * RDT, floor = gS + 0.05;
    for (let i = 1; i <= ROPE_N; i++) {   // verlet, air drag toward the wind's speed
      const p = ropeP[i], q = ropeQ[i];
      const vx = (p.x - q.x) * 0.98 + wx * 0.02, vy = (p.y - q.y) * 0.98, vz = (p.z - q.z) * 0.98 + wz * 0.02;
      q.copy(p);
      p.x += vx; p.y += vy - 9.8 * RDT * RDT; p.z += vz;
      if (p.y < floor) p.y = floor;
    }
    for (let it = 0; it < 8; it++) for (let i = 0; i < ROPE_N; i++) {
      const a = ropeP[i], b = ropeP[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz) || 1e-6, e = (d - fl.rest) / d;
      if (i === 0) { b.x -= dx * e; b.y -= dy * e; b.z -= dz * e; }
      else { a.x += dx * e * 0.5; a.y += dy * e * 0.5; a.z += dz * e * 0.5; b.x -= dx * e * 0.5; b.y -= dy * e * 0.5; b.z -= dz * e * 0.5; }
    }
  }
  const lean = new THREE.Vector3(-WIND[1], 0, WIND[0]);
  function fly(dt) {
    const f = fl; f.t += dt;
    // a small hop at the snap, then slowly faster up and away with the wind, turning a little
    const vy = 0.5 + 6.5 * ease(f.t / 60) + 1.6 * Math.exp(-f.t / 0.8);
    const vw = 9 * ease(f.t / 45);
    pos.x += WIND[0] * vw * dt; pos.y += vy * dt; pos.z += WIND[1] * vw * dt;
    yaw += dt * (0.012 + 0.05 * ease(f.t / 25));
    const rock = 0.07 * Math.exp(-f.t / 6) * Math.sin(f.t * 1.7) - 0.03 * ease(f.t / 20);
    tilt.setFromAxisAngle(lean, rock);
    qYaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    rig.position.copy(pos); rig.quaternion.copy(tilt).multiply(qYaw); rig.visible = true;
    h = pos.y - top;
    f.acc += dt;
    while (f.acc >= RDT) { ropeStep(vw); f.acc -= RDT; }
    const rp = ropeGeo.attributes.position;
    for (let i = 0; i <= ROPE_N; i++) rp.setXYZ(i, ropeP[i].x, ropeP[i].y, ropeP[i].z);
    rp.needsUpdate = true;
    setSlack(f.t, f.cutY);
    if (f.t >= FLY_FADE[0]) {
      const a = 1 - (f.t - FLY_FADE[0]) / (FLY_FADE[1] - FLY_FADE[0]);
      if (a > 0) setFade(a);
      else { state = 'gone'; fl = null; rig.visible = false; rope.visible = false; }
    }
  }
  function poseGone() {
    rig.visible = false; tether.visible = false; rope.visible = false;
    slack.visible = inLevel; setSlack(99, 0.9);
  }
  if (state === 'gone') poseGone(); else pose();

  // ---- shadow on the ground (owner: "see the balloon's shadow ... till it disappears") ----
  // A soft ellipse cast along the car's sun direction (sunOffset = index.html SUN_OFFSET, metres
  // of ground offset per metre of height, matched to the shadows baked into the photo texture).
  // On the platform it lies under the balloon, dark and fairly crisp; climbing, it slides off by
  // h x sunOffset, grows a little, its penumbra widens and it fades out between fadeFrom and fadeTo
  // (m above the platform) - it never shrinks to a dot. Coming down the reverse; after a cut it
  // races off with the balloon and fades as it climbs. Drawn: one (G+1)^2 vertex grid over the
  // ellipse's box, draped on groundAt + lift (re-draped only when it moved > 1 m, changed size or
  // once a second for streamed tiles), depth-tested against the world, no depth writes, pulled
  // `bias` m toward the camera in draw() + polygon offset (the car passes' trick: the height model
  // lies up to ~1-2 m under the mesh road). groundAt knows no roofs: where the shadow slides over a
  // building it is hidden by the facade / roof (depth test) instead of lying on the roof.
  // Live tuning: berlinDrive.balloon.shadow (= SHADOW), e.g. .fadeTo = 90; grid is read once at creation.
  const SHADOW = { size: 22, opacity: 0.35, moon: 0.12, fadeFrom: 4, fadeTo: 100, soften: 0.6, grow: 0.25, grid: 8, lift: 1.0, bias: 4 };
  const sunOff = Array.isArray(sunOffset) && Math.hypot(sunOffset[0], sunOffset[1]) > 1e-3 ? sunOffset : [0.9, -0.55];
  const sunL = Math.hypot(sunOff[0], sunOff[1]), sdx = sunOff[0] / sunL, sdz = sunOff[1] / sunL;
  const sunElong = Math.sqrt(1 + sunL * sunL);   // a sphere's shadow at this sun elevation: drawn out along the sun
  const SG = SHADOW.grid, SN = SG + 1;
  const shPos = new Float32Array(SN * SN * 3), shE = new Float32Array(SN * SN * 2), shIdx = [];
  for (let j = 0; j < SN; j++) for (let i = 0; i < SN; i++) {
    shE[2 * (j * SN + i)] = -1 + 2 * i / SG; shE[2 * (j * SN + i) + 1] = -1 + 2 * j / SG;
    if (i < SG && j < SG) { const a = j * SN + i; shIdx.push(a, a + SN, a + 1, a + 1, a + SN, a + SN + 1); }
  }
  const shGeo = new THREE.BufferGeometry();
  shGeo.setAttribute('position', new THREE.BufferAttribute(shPos, 3));
  shGeo.setAttribute('aE', new THREE.BufferAttribute(shE, 2));
  shGeo.setIndex(shIdx);
  const shColor = new THREE.Color(mname === 'snow' ? 0x16223c : 0x000000);
  const shMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: shColor }, uOpacity: { value: 0 }, uSoft: { value: 0.12 } },
    vertexShader: 'attribute vec2 aE; varying vec2 vE; void main() { vE = aE; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; uniform float uSoft; varying vec2 vE;\n' +
      'void main() { float a = uOpacity * (1.0 - smoothstep(1.0 - uSoft, 1.0, length(vE))); if (a < 0.002) discard; gl_FragColor = vec4(uColor, a); }',
    transparent: true, depthWrite: false, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const shMesh = new THREE.Mesh(shGeo, shMat);
  shMesh.frustumCulled = false; shMesh.visible = false; shMesh.renderOrder = -1;   // before the balloon's own parts
  scene.add(shMesh);
  const shAt = { x: NaN, z: NaN, a: 0, b: 0, age: 0 }, shC = new THREE.Vector3();
  const clampX = (v) => Math.min(ex.maxX, Math.max(ex.minX, v)), clampZ = (v) => Math.min(ex.maxZ, Math.max(ex.minZ, v));
  function updateShadow(dt) {
    shMesh.visible = false;
    if (!inLevel || state === 'gone' || !rig.visible) return;
    const hh = Math.max(0, h);
    const u = Math.min(1, hh / SHADOW.fadeTo);
    const fade = 1 - ease((hh - SHADOW.fadeFrom) / Math.max(1, SHADOW.fadeTo - SHADOW.fadeFrom));
    const base = mname === 'moon' ? SHADOW.moon : SHADOW.opacity;
    const alpha = base * fade * fadeA;
    if (alpha < 0.003) return;
    const cx = pos.x + sunOff[0] * hh, cz = pos.z + sunOff[1] * hh;
    // only near: the camera (chase or ride) or the car within ~400 m of the shadow
    const car = vehicle(), cp = car && car.getPosition();
    const dCam = Math.hypot(camera.position.x - cx, camera.position.z - cz), dCar = cp ? Math.hypot(cp.x - cx, cp.y - cz) : Infinity;
    if (Math.min(dCam, dCar) > 400 + SHADOW.size) return;
    const b = SHADOW.size / 2 * (1 + SHADOW.grow * u), a = b * (1.1 + (sunElong - 1.1) * u);
    shMat.uniforms.uOpacity.value = alpha;
    shMat.uniforms.uSoft.value = Math.min(0.95, 0.12 + SHADOW.soften * u);
    shAt.age += dt;
    if (!(Math.hypot(cx - shAt.x, cz - shAt.z) < 1 && Math.abs(a - shAt.a) < 0.4 && Math.abs(b - shAt.b) < 0.4 && shAt.age < 1)) {
      shAt.x = cx; shAt.z = cz; shAt.a = a; shAt.b = b; shAt.age = 0;
      for (let k = 0; k < SN * SN; k++) {
        const e0 = shE[2 * k] * a, e1v = shE[2 * k + 1] * b;
        const px = cx + sdx * e0 - sdz * e1v, pz = cz + sdz * e0 + sdx * e1v;
        shPos[3 * k] = px; shPos[3 * k + 1] = groundAt(clampX(px), clampZ(pz)) + SHADOW.lift; shPos[3 * k + 2] = pz;
      }
      shGeo.attributes.position.needsUpdate = true;
    }
    shMesh.visible = true;
  }

  // ---- ride (E next to the platform while the balloon is down): camera with the gondola ----
  let ride = null;   // { t, a, out } ; out = blend-out time or null
  const camFrom = new THREE.Vector3(), qFrom = new THREE.Quaternion(), eye = new THREE.Vector3(), look = new THREE.Vector3();
  const tmpCam = new THREE.Object3D();
  function startRide() {
    if (ride || !inLevel || state !== 'tethered') return false;
    if (t % CYCLE < SEG[0] - 4) t = t - (t % CYCLE) + SEG[0] - 4;   // board, then lift off after a few seconds
    ride = { t: 0, a: Math.atan2(camera.position.z - z, camera.position.x - x) + Math.PI, out: null, started: t };
    return true;
  }
  function endRide() { if (ride && ride.out === null) ride.out = 0; }
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (ride && ride.out === null) { endRide(); return; }
    if ((e.key === 'e' || e.key === 'E') && near && !ride) startRide();
  });
  function rideCamera(dt) {
    ride.t += dt;
    ride.a += dt * (2 * Math.PI / 150);   // one slow turn every 2.5 min
    const ca = Math.cos(ride.a), sa = Math.sin(ride.a);
    eye.set(pos.x + ca * (G_OUT - 0.7), pos.y + 1.7, pos.z + sa * (G_OUT - 0.7));
    look.set(eye.x + ca * 100, eye.y - 100 * Math.tan(THREE.MathUtils.degToRad(h > 30 ? 18 : 6)), eye.z + sa * 100);
    tmpCam.position.copy(eye); tmpCam.up.set(0, 1, 0); tmpCam.lookAt(look);
    // blend from / back to the chase camera (it was set this frame by index.html's updateCamera)
    let k;
    if (ride.out !== null) { ride.out += dt; k = 1 - ease(ride.out / 1.5); if (ride.out >= 1.5) { ride = null; return; } }
    else k = ease(ride.t / 2);
    camFrom.copy(camera.position); qFrom.copy(camera.quaternion);
    camera.position.lerpVectors(camFrom, eye, k);
    camera.quaternion.slerpQuaternions(qFrom, tmpCam.quaternion, k);
    camera.updateMatrixWorld();
    // one cycle: ends when it is back on the ground
    if (ride.out === null && ride.t > SEG[1] && h < 0.05) endRide();
  }

  function update(dt) {
    // owner (2026-11-21): the balloon waits on the platform until the car first comes near, then
    // stays down WAIT_GROUND s more and only then lifts off (the cable is cuttable only once it is up:
    // FREE_H). After that the 360 s cycle runs on as before.
    if (!started) {
      const c0 = vehicle(), p0 = c0 && c0.getPosition();
      if (ride || (inLevel && p0 && Math.hypot(p0.x - x, p0.y - z) < START_DIST)) { started = true; t = Math.max(t, SEG[0] - WAIT_GROUND); }
    } else t += dt;
    if (state === 'tethered') { yaw += dt * 0.012; pose(); }
    else if (state === 'free') fly(dt);
    const car = vehicle();
    near = false;
    if (state === 'tethered' && inLevel && car && !ride) {
      const p = car.getPosition();
      near = Math.hypot(p.x - x, p.y - z) < RIDE_DIST && Math.abs(car.speedKmh) < 3 && h < 0.05;
      // the car's body through the free cable: cut (not while it is on the rails / in a tunnel / on a roof)
      if (h > FREE_H && !busy()) { const c = cableHit(car); if (c) cut(c); }
    }
    if (ride) rideCamera(dt);
    updateShadow(dt);
  }
  function draw(renderer, cam) {
    const ac = renderer.autoClear; renderer.autoClear = false;
    if (shMesh.visible) {   // camera bias: pull the draped grid toward the camera (vertices are world coords)
      const mid = 3 * ((SN * SN) >> 1);
      shC.set(cam.position.x - shAt.x, cam.position.y - shPos[mid + 1], cam.position.z - shAt.z).normalize().multiplyScalar(SHADOW.bias);
      shMesh.position.copy(shC);
    }
    renderer.render(scene, cam);
    renderer.autoClear = ac;
  }
  // console: play the cut without driving (on the platform it goes up first), bring it back for good
  function cutNow() {
    if (state !== 'tethered') return false;
    if (h <= FREE_H + 5) { t = SEG[0] + SEG[1] + 5; pose(); }   // put it aloft first
    return cut(null);
  }
  function restore() {
    try { localStorage.removeItem(CUT_KEY); } catch (e) { /* nothing stored */ }
    state = 'tethered'; fl = null;
    setFade(1); rope.visible = false; slack.visible = false;
    t = 0; pose();   // back on the platform, at the start of a cycle
    return true;
  }
  const latlon = { lat: BALLOON.lat, lon: BALLOON.lon };
  return {
    update, draw, scene, rig, body, inLevel,
    shadow: SHADOW,   // ground shadow tuning, e.g. balloon.shadow.fadeTo = 90 (grid fixed at creation)
    get position() { return pos.clone(); },   // gondola floor centre (level frame)
    get height() { return h; },               // m above the platform
    get phase() { return ((t % CYCLE) + CYCLE) % CYCLE; },   // s in the 360 s cycle (0-60 ground, 60-150 up, 150-270 aloft, 270-360 down)
    setPhase(s) { t = +s || 0; if (state === 'tethered') pose(); return h; },
    get near() { return near; }, get riding() { return !!ride; }, startRide, endRide,
    // cut cable: state 'tethered' | 'free' (flying off) | 'gone'; stored as localStorage berlinDrive.balloon.cut = '1'
    get state() { return state; }, get cut() { return state !== 'tethered'; }, cutNow, restore,
    platform: { x, z, r: PLAT_R, top }, sheave: { x: sx, z: sz, y: sheave.y },
    cycle: { total: CYCLE, segments: SEG.slice(), altitude: ALT },
    items() { return [{ id: 'balloon', kind: 'balloon', name: BALLOON.name, ...latlon, x, z, gone: state !== 'tethered' }]; },
  };
}

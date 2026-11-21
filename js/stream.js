// Tile streamer for levels built by build_stream.py (3D Tiles b3dm straight from disk
// via serve.py /tiles/). Own small implementation: 3d-tiles-renderer needs three >= 0.167.
//   select  every 100 ms from the roots: sphere frustum cull; a tile refines when its
//           screen-space error ge * H / (2 d tan(fov/2)) > tau_eff AND all its children are
//           loaded (REPLACE without partial states: whatever is drawn is complete, a drawn
//           region never falls back to a coarser tile because one child is missing).
//           tau_eff = tau x speed factor (car speed: 1 up to 50 km/h, 1.75 at 110, 2 at 160) x mild
//           foveation (x1.35 at the screen edge, x1.25 beyond ~1.5 km) x budget governor
//           (1 unless the view set nears the budget). Hysteresis: a refined tile coarsens
//           only below HYST * tau * governor (speed / screen edge never take detail away
//           that is on screen, they only hold back new refinement and look-ahead loads).
//           No LOD change of a region while its cross-fade still runs.
//   admit   a refinement requests its missing children only if their estimated size fits
//           the budget room left by the view set (else the parent stays and the governor
//           raises tau until it fits)
//   load    parents first (a tile is requested only once its parent is in), all children
//           of a refining tile (also those outside the view: turning shows them at once);
//           then a look-ahead: the same selection for the camera predicted 1.5 s and 3 s
//           ahead (velocity + yaw rate, wider fov; the 3 s one at 1.3x tau), prefetchAt()
//           regions, L1 within RING_R of the car (below 90 km/h), the base layer.
//           A free request slot is refilled at once from the sorted queue.
//   base    all roots (49 L4 tiles) stay loaded and are never evicted, counted in the
//           budget, when they fit in BASE_SHARE of it, so there is never a hole and the far
//           city is always there. L4 and L3 textures are halved (linear, DOWNSCALE) before
//           the upload: they are only drawn from ~1.2 km / ~0.6 km on, where a texel of the
//           halved texture is about one screen pixel (and there are no mipmaps: the tiles'
//           sampler is LINEAR, so full size only aliased there)
//   jump    after a teleport (camera moved > 150 m between selections) the tiles within
//           JUMP_R of the car go first (the whole parent chain requested at once, coarse
//           first), and the look-ahead pauses until that
//           area is drawn at L1 (stats().jump: time to sharp, time with L4 there)
//   cancel  a request no longer wanted for 250 ms is aborted (AbortController; bytes that
//           already arrived are dropped before parsing); a near tile waiting behind a full
//           pipe pre-empts the farthest look-ahead request; a loaded tile nobody touched for
//           250 ms is discarded before its parse / its upload (obsolete after a turn / jump)
//   enter   new tiles join the scene time-sliced: textures are uploaded (initTexture) until
//           ENTER_MS have passed in a frame - checked after each tile, so one big tile can
//           overrun it; dither cross-fade (FADE_MS) only where a drawn parent / child is
//           being replaced, a tile with nothing behind it appears at once
//   evict   LRU over the budget; never a tile touched by the last selection (drawn,
//           ancestors, siblings, look-ahead, prefetch) or fading or in the base layer; over
//           budget the ring / prefetch / look-ahead go first (least relevant this pass first)
//   occlude a tile that would refine but is hidden behind buildings (occlusion.json from
//           build_occluders.py: 4 m grid of building heights kept safely low + per tile the
//           tops of all its content) from the camera AND from eyes 0.75 / 1.5 / 2.25 / 3 s
//           ahead (OCC_LEADS, the look-ahead poses) does not refine: its own level stays
//           drawn, its children are neither requested nor pinned. Never within RING_R of the
//           car (while the ring runs) or OCC_NEAR of an eye. Hidden only after OCC_HOLD ms
//           without being seen; seen again = refines at once. Verdicts are reused for
//           OCC_STALE ms and computed within a work budget per pass (OCC_WORK). Off:
//           setOcclusion(false) (localStorage 'berlinDrive.occlusion' = '0'). See makeOcclusion.
// stats(): counts, MB, .events: downgrade / hole / evict / thrash / cancel counters (headless
// checks, see MITTE_STREAMING_PLAN.md "Streaming fixes"), .occlusion (kept / keptTotal ...).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchBin } from './site.js';   // occlusion.bin, gzipped name on the published site

const MAX_INFLIGHT = 6, SELECT_MS = 100, RETRY_MS = 3000, ENTER_MS = 4;
const HYST = 0.7, FADE_MS = 350, CANCEL_MS = 250, BASE_SHARE = 0.35, GOV_MAX = 3;
const LEADS = [1.5, 3], LEAD_TAU = [1, 1.3], LEAD_FOV = 1.3, RING_R = 120, RING_KMH = 90;  // s, x tau, fov factor, m, km/h
const DOWNSCALE = { 4: 0.5, 3: 0.5 };   // texture scale (linear) per level, applied before the upload
const JUMP_R = 80;                        // m around the car that must be L1 after a jump
const P_SIB = 400, P_LEAD = 1e5, P_PREF = 2.5e5, P_RING = 3e5, P_BASE = 4e5;   // queue offsets (m)
const OCC_HOLD = 1000;   // ms a tile must stay hidden without a break before it stops refining
const OCC_LEADS = [0.75, 1.5, 2.25, 3];   // s: occlusion eyes ahead (include the LEADS)
const OCC_WORK = 6000, OCC_STALE = 300, OCC_OLD = 1000;   // work units per pass (ray samples + 20 per box test); verdict age (ms): recomputed / unusable
const NONE = 0, LOADING = 1, PARSED = 2, READY = 3, FAILED = 4;
const OFF = 0, IN = 1, ON = 2, OUT = 3;                              // fade modes
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// dither fade, chained after whatever onBeforeCompile the material has (mood grade):
// uFade = a >= 0: fragment kept where hash < a (fading in, 1 = solid);
// uFade = -a: kept where hash >= 1 - a (fading out). In and out are complementary per
// pixel, so parent and children neither overlap nor leave gaps during a swap.
const FADE_GLSL = `uniform float uFade;
void main() {
  if (uFade < 1.0) {
    float fh = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (uFade >= 0.0 ? fh >= uFade : fh < 1.0 + uFade) discard;
  }`;
function addFade(mat, u) {
  const inner = mat.onBeforeCompile;
  const hasInner = inner !== THREE.Material.prototype.onBeforeCompile;
  const innerKey = mat.customProgramCacheKey();   // the mood's own key (default: its onBeforeCompile source)
  mat.onBeforeCompile = function (sh, r) {
    if (hasInner) inner.call(this, sh, r);
    sh.uniforms.uFade = u;
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', FADE_GLSL);
  };
  mat.customProgramCacheKey = () => innerKey + '|streamfade1';
  mat.needsUpdate = true;
}
function disposeObj(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    const map = o.material.map;
    if (map) { map.dispose(); map.image?.close?.(); }   // ImageBitmap from GLTFLoader
    o.material.dispose();
  });
}

// --- occlusion core (plain math, no three.js; replayed offline in Node, see MITTE_STREAMING_PLAN.md) ---
// Occluders: 2.5D columns (grid cell fully covered by a building, top Y safely low).
// Per eye, the full circle is cut into OCC_RAYS wedges (1 deg). Each wedge is marched lazily
// along its centre line, one sample per grid cell: H(k) = max over samples s <= k of
// (top_s - eyeY) / r_s, where top_s is the LOWEST occluder top within the wedge's half width
// at r_s around the sample (min-filtered grids: 3 x 3 cells up to ~460 m, 5 x 5 beyond; no
// sample beyond that). So every sight line inside the wedge crosses, at r_s, a column at least
// top_s high: a point in the wedge beyond r_k whose elevation (y - eyeY) / r is below H(k)
// is hidden - for every direction in the wedge, no gaps between rays. Rays end at OCC_RANGE,
// when they leave the grid, or once H is so high nothing up to the tallest content tops (99th
// pct) could look over it; H then stays constant, which only under-states it (safe).
// A content box (a tile's tops quadtree node: its highest point) is hidden from an eye when
// every wedge its azimuth span touches has H at the box's nearest distance above the box's
// highest elevation (top over nearest distance; over farthest when the top is below the eye).
const OCC_RAYS = 360, OCC_RANGE = 500, OCC_NEAR = 20;   // wedges, m, m
export function makeOcclusion(meta, buf, nEyes = 3) {
  const g = meta.grid, nx = g.nx, nz = g.nz, cell = g.cell, gx0 = g.x0, gn0 = g.n0, gb = g.base, gs = g.step;
  const grid = new Uint8Array(buf, g.offset, nx * nz);     // height codes, 0 = no occluder
  // min filter 3 x 3 (cells outside the grid = none): code order = height order, 0 = none wins
  const min3 = (src) => {
    const t = new Uint8Array(nx * nz), o = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 1; i < nx - 1; i++) { const c = j * nx + i; t[c] = Math.min(src[c - 1], src[c], src[c + 1]); }
    for (let j = 1; j < nz - 1; j++) for (let i = 0; i < nx; i++) { const c = j * nx + i; o[c] = Math.min(t[c - nx], t[c], t[c + nx]); }
    return o;
  };
  const e1 = min3(grid), e2 = min3(e1);
  const DA = 2 * Math.PI / OCC_RAYS, NSTEP = Math.ceil(OCC_RANGE / cell);
  const invR = new Float64Array(NSTEP), lvS = new Uint8Array(NSTEP);   // 1 / r and filter radius per sample
  for (let s = 0; s < NSTEP; s++) {
    const r = (s + 1) * cell;
    invR[s] = 1 / r;
    lvS[s] = Math.ceil(2 * r * Math.sin(DA / 4) / cell);    // cells a sight line in the wedge can be off the sample
  }
  const G = meta.tops.g, tops = new Uint16Array(buf, meta.tops.offset, meta.tops.count * G * G);
  const LQ = Math.round(Math.log2(G));
  if (1 << LQ !== G) throw new Error('occlusion: tops grid must be a power of 2');
  const info = new Map();
  let all = [];
  meta.tiles.forEach(([ti, x0, z0, x1, z1], n) => {
    const q = [];                                            // q[lv]: (2^lv)^2 maxima, m
    q[LQ] = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) { const v = tops[n * G * G + k]; q[LQ][k] = v / 10; all.push(v); }
    for (let lv = LQ - 1; lv >= 0; lv--) {
      const w = 1 << lv, f = q[lv + 1];
      q[lv] = new Float32Array(w * w);
      for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
        q[lv][j * w + i] = Math.max(f[2 * j * 2 * w + 2 * i], f[2 * j * 2 * w + 2 * i + 1], f[(2 * j + 1) * 2 * w + 2 * i], f[(2 * j + 1) * 2 * w + 2 * i + 1]);
      }
    }
    info.set(ti, { x0, z0, x1, z1, q });
  });
  all = all.filter((v) => v > 0).sort((a, b) => a - b);
  const yCap = all.length ? all[Math.floor(all.length * 0.99)] / 10 : 1e9;   // ray stop height
  all = null;
  const cos = new Float64Array(OCC_RAYS), sin = new Float64Array(OCC_RAYS);
  for (let a = 0; a < OCC_RAYS; a++) { cos[a] = Math.cos(a * DA); sin[a] = Math.sin(a * DA); }
  const eyes = [];
  for (let e = 0; e < nEyes; e++) {
    eyes.push({ x: 0, y: 0, n: 0, gen: 1, rg: new Int32Array(OCC_RAYS), done: new Int32Array(OCC_RAYS),
                cur: new Float64Array(OCC_RAYS), end: new Uint8Array(OCC_RAYS), H: new Float32Array(OCC_RAYS * NSTEP) });
  }
  const st = { rays: 0, samples: 0, boxes: 0 };
  // does ray a's horizon up to sample k (cumulative max) rise above el? Marched on demand and
  // only as far as needed: it stops at the first sample that already beats el
  function above(E, a, k, el) {
    if (E.rg[a] !== E.gen) { E.rg[a] = E.gen; E.done[a] = 0; E.cur[a] = -Infinity; E.end[a] = 0; st.rays++; }
    let s = E.done[a];
    const o = a * NSTEP, H = E.H;
    if (k < s) return H[o + k] > el;
    let cur = E.cur[a];
    if (cur > el) return true;                    // H only grows with k
    if (E.end[a]) return false;                   // ended: H stays cur
    const du = cos[a], dv = sin[a];
    const u0 = (E.x - gx0) / cell, v0 = (E.n - gn0) / cell, ey = E.y, cap = yCap - ey, s0 = s;
    let hit = false;
    for (; s <= k; s++) {
      const lv = lvS[s];
      if (lv > 2) { E.end[a] = 1; break; }                   // wedge too wide for the filtered grids
      const i = Math.floor(u0 + (s + 1) * du), j = Math.floor(v0 + (s + 1) * dv);
      if (i < 0 || j < 0 || i >= nx || j >= nz) {
        // outside the grid: stop once the ray points away from it (it cannot come back)
        if ((i < 0 && du <= 0) || (i >= nx && du >= 0) || (j < 0 && dv <= 0) || (j >= nz && dv >= 0)) { E.end[a] = 1; break; }
      } else {
        const v = (lv === 1 ? e1 : e2)[j * nx + i];
        if (v) { const e = (gb + v * gs - ey) * invR[s]; if (e > cur) cur = e; }
      }
      H[o + s] = cur;
      if (cur > el) { s++; hit = true; break; }
      if (cur >= cap * invR[s]) { s++; E.end[a] = 1; break; }
    }
    st.samples += s - s0;
    E.done[a] = s; E.cur[a] = cur;
    return hit;
  }
  // box x0..x1 / z0..z1 with everything in it at or below yTop: hidden from eye E?
  function boxHidden(E, x0, z0, x1, z1, yTop) {
    st.boxes++;
    const n0 = -z1, n1 = -z0;
    const dx = Math.max(x0 - E.x, 0, E.x - x1), dn = Math.max(n0 - E.n, 0, E.n - n1);
    const rmin = Math.hypot(dx, dn);
    if (rmin < OCC_NEAR) return false;
    const k = Math.min(NSTEP - 1, Math.floor(rmin / cell) - 1);   // samples in front of the box
    const rmax = Math.hypot(Math.max(Math.abs(x0 - E.x), Math.abs(x1 - E.x)), Math.max(Math.abs(n0 - E.n), Math.abs(n1 - E.n)));
    const el = (yTop - E.y) / (yTop > E.y ? rmin : rmax);
    const ac = Math.atan2((n0 + n1) / 2 - E.n, (x0 + x1) / 2 - E.x);
    let lo = 0, hi = 0;
    for (let q = 0; q < 4; q++) {
      let d = Math.atan2((q & 1 ? n1 : n0) - E.n, (q & 2 ? x1 : x0) - E.x) - ac;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      if (d < lo) lo = d; else if (d > hi) hi = d;
    }
    const a0 = Math.ceil((ac + lo) / DA - 0.5), a1 = Math.floor((ac + hi) / DA + 0.5);   // wedge a = (a +- 0.5) * DA
    for (let a = a0; a <= a1; a++) if (!above(E, ((a % OCC_RAYS) + OCC_RAYS) % OCC_RAYS, k, el)) return false;
    return true;
  }
  // quadtree over a tile's G x G tops (G = 8: levels 1, 2, 4, 8 cells a side), each node the
  // highest top below it: a hidden node settles its whole quarter in one test, a visible tile
  // walks down the side facing the eye and ends at its first visible column
  function hiddenQ(E, I, lv, i, j) {
    const w = 1 << lv, top = I.q[lv][j * w + i];
    if (!top) return true;                                   // no content there
    const sx = (I.x1 - I.x0) / w, sz = (I.z1 - I.z0) / w;
    const x0 = I.x0 + i * sx, z0 = I.z0 + j * sz;
    if (boxHidden(E, x0, z0, x0 + sx, z0 + sz, top)) return true;
    if (lv === LQ) return false;
    // children, the one on the eye's side first (x = east, z = -north = -E.n)
    const fi = E.x > x0 + sx / 2 ? 1 : 0, fj = -E.n > z0 + sz / 2 ? 1 : 0;
    return hiddenQ(E, I, lv + 1, 2 * i + fi, 2 * j + fj) && hiddenQ(E, I, lv + 1, 2 * i + 1 - fi, 2 * j + fj) &&
           hiddenQ(E, I, lv + 1, 2 * i + fi, 2 * j + 1 - fj) && hiddenQ(E, I, lv + 1, 2 * i + 1 - fi, 2 * j + 1 - fj);
  }
  return {
    yCap, stats: st,
    has: (ti) => info.has(ti),
    // eye e at level coords (x, y, z); a new position drops that eye's horizons
    setEye(e, x, y, z) { const E = eyes[e]; E.x = x; E.y = y; E.n = -z; E.gen++; },
    // tile ti hidden from eyes 0 .. m-1 (all of them)
    hidden(ti, m = 1) {
      const I = info.get(ti);
      if (!I) return false;
      for (let e = 0; e < m; e++) if (!hiddenQ(eyes[e], I, 0, 0, 0)) return false;
      return true;
    },
  };
}
// --- end occlusion core ---

// keepBase: the base layer (see above); aniso: anisotropic filtering for new tiles (Detail)
// tiles: tile root URL (site.json on the published site); unset = tiles.json's "base"
export async function createStreamer({ scene, camera, renderer, mood, url, tiles: tilesUrl = null, budgetMB = 768, tau = 24, aniso = 4, keepBase = true }) {
  // occlusion data next to tiles.json (build_occluders.py); missing = no occlusion step
  const occUrl = new URL('occlusion.json', new URL(url, document.baseURI)).href;
  const occP = fetch(occUrl).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const meta = await r.json();
    let b = await fetchBin(new URL(meta.file, occUrl).href).then((r2) => { if (!r2.ok) throw new Error(`HTTP ${r2.status}`); return r2.arrayBuffer(); });
    const m = new Uint8Array(b, 0, 2);
    if (m[0] === 0x1f && m[1] === 0x8b) b = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return makeOcclusion(meta, b, 1 + OCC_LEADS.length);
  }).catch((e) => { console.info('stream: no occlusion data (build_occluders.py):', e.message || e); return null; });
  const doc = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status} - run build_stream.py`);
    return r.json();
  });
  const occ = await occP;
  let occOn = true;
  try { occOn = localStorage.getItem('berlinDrive.occlusion') !== '0'; } catch (e) { /* no storage */ }
  // per pass: tiles kept from refining / refined tiles coarsened / verdicts / hidden / ms
  const occSt = { kept: 0, keptTotal: 0, coarsened: 0, coarsenedTotal: 0, aheadKept: 0, tested: 0, reused: 0, skipped: 0, hidden: 0,
                  ms: 0, msMax: 0, msSum: 0, passes: 0, work: 0, work0: 0, workMax: 0 };
  let occEyes = 1, ringOn = false, carNow = null, occFrom = 0;   // occFrom: verdicts older than this are void (jump)
  const base = new URL(tilesUrl || doc.base, document.baseURI).href;   // tile paths are relative to the page (or site.json's tiles URL)
  const tiles = doc.tiles.map((t, i) => ({
    i, path: t[0], level: t[1], parent: null, pi: t[2], c: new THREE.Vector3(t[3], t[4], t[5]), r: t[6],
    m: new THREE.Matrix4().set(...t.slice(7, 19), 0, 0, 0, 1), leaf: !!t[19], ge: doc.ge[t[1]],
    kids: [], state: NONE, obj: null, bytes: 0, used: 0, failedAt: 0, refined: false, base: false,
    pin: -1, pinMain: -1, rel: 0, prio: 0, mode: OFF, a: 0, fadeU: { value: 1 }, readyAt: 0, reqAt: 0, evictedAt: 0,
    ac: null, cancelled: false, cancelledAt: 0, wantAt: 0, occPass: -1, occHid: false, occSeen: 0, occRaw: false, occAt: -1e9,
  }));
  const roots = [], finest = [];
  for (const t of tiles) {
    if (t.pi >= 0) { t.parent = tiles[t.pi]; t.parent.kids.push(t); } else roots.push(t);
    if (t.leaf && t.level === 1) finest.push(t);
  }
  // culling sphere: own sphere grown over all descendants' (a child's sphere can stick out
  // of its parent's; culling by the parent's alone dropped visible children at the edge)
  for (const t of [...tiles].sort((a, b) => a.level - b.level)) {
    t.cs = new THREE.Sphere(t.c.clone(), t.r);
    for (const c of t.kids) t.cs.union(c.cs);
  }
  const loader = new GLTFLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  aniso = Math.max(1, Math.min(maxAniso, aniso));
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  const pcam = new THREE.PerspectiveCamera(), eye = new THREE.Vector3(), fwd = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), lastEye = new THREE.Vector3();
  const _pos = { x: 0, y: 0, z: 0 };
  const leadPos = LEADS.map(() => new THREE.Vector3()), leadQ = LEADS.map(() => new THREE.Quaternion());
  const occPos = OCC_LEADS.map(() => new THREE.Vector3());
  let budget = budgetMB * 1e6, bytes = 0, baseBytes = 0, inflight = 0, queued = 0, lastSelect = -1e9, now = 0, lastNow = 0;
  let want = new Map(), draw = new Set(), next = new Set(), dirty = true, pass = 0, over = false;
  let yaw = null, yawRate = 0, lastCar = 0, halfDiag = 0.5;
  let eyeT = 0, speed = 0, speedF = 1, kmh = 0;                       // camera speed (m/s), tau factor
  let baseOn = false, gov = 1, mainBytes = 0, prevMain = 0, pendMiss = 0, room = budget, mainMissing = 1;
  const enterQ = [], waiters = [], fading = new Set(), loading = new Set();
  const out = [], q = [], cand = [], regions = [];
  const lvSum = {}, lvN = {};                                          // GPU bytes per level, for estimates
  const est = (l) => (lvN[l] ? lvSum[l] / lvN[l] : 7e6);
  let qi = 0, peak = 0, reservedB = 0, jumpAt = 0, jumpL4 = 0;
  const jump = { n: 0, sharpMs: null, l4Ms: null, pending: false };
  // counters for checks: downgrade = a tile drawn last pass, still in view, now replaced by a
  // drawn ancestor; hole = a visible part of it now covered by nothing; thrash = a request for
  // a tile evicted < 10 s before; cancel = requests aborted (dropped = bytes had arrived,
  // preempt = aborted for a nearer tile, recancel = re-requested < 5 s after a cancel);
  // admit = refinements held back because the children would not fit the budget;
  // occDowngrade = like downgrade, but the drawn ancestor was judged hidden (occlusion step)
  const ev = { downgrade: 0, hole: 0, evict: 0, thrash: 0, req: 0, enter: 0, cancel: 0, dropped: 0, preempt: 0,
               recancel: 0, admit: 0, jump: 0, occDowngrade: 0, obsoleteAvoided: 0, obsoleteUploaded: 0, latSum: 0, latN: 0, latMax: 0 };
  // loaded tile nobody touched for CANCEL_MS (not base, not drawn): drop before parse / upload
  const obsolete = (t) => !t.base && t.pin !== pass && now - t.used >= CANCEL_MS && !draw.has(t);

  const visible = (t) => frustum.intersectsSphere(t.cs);
  const dist = (t) => Math.max(0, t.c.distanceTo(eye) - t.r);
  // rel = this pass's relevance (queue offset, lower = more relevant), used by the eviction
  function touch(t, main, rel) {
    t.used = now;
    if (t.pin !== pass) { t.pin = pass; t.rel = rel; } else if (rel < t.rel) t.rel = rel;
    if (main && t.pinMain !== pass) { t.pinMain = pass; if (t.obj && !t.base) mainBytes += t.bytes; }
  }
  function need(t, prio) {
    const p = want.get(t);
    if (p === undefined || prio < p) want.set(t, prio);
  }
  function setFrustum(cam) {
    cam.updateMatrixWorld();
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    eye.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(fwd);
    halfDiag = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * Math.hypot(1, cam.aspect || 1));
  }
  // mild foveation: x1.35 toward the screen edge (angle to the sphere's near rim over the
  // half-diagonal fov), x1.25 for far tiles; only raises the refine threshold
  function fovea(t, d) {
    _d.subVectors(t.c, eye);
    const l = _d.length();
    if (l <= t.r) return 1;
    const ang = Math.acos(THREE.MathUtils.clamp(_d.dot(fwd) / l, -1, 1)) - Math.asin(t.r / l);
    return (1 + 0.35 * ss(0.55, 1, ang / halfDiag)) * (1 + 0.25 * ss(600, 1500, d));
  }
  const sse = (t, k, d) => t.ge * k / Math.max(d, 1e-3);
  function wantsRefine(t, k, d) {
    if (t.leaf) return false;
    return t.refined ? sse(t, k, d) > HYST * tau * gov : sse(t, k, d) > tau * speedF * gov * fovea(t, d);
  }
  function kidFadingIn(t) { for (const c of t.kids) if (c.mode === IN) return true; return false; }
  // occlusion verdict for this pass (cached): hidden from the camera and the look-ahead
  // cameras, not near the car while the ring runs, and not seen for OCC_HOLD ms
  function occluded(t) {
    if (!occ || !occOn || t.leaf) return false;
    if (t.occPass === pass) return t.occHid;
    t.occPass = pass;
    let raw;
    const age = t.occAt >= occFrom ? now - t.occAt : Infinity;
    if (ringOn && Math.hypot(t.cs.center.x - carNow.x, t.cs.center.z - carNow.z) - t.cs.radius < RING_R) raw = false;
    // a verdict younger than OCC_STALE ms is reused (the eyes in it reach 3 s ahead); older ones
    // are recomputed while this pass's work budget lasts, then reused up to OCC_OLD ms; beyond
    // that and over budget: no verdict this pass (refines as without occlusion)
    else if (age < OCC_STALE) { raw = t.occRaw; occSt.reused++; }
    else if (occ.stats.samples + 20 * occ.stats.boxes - occSt.work0 > OCC_WORK) {
      if (age >= OCC_OLD) { occSt.skipped++; t.occHid = false; return false; }
      raw = t.occRaw; occSt.reused++;
    } else {
      const t0 = performance.now();
      raw = occ.hidden(t.i, occEyes);
      occSt.ms += performance.now() - t0; occSt.tested++;
      t.occRaw = raw; t.occAt = now;
    }
    if (!raw) t.occSeen = now;
    t.occHid = raw && now - t.occSeen >= OCC_HOLD;
    if (t.occHid) occSt.hidden++;
    return t.occHid;
  }

  // main pass: pushes the tiles to draw. Every pushed tile is READY; a tile is either drawn
  // itself or ALL its children are ready and take over (no partial refinement, no holes).
  function select(t, k) {
    touch(t, true, 0);
    const d = dist(t);
    if (t.state !== READY) {                      // only roots: nothing coarser
      need(t, d); t.refined = false;
      if (t.state !== FAILED) mainMissing++;
      return;
    }
    // no LOD change while a cross-fade of this region runs (a tile fading in does not refine
    // yet, a parent whose children fade in does not coarsen yet): masks of 3 levels would leave
    // dither pixels covered by nobody
    if (t.mode === IN && draw.has(t)) { if (wantsRefine(t, k, d) && !occluded(t)) mainMissing++; t.refined = false; out.push(t); return; }
    // hidden behind buildings: no refinement (a refined one coarsens; its fade still finishes)
    const wr = wantsRefine(t, k, d), hid = wr && occluded(t);
    if (hid) { occSt.kept++; if (t.refined && !kidFadingIn(t)) occSt.coarsened++; }
    if ((wr && !hid) || (t.refined && kidFadingIn(t))) {
      let all = true, miss = 0;
      for (const c of t.kids) { touch(c, true, 0); if (c.state !== READY) { all = false; if (!c.obj) miss += est(c.level); } }
      if (all) {
        t.refined = true;
        for (const c of t.kids) if (visible(c)) select(c, k);
        return;
      }
      // admission: the missing cohort must fit next to the view set (parent stays meanwhile)
      if (prevMain + pendMiss + miss <= room) {
        pendMiss += miss;
        for (const c of t.kids) {
          if (c.state === READY) continue;
          const v = visible(c);
          need(c, dist(c) + (v ? 0 : P_SIB));
          if (v && c.state !== FAILED) mainMissing++;
        }
      } else ev.admit++;
    }
    t.refined = false;
    out.push(t);
  }
  // look-ahead pass for a predicted camera: requests (parents first) and pins only
  function ahead(t, k, off, lt) {
    const d = dist(t);
    touch(t, false, off + d);
    if (t.state !== READY) { need(t, off + d); return; }
    if (t.leaf || sse(t, k, d) <= tau * lt * speedF * gov * fovea(t, d)) return;
    if (occluded(t)) { occSt.aheadKept++; return; }   // hidden from all eyes: children not needed
    for (const c of t.kids) {
      const p = off + dist(c) + (visible(c) ? 0 : P_SIB);
      touch(c, false, p);
      if (c.state !== READY) need(c, p);
    }
    for (const c of t.kids) if (c.state === READY && visible(c)) ahead(c, k, off, lt);
  }
  // pins t and its ancestors, requests the coarsest one that is missing
  function chain(t, prio) {
    let first = null;
    for (let a = t; a; a = a.parent) {
      touch(a, false, prio);
      if (a.state !== READY) { first = a; if (jumpAt) need(a, prio + 100 * (roots[0].level - a.level)); }   // jump: whole chain, coarse first
    }
    if (first) need(first, prio);
  }
  // prefetch region: every tile down to `level` whose culling sphere reaches the circle
  function region(t, R) {
    const dx = t.cs.center.x - R.x, dz = t.cs.center.z - R.z;
    const d = Math.max(0, Math.hypot(dx, dz) - t.cs.radius);
    if (d > R.r) return;
    touch(t, false, P_PREF + d);
    if (t.state !== READY) { need(t, P_PREF + d); return; }
    if (t.leaf || t.level <= R.level) return;
    for (const c of t.kids) region(c, R);
  }

  // camera speed from the eye's motion (car, S-Bahn); a jump of > 150 m between selections
  // is a teleport: no speed, no yaw history, the car's surroundings first (see jump)
  function trackSpeed(car) {
    if (!eyeT) { lastEye.copy(eye); eyeT = now; return; }
    const dt = (now - eyeT) / 1000;
    if (dt < 0.05) return;
    const dd = eye.distanceTo(lastEye);
    if (dd > 150 || dt > 2) { if (dd > 150) { ev.jump++; jumpAt = now; occFrom = now; jumpL4 = 0; jump.pending = true; } speed = 0; speedF = 1; yaw = null; yawRate = 0; lastCar = 0; }
    // the car's own speed when given (the eye's motion over wall time over-reads when frames
    // or physics steps come in bursts); the eye's motion otherwise
    else speed += ((car ? Math.hypot(car.vx, car.vz) : dd / dt) - speed) * Math.min(1, dt * 3);
    lastEye.copy(eye); eyeT = now;
    kmh = speed * 3.6;
    const f = 1 + 0.75 * ss(50, 110, kmh) + 0.25 * ss(110, 160, kmh);
    speedF += (f - speedF) * Math.min(1, dt * (f > speedF ? 3 : 0.8));   // rises fast, eases back
  }

  function selectAll(car) {
    pass++;
    want.clear();
    // base layer on when it fits BASE_SHARE of the budget (estimate from loaded tiles)
    const on = keepBase && roots.length * est(roots[0].level) <= BASE_SHARE * budget;
    if (on !== baseOn) {
      baseOn = on; baseBytes = 0;
      for (const r of roots) { r.base = on; if (on && r.obj) baseBytes += r.bytes; }
    }
    room = 0.97 * budget - (baseOn ? Math.max(baseBytes, roots.length * est(roots[0].level)) : 0);
    mainBytes = 0; pendMiss = 0; mainMissing = 0;
    const H = renderer.domElement.clientHeight || innerHeight;
    const k = H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    setFrustum(camera);
    trackSpeed(car);
    // look-ahead poses: the camera moved by the car's velocity and turned about it by its
    // yaw rate (computed first: the occlusion test of the main pass also asks these eyes)
    let nLead = 0;
    if (car) {
      const sp = Math.hypot(car.vx, car.vz), dt = lastCar ? (now - lastCar) / 1000 : 0;
      lastCar = now;
      if (sp > 2 && !jumpAt) {
        const h = Math.atan2(car.vx, car.vz);
        if (yaw !== null && dt > 0) {
          let dh = h - yaw; dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
          yawRate += (dh / dt - yawRate) * Math.min(1, dt * 4);
        }
        yaw = h;
        // occlusion eyes every OCC_LEADS step (~10 m apart at 50 km/h: a cross street passed
        // between two eyes is still seen); the look-ahead cameras are the LEADS among them
        for (let oi = 0; oi < OCC_LEADS.length; oi++) {
          const T = OCC_LEADS[oi];
          _q.setFromAxisAngle(_up, THREE.MathUtils.clamp(yawRate * T, -1.2, 1.2));
          _pos.x = car.x; _pos.z = car.z;
          occPos[oi].copy(camera.position).sub(_pos).applyQuaternion(_q);
          _pos.x = car.x + car.vx * T; _pos.z = car.z + car.vz * T;
          occPos[oi].add(_pos);
          const li = LEADS.indexOf(T);
          if (li >= 0) { leadPos[li].copy(occPos[oi]); leadQ[li].copy(camera.quaternion).premultiply(_q); }
        }
        nLead = LEADS.length;
      } else { yaw = null; yawRate = 0; }
    }
    carNow = car || null; ringOn = !!car && (kmh < RING_KMH || !!jumpAt);
    occSt.kept = 0; occSt.coarsened = 0; occSt.aheadKept = 0; occSt.tested = 0; occSt.reused = 0; occSt.skipped = 0; occSt.hidden = 0; occSt.ms = 0;
    if (occ) occSt.work0 = occ.stats.samples + 20 * occ.stats.boxes;
    if (occ && occOn) {
      occ.setEye(0, eye.x, eye.y, eye.z);
      const no = nLead ? OCC_LEADS.length : 0;
      for (let oi = 0; oi < no; oi++) occ.setEye(1 + oi, occPos[oi].x, occPos[oi].y, occPos[oi].z);
      occEyes = 1 + no;
    }
    out.length = 0;
    for (const r of roots) if (visible(r)) select(r, k); else r.refined = false;
    prevMain = mainBytes;
    // budget governor: the view set near the room left -> coarser, slowly back when it frees
    if (mainBytes > 0.85 * room) gov = Math.min(GOV_MAX, gov * 1.03);
    else if (mainBytes < 0.7 * room) gov = Math.max(1, gov / 1.01);
    if (car) {
      if (nLead) {
        pcam.fov = Math.min(100, camera.fov * LEAD_FOV); pcam.aspect = camera.aspect;
        pcam.near = camera.near; pcam.far = camera.far;
        pcam.updateProjectionMatrix();
        for (let li = 0; li < nLead; li++) {
          const T = LEADS[li];
          pcam.position.copy(leadPos[li]); pcam.quaternion.copy(leadQ[li]);
          setFrustum(pcam);
          for (const r of roots) if (visible(r)) ahead(r, k, P_LEAD * T / LEADS[0], LEAD_TAU[li]);
        }
        setFrustum(camera);
      }
      if (kmh < RING_KMH || jumpAt) {
        // ring of L1 around the car (turns, reversing); after a jump the same at top priority
        for (const t of finest) {
          const d = Math.hypot(t.c.x - car.x, t.c.z - car.z) - t.r;
          if (d < RING_R) chain(t, (jumpAt ? 0 : P_RING) + Math.max(0, d));
        }
      }
      if (jumpAt) jumpCheck(car);
    }
    for (let i = regions.length - 1; i >= 0; i--) {
      const R = regions[i];
      if (R.until && now > R.until) { regions.splice(i, 1); continue; }
      for (const r of roots) region(r, R);
    }
    if (baseOn) for (const r of roots) { touch(r, false, P_BASE); if (r.state !== READY) need(r, P_BASE + dist(r)); }
    next.clear();
    for (const t of out) next.add(t);
    swap();
    const tmp = draw; draw = next; next = tmp;
    // cancel what nobody has wanted for CANCEL_MS (a tile flickering at the frustum edge
    // keeps its request); in-flight priorities follow the selection
    for (const t of loading) {
      const p = want.get(t);
      if (p !== undefined) { t.wantAt = now; t.prio = p; }
      else if (now - t.wantAt >= CANCEL_MS) cancel(t);
    }
    // queue: everything wanted and not loaded, by priority; near the budget no look-ahead loads
    q.length = 0; qi = 0;
    want.forEach(enqueue);
    q.sort((a, b) => a.prio - b.prio);
    pump();
    // a near tile waits behind a full pipe: abort the farthest look-ahead request for it
    if (qi < q.length && q[qi].prio < P_SIB && inflight >= MAX_INFLIGHT) {
      let worst = null;
      for (const t of loading) if (!t.cancelled && t.prio >= P_LEAD && (!worst || t.prio > worst.prio)) worst = t;
      if (worst) { ev.preempt++; cancel(worst); }
    }
    reservedB = 0;
    for (const t of loading) reservedB += est(t.level);
    evict();
    peak = Math.max(peak, bytes + reservedB);
    occSt.keptTotal += occSt.kept; occSt.coarsenedTotal += occSt.coarsened;
    if (occSt.tested) { occSt.passes++; occSt.msSum += occSt.ms; occSt.msMax = Math.max(occSt.msMax, occSt.ms); }
    occSt.work = occ ? occ.stats.samples + 20 * occ.stats.boxes - occSt.work0 : 0; occSt.workMax = Math.max(occSt.workMax, occSt.work);
  }
  // after a jump: is the car's surroundings (JUMP_R) drawn at L1? time with L4 there
  function jumpCheck(car) {
    let all = true, l4 = false, any = false;
    for (const t of draw) {
      if (Math.hypot(t.c.x - car.x, t.c.z - car.z) - t.r > JUMP_R) continue;
      any = true;
      if (t.level !== 1 && !t.leaf) all = false;
      if (t.level === 4) l4 = true;
    }
    if (l4) jumpL4 = Math.max(jumpL4, now - jumpAt);
    if (any && all) { jump.n++; jump.sharpMs = Math.round(now - jumpAt); jump.l4Ms = Math.round(jumpL4); jump.pending = false; jumpAt = 0; }
    else if (now - jumpAt > 30000) { jump.sharpMs = -1; jump.pending = false; jumpAt = 0; }   // gave up (e.g. over water)
  }
  function enqueue(p, t) {
    if (t.state === FAILED && now - t.failedAt > RETRY_MS) t.state = NONE;
    if (t.state === NONE && (t.base || !(over && p >= P_LEAD))) { t.prio = p; q.push(t); }
  }
  // issue requests from the sorted queue while slots are free (also when a request settles)
  function pump() {
    while (qi < q.length && inflight < MAX_INFLIGHT) {
      const t = q[qi++];
      if (t.state === NONE && (t.base || t.prio < P_LEAD || !over)) load(t);
    }
    queued = 0;
    for (let i = qi; i < q.length; i++) if (q[i].state === NONE) queued++;
  }
  function cancel(t) {
    if (t.state !== LOADING || t.cancelled) return;
    t.cancelled = true; t.cancelledAt = now; ev.cancel++;
    t.ac?.abort();
  }

  function drawnAbove(t, set) { for (let a = t.parent; a; a = a.parent) if (set.has(a)) return true; return false; }
  function occAbove(t) { for (let a = t.parent; a; a = a.parent) if (next.has(a)) return a.occPass === pass && a.occHid; return false; }
  function drawnBelow(t, set) {
    for (const c of t.kids) if (set.has(c) || drawnBelow(c, set)) return true;
    return false;
  }
  // a drawn ancestor / descendant that is fading out right now (what a new tile replaces)
  function outAbove(t) { for (let a = t.parent; a; a = a.parent) if (draw.has(a) && a.mode === OUT) return true; return false; }
  function outBelow(t) {
    for (const c of t.kids) if ((draw.has(c) && c.mode === OUT) || outBelow(c)) return true;
    return false;
  }
  // a real hole under t (t left the draw set, no ancestor drawn): a visible tile that is
  // neither drawn nor refined into children. A refined tile whose children are all outside
  // the frustum is no hole: its own sphere sticks out past theirs, but the surface it covers
  // is the children's, and none of that is in view (this was the round-1 "hole" artefact)
  function gap(t) {
    if (!visible(t) || next.has(t)) return false;
    if (!t.refined) return true;
    for (const c of t.kids) if (gap(c)) return true;
    return false;
  }
  function setFade(t, mode, a) {
    t.mode = mode; t.a = a;
    t.fadeU.value = mode === IN ? a : mode === OUT ? -(1 - a) : 1;
    if (mode === IN || mode === OUT) fading.add(t); else fading.delete(t);
    if (t.obj) t.obj.visible = mode !== OFF;
  }
  // last draw set -> next: LOD swaps cross-fade, tiles coming into view appear at once
  function swap() {
    for (const t of draw) {
      if (next.has(t)) continue;
      const inView = visible(t), up = drawnAbove(t, next), down = !up && drawnBelow(t, next);
      // a coarsening by the occlusion step (drawn ancestor judged hidden) is counted apart
      if (inView) { if (up) { if (occAbove(t)) ev.occDowngrade++; else ev.downgrade++; } else if (gap(t)) ev.hole++; }
      if (inView && t.obj && (up || down)) setFade(t, OUT, t.mode === IN ? 1 - t.a : 0);
      else setFade(t, OFF, 0);
    }
    for (const t of next) {
      t.used = now; t.shown = true;
      if (draw.has(t) && t.mode !== OUT) continue;
      if (t.mode === OUT) setFade(t, IN, 1 - t.a);                     // swapped back mid-fade
      else if (outAbove(t) || outBelow(t)) setFade(t, IN, 0);          // replaces what is drawn
      else setFade(t, ON, 1);                                          // nothing behind it: at once
    }
  }
  // IN: a = shown fraction 0 -> 1; OUT: a = hidden fraction 0 -> 1 (uFade = -(1 - a))
  function stepFades(dt) {
    for (const t of fading) {
      const a = Math.min(1, t.a + dt / FADE_MS);
      if (a < 1) { t.a = a; t.fadeU.value = t.mode === IN ? a : -(1 - a); }
      else setFade(t, t.mode === IN ? ON : OFF, t.mode === IN ? 1 : 0);
    }
  }

  // tile material: KHR_materials_unlit -> MeshBasicMaterial (same as world.glb in index.html).
  // The tiles carry only baseColorTexture (factor 1, no vertex colours, no alpha). They are
  // flagged doubleSided; we keep FrontSide like world.glb: camcollide / ground probes raycast
  // against these meshes and three's raycast honours material.side.
  function makeMaterial(map, fadeU) {
    const mat = new THREE.MeshBasicMaterial({ map: map || null, color: map ? 0xffffff : 0x999999 });
    mood?.gradeMaterial(mat);
    addFade(mat, fadeU);
    return mat;
  }

  async function load(t) {
    t.state = LOADING; inflight++; loading.add(t); t.reqAt = now; t.wantAt = now; ev.req++;
    if (t.evictedAt && now - t.evictedAt < 10000) ev.thrash++;
    if (t.cancelledAt && now - t.cancelledAt < 5000) ev.recancel++;
    const ac = t.ac = new AbortController();
    let obj = null;
    try {
      const buf = await fetch(base + t.path, { signal: ac.signal }).then((r) => {
        if (!r.ok) throw new Error(`${t.path}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      if (t.cancelled) { ev.dropped++; return; }    // bytes arrived after the cancel: no parse
      if (obsolete(t)) { ev.obsoleteAvoided++; return; }
      const h = new DataView(buf, 0, 28);         // b3dm header: GLB after feature + batch tables
      if (h.getUint32(0, true) !== 0x6d643362) throw new Error(`${t.path}: not a b3dm`);
      const off = 28 + h.getUint32(12, true) + h.getUint32(16, true) + h.getUint32(20, true) + h.getUint32(24, true);
      // GLTFLoader decodes the JPEGs with createImageBitmap (off the main thread in Chrome)
      const g = await new Promise((res, rej) => loader.parse(buf.slice(off), '', res, rej));
      obj = g.scene;
      // coarse levels: smaller texture before anything reaches the GPU (createImageBitmap
      // resizes off the main thread; the full-size bitmap is closed at once)
      const sc = DOWNSCALE[t.level];
      if (sc) {
        const maps = [];
        obj.traverse((o) => { if (o.isMesh && o.material.map?.image?.width && !o.material.map.isCompressedTexture) maps.push(o.material.map); });
        for (const map of maps) {
          const src = map.image;
          try {
            map.image = await createImageBitmap(src, { resizeWidth: Math.max(1, Math.round(src.width * sc)),
              resizeHeight: Math.max(1, Math.round(src.height * sc)), resizeQuality: 'medium',
              premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
            src.close?.();
          } catch (e) { map.image = src; }
        }
      }
      let n = 0;
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.world = true;                  // camera collision occluder (js/camcollide.js)
        const m = o.material;
        o.material = makeMaterial(m.map, t.fadeU);
        m.dispose();
        if (o.material.map) {
          const img = o.material.map.image;
          o.material.map.anisotropy = aniso;
          // GPU: RGBA8, no mips - the tiles' sampler is minFilter LINEAR, so three does not
          // generate any (textureNeedsGenerateMipmaps); JPEG is not GPU-compressed
          n += img.width * img.height * 4 * (o.material.map.generateMipmaps && o.material.map.minFilter !== THREE.LinearFilter ? 4 / 3 : 1);
        }
        for (const a of Object.values(o.geometry.attributes)) n += a.array.byteLength;
        if (o.geometry.index) n += o.geometry.index.array.byteLength;
      });
      if (t.cancelled) { ev.dropped++; disposeObj(obj); return; }
      // placed once: no per-frame matrix work for the tile or its glTF nodes
      obj.matrixAutoUpdate = false; obj.matrix.copy(t.m); obj.visible = false;
      obj.updateMatrixWorld(true);
      obj.traverse((o) => { o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false; });
      t.obj = obj; t.bytes = n; bytes += n;
      if (t.base) baseBytes += n;
      lvSum[t.level] = (lvSum[t.level] || 0) + n; lvN[t.level] = (lvN[t.level] || 0) + 1;
      t.state = PARSED; enterQ.push(t);
    } catch (e) {
      if (t.cancelled) { if (obj && !t.obj) disposeObj(obj); }
      else { console.warn('stream:', e.message || e); t.state = FAILED; t.failedAt = now; if (obj && !t.obj) disposeObj(obj); }
    } finally {
      if (t.state === LOADING) t.state = NONE;      // cancelled: cleanly re-requestable
      t.cancelled = false; t.ac = null;
      inflight--; loading.delete(t);
      pump();
    }
  }

  function dispose(t) {
    if (t.state === READY && !t.shown) ev.obsoleteUploaded++;   // uploaded, never drawn (look-ahead that did not come)
    scene.remove(t.obj);
    disposeObj(t.obj);
    bytes -= t.bytes; if (t.base) baseBytes -= t.bytes;
    t.obj = null; t.bytes = 0; t.state = NONE; t.refined = false;
    setFade(t, OFF, 0); ev.evict++; t.evictedAt = now;
    const k = enterQ.indexOf(t); if (k >= 0) enterQ.splice(k, 1);
  }

  // resident + reserved (requests in flight) over the budget: make room
  function evict() {
    const lim = budget - reservedB;
    if (bytes > lim) {
      cand.length = 0;
      for (const t of tiles) if ((t.state === READY || t.state === PARSED) && t.mode === OFF && !t.base) cand.push(t);
      // 1) not touched by the last selection, least recently used first
      cand.sort((a, b) => (a.pin === pass) - (b.pin === pass) || a.used - b.used);
      for (const t of cand) {
        if (bytes <= lim || t.pin === pass) break;
        dispose(t);
      }
      // 2) still over: ring / prefetch / look-ahead tiles, least relevant this pass first
      if (bytes > lim) {
        cand.sort((a, b) => b.rel - a.rel);
        for (const t of cand) {
          if (bytes <= lim) break;
          if (t.obj && t.pin === pass && t.pinMain !== pass) dispose(t);
        }
      }
    }
    over = bytes + reservedB > 0.95 * budget;
  }

  // per frame; car = { x, z, vx, vz } in level coords (for the look-ahead)
  function update(car) {
    now = performance.now();
    const dt = Math.min(100, now - (lastNow || now)); lastNow = now;
    while (enterQ.length) {                       // time-sliced (see the header): textures uploaded before the first draw
      const t = enterQ.shift();
      if (obsolete(t)) {                          // wanted by nobody any more: never uploaded
        disposeObj(t.obj); bytes -= t.bytes; if (t.base) baseBytes -= t.bytes;
        t.obj = null; t.bytes = 0; t.state = NONE; ev.obsoleteAvoided++;
        continue;
      }
      t.obj.traverse((o) => { if (o.isMesh && o.material.map) renderer.initTexture(o.material.map); });
      t.shown = false;
      scene.add(t.obj);
      t.state = READY; t.readyAt = now; dirty = true;
      ev.enter++; const lat = now - t.reqAt; ev.latSum += lat; ev.latN++; ev.latMax = Math.max(ev.latMax, lat);
      if (performance.now() - now > ENTER_MS) break;
    }
    if (dirty || now - lastSelect >= SELECT_MS) {
      selectAll(car); lastSelect = now; dirty = false;
      // idle = every tile the main view wants (drawn path + visible children of refinements)
      // is in; look-ahead, prefetch, ring and base may still be loading
      if (waiters.length && mainMissing === 0) waiters.splice(0).forEach((r) => r());
    }
    stepFades(dt);
  }

  // prefetchAt(x, z, radius = 150, { level = 1, seconds = 20 }): load the tiles around a far
  // point down to `level` (parents first) and pin them for `seconds` (0 = until release()),
  // within the budget (they go before the look-ahead when it is full). Returns { release }.
  function prefetchAt(x, z, radius = 150, { level = 1, seconds = 20 } = {}) {
    const R = { x: +x, z: +z, r: Math.max(1, +radius || 150), level, until: seconds > 0 ? performance.now() + seconds * 1000 : 0 };
    if (!Number.isFinite(R.x) || !Number.isFinite(R.z)) return { release() {} };
    regions.push(R);
    if (regions.length > 48) regions.shift();
    dirty = true;
    return { release() { const i = regions.indexOf(R); if (i >= 0) regions.splice(i, 1); } };
  }

  // shader warm-up: the one shared tile program (map + mood grade + fade) compiled before the
  // first tile needs it (compileAsync: r158+, uses KHR_parallel_shader_compile where present)
  try {
    if (renderer.compileAsync) {
      const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
      tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
      const wm = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeMaterial(tex, { value: 1 }));
      renderer.compileAsync(wm, camera, scene).catch(() => {}).finally(() => { wm.geometry.dispose(); wm.material.dispose(); tex.dispose(); });
    }
  } catch (e) { console.warn('stream: warm-up', e); }

  function stats() {
    const by = (f) => { const o = {}; for (const t of tiles) if (f(t)) o['L' + t.level] = (o['L' + t.level] || 0) + 1; return o; };
    let pinMB = 0, viewMB = 0;
    for (const t of tiles) { if (t.obj && t.pin === pass && !t.base) pinMB += t.bytes; if (t.obj && t.pinMain === pass && !t.base) viewMB += t.bytes; }
    return {
      loaded: tiles.filter((t) => t.state === READY || t.state === PARSED).length, inflight, queued,
      wanted: want.size, visible: by((t) => draw.has(t)), loadedByLevel: by((t) => t.state === READY),
      failed: tiles.filter((t) => t.state === FAILED).length, fading: fading.size,
      MB: Math.round(bytes / 1e5) / 10, baseMB: Math.round(baseBytes / 1e5) / 10, base: baseOn,
      budgetMB: budget / 1e6, tau, tiles: tiles.length, aniso,
      viewMB: Math.round(viewMB / 1e5) / 10, pinnedMB: Math.round(pinMB / 1e5) / 10, overBudget: over,
      reservedMB: Math.round(reservedB / 1e5) / 10, peakMB: Math.round(peak / 1e5) / 10,
      gpuTextures: renderer.info.memory.textures, tileMeshes: tiles.reduce((s, t) => s + (t.obj ? 1 : 0), 0),
      jump: { ...jump, sinceMs: jumpAt ? Math.round(performance.now() - jumpAt) : null },
      kmh: Math.round(kmh), speedFactor: +speedF.toFixed(2), governor: +gov.toFixed(2), regions: regions.length,
      events: { ...ev },
      // kept = tiles the occlusion step kept from refining in the last pass (main view),
      // keptTotal = sum over all passes; coarsened = refined tiles collapsed because hidden;
      // aheadKept = look-ahead refinements skipped; tested / reused / skipped / hidden = verdicts
      // last pass (computed, reused < OCC_OLD ms old, none: over budget); work = ray samples + 20
      // per box test last pass (budget OCC_WORK; ~0.06-0.07 us per unit measured offline);
      // ms = cost of the step last pass (msAvg / msMax over passes that tested)
      occlusion: { available: !!occ, on: occOn, eyes: occEyes, kept: occSt.kept, keptTotal: occSt.keptTotal,
                   coarsened: occSt.coarsened, coarsenedTotal: occSt.coarsenedTotal, aheadKept: occSt.aheadKept,
                   tested: occSt.tested, reused: occSt.reused, skipped: occSt.skipped, hidden: occSt.hidden, work: occSt.work, workMax: occSt.workMax, ms: +occSt.ms.toFixed(3),
                   msAvg: occSt.passes ? +(occSt.msSum / occSt.passes).toFixed(3) : 0, msMax: +occSt.msMax.toFixed(3),
                   rays: occ ? occ.stats.rays : 0 },
    };
  }

  return {
    update, stats, tiles, events: ev, prefetchAt,
    get mainMissing() { return mainMissing; },   // tiles the main view still misses (last selection pass; failed ones not counted) - js/loading.js progress
    idle: () => new Promise((r) => { waiters.push(r); dirty = true; }),   // resolves once every tile the main view wants is in (look-ahead / prefetch / base may still be loading)
    setBudget(mb) { budget = Math.max(16, +mb) * 1e6; dirty = true; evict(); return budget / 1e6; },
    get budgetMB() { return budget / 1e6; },
    setTau(v) { tau = Math.max(4, +v); dirty = true; return tau; },
    get tau() { return tau; },
    resetPeak() { peak = bytes; },
    setAniso(v) { aniso = Math.max(1, Math.min(maxAniso, +v || 1)); return aniso; },   // new tiles only (no re-upload)
    // occlusion step on / off (saved as localStorage 'berlinDrive.occlusion'); false if no occlusion.json
    setOcclusion(v) {
      occOn = !!v; dirty = true; occFrom = performance.now();
      for (const t of tiles) { t.occPass = -1; t.occHid = false; }
      try { localStorage.setItem('berlinDrive.occlusion', occOn ? '1' : '0'); } catch (e) { /* private mode */ }
      return occOn && !!occ;
    },
    get occlusion() { return occOn && !!occ; },
  };
}

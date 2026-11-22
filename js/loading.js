// Loading screen: the way into the game (2026-11-21, replaces the start screen). Shown from page
// load until the first view is in, then it fades out and the player drives at once (no button).
//
//   import { createLoading } from './js/loading.js';
//   const loading = createLoading({ base, canvas: $('c') });
//   loading.step(text, frac)       // phase 1: level files, frac 0..1 of that phase (index.html calls it per await)
//   loading.setStart(x, z)         // start pose known: "Berlin-<Ortsteil>" for the plate (areas.json)
//   loading.firstFrame()           // the game rendered its first frame: the dark cover gives way to the view
//   loading.tiles(stream)          // phase 2: the tiles of the first view (js/stream.js), done on stream.ready() (coarse-ready)
//   loading.done()                 // finished (no stream level, or called by tiles()); fades out
//   loading.fail(err)              // load error in plain words; the screen stays
//   loading.open / .named          // up? / the name on its plate ("Berlin-Mitte"; menu header fallback)
//   loading.hide(), loading.show() // harmless no-ops (old berlinDrive.intro API, scratch scripts call hide())
//
// Progress: one bar, real numbers only. Phase 1 = 0 .. 30 % (index.html steps), phase 2 = 30 .. 100 %:
// entered tiles / (entered + tiles the start rule still misses: stream.startMissing) from the
// streamer, shown only ever forward and held below 100 % until stream.ready() resolves =
// coarse-ready (js/stream.js START_RULE: no hole, coarse detail in view, the car's ground final;
// failed tiles do not count as missing, so a failing tile cannot hang it). The city keeps
// sharpening while the player drives. Safety net: after SAFETY_S in phase 2 the game starts
// anyway ("lädt im Hintergrund weiter"), rarely needed now.
// The game view is the background: the canvas gets a CSS filter blur + brightness that
// eases from strong to none with the same progress value (coarse steps, CSS transition,
// only toward sharp) until coarse-ready, and the filter is removed when the screen goes; the
// sharpening after that is the real tiles refining. Until the first frame a
// plain dark cover. Input: a capture keydown listener swallows every key while up; the game
// also holds its physics (index.html pause reason 'load'). body.loading hides the HUD.

import { PLATE_CSS, ORT_CSS, ortSignHtml, fitOrtSign, ensureSignFont, districtAt } from './areasign.js';
import { HELP_CSS, CREDITS_HTML } from './intro.js';
import { ICON, onTouch } from './touch.js';
import { MENU_ICON } from './intro.js';

const PHASE1 = 0.3, SAFETY_S = 60, BLUR_PX = 22, DIM = 0.45;

const CSS = `
body.loading { background: #111214; }
body.loading #mm, body.loading #areasign, body.loading #touchui, body.loading #credit, body.loading #menuBtn,
body.loading #sbahnOff { visibility: hidden !important; }
#loading { position: absolute; inset: 0; z-index: 3000; background: #111214; color: #e8e8e8;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; justify-content: center; padding: 24px max(16px, 6vw);
  box-sizing: border-box; transition: background-color 0.8s, opacity 0.6s; }
#loading.view { background: rgba(10, 11, 13, 0.25); }
#loading.out { opacity: 0; pointer-events: none; }
#loading .lbox { max-width: 560px; }
#loading h1 { margin: 0 0 22px; font-size: clamp(33px, 5.9vw, 52px); font-family: "BerlinSign", "Liberation Sans Narrow", "Arial Narrow", sans-serif; font-weight: 700; font-synthesis: none; letter-spacing: 0.03em;
  color: #fff; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6); }
#loading .enter { min-height: 64px; opacity: 0; transition: opacity 0.6s; }
#loading { --ort-h: clamp(60px, 12vh, 100px); }   /* the yellow place-name sign's height: the one number to change */
#loading .enter .ortsign { --oh: var(--ort-h); }
#loading .enter.on { opacity: 1; }
#loading .enter .du { font-size: 15px; color: #cfd2d6; margin-bottom: 6px; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
#loading .bar { margin-top: 22px; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.14); overflow: hidden; }
#loading .bar > i { display: block; height: 100%; width: 0; background: #fff; border-radius: 3px; transition: width 0.4s ease-out; }
#loading .status { margin-top: 10px; font-size: 14px; color: #cfd2d6; min-height: 1.3em; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
#loading .err { display: none; margin-top: 16px; padding: 12px 14px; border-radius: 8px; background: rgba(120, 20, 20, 0.75);
  border: 1px solid #c55; color: #fff; font-size: 15px; line-height: 1.4; }
#loading .err small { display: block; margin-top: 6px; color: #f0c0c0; font: 12px ui-monospace, Menlo, Consolas, monospace; word-break: break-word; }
#loading.failed .err { display: block; }
#loading .datanote { margin: 14px 0 0; max-width: 46ch; font-size: 13px; line-height: 1.4; color: #a9acb2; }
#loading .keys { margin-top: 26px; font-size: 14px; color: #d8dade; display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
#loading .keys .kc.s { min-width: 24px; height: 24px; font-size: 12px; }
#loading .keys .tk { display: inline-flex; align-items: center; gap: 6px; }
#loading .keys .ti { display: inline-block; width: 22px; height: 22px; color: #fff; }
#loading .keys .t, #loading.touch .keys .k { display: none; }
#loading.touch .keys .t { display: inline-flex; }
#loading .bdcredits { position: absolute; left: max(16px, 6vw); right: 16px; bottom: 14px; margin: 0; color: #a9acb2;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8); }
@media (max-height: 520px) { #loading h1 { margin-bottom: 10px; } #loading .keys { margin-top: 14px; }
  #loading { --ort-h: clamp(44px, 12vh, 60px); } }
`;

const HTML = `
<div class="lbox bdhelp">
  <h1>Driving Berlin</h1>
  <div class="enter"><div class="du">Du betrittst</div><div class="ortsign"></div></div>
  <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
  <div class="status">Lädt …</div>
  <div class="err"></div>
  <div class="keys">
    <span class="tk k"><span class="kc s">&larr;</span><span class="kc s">&uarr;</span><span class="kc s">&darr;</span><span class="kc s">&rarr;</span> oder <span class="kc s">W</span><span class="kc s">A</span><span class="kc s">S</span><span class="kc s">D</span> fahren</span>
    <span class="tk k"><span class="kc s">Leertaste</span> springen</span>
    <span class="tk k"><span class="kc s">Esc</span> Menü</span>
    <span class="tk t"><span class="ti">${ICON.steer}</span> links: lenken</span>
    <span class="tk t"><span class="ti">${ICON.pedal}</span> rechts: Gas, Bremse / rückwärts</span>
    <span class="tk t"><span class="ti">${ICON.jump}</span> springen</span>
    <span class="tk t"><span class="ti">${MENU_ICON}</span> Menü</span>
  </div>
  <p class="datanote">Das Spiel lädt etwa 70 MB zum Start und weitere Daten beim Fahren. Am besten mit WLAN und am Computer nutzen, um Daten zu sparen.</p>
</div>
${CREDITS_HTML}`;

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

export function createLoading({ base = '', canvas = null, parent = document.body } = {}) {
  const style = document.createElement('style');
  ensureSignFont();   // first of all users: the font is declared and requested at page start
  style.textContent = PLATE_CSS + ORT_CSS + HELP_CSS + CSS;
  document.head.appendChild(style);
  document.body.classList.add('loading');
  const el = document.createElement('div');
  el.id = 'loading';
  el.innerHTML = HTML;
  parent.appendChild(el);
  const q = (s) => el.querySelector(s);
  const barEl = q('.bar'), fillEl = q('.bar > i'), statusEl = q('.status'), errEl = q('.err');
  const enterEl = q('.enter'), plateEl = q('.ortsign');
  onTouch(() => el.classList.add('touch'));

  let open = true, named = null, shownP = 0, blurP = -1, failed = false, finished = false, pollT = 0;

  // canvas filter: strong blur + dim at 0, none at 1; coarse steps with a CSS transition, only forward
  if (canvas) { canvas.style.transition = 'filter 0.7s linear'; canvas.style.filter = `blur(${BLUR_PX}px) brightness(${1 - DIM})`; }
  function setBlur(p) {
    if (!canvas || p < blurP + 0.04 && p < 1) return;
    blurP = p;
    const k = ease(p);
    canvas.style.filter = p >= 1 ? 'blur(0px) brightness(1)' : `blur(${(BLUR_PX * (1 - k)).toFixed(1)}px) brightness(${(1 - DIM * (1 - k)).toFixed(3)})`;
  }
  function progress(p) {
    if (finished) return;
    p = Math.max(shownP, Math.min(1, p));   // never backwards
    shownP = p;
    fillEl.style.width = (100 * p).toFixed(1) + '%';
    barEl.setAttribute('aria-valuenow', String(Math.round(100 * p)));
    setBlur(p);
  }
  const status = (t) => { if (!failed && statusEl.textContent !== t) statusEl.textContent = t; };

  // swallow every key while up (registered before every game listener: runs first)
  addEventListener('keydown', (e) => {
    if (!open) return;
    e.stopImmediatePropagation();
    if (!e.ctrlKey && !e.metaKey && !['F5', 'F11', 'F12', 'Tab'].includes(e.key)) e.preventDefault();
  }, true);

  let areas = null, startXZ = null;
  const areasP = fetch(base + 'areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((a) => { areas = a; if (startXZ) name(); });
  function name() {
    if (named || !open) return;
    named = districtAt(areas, startXZ.x, startXZ.z);   // "Berlin-Mitte", "Berlin" outside every Ortsteil
    plateEl.innerHTML = ortSignHtml(named);   // yellow place-name sign: "Berlin" / "<Ortsteil>"
    enterEl.classList.add('on');
    fitOrtSign(plateEl);
  }

  function step(text, frac) { status(text); progress(PHASE1 * Math.max(0, Math.min(1, frac))); }
  function setStart(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    startXZ = { x, z };
    if (areas) name(); else areasP.then(() => { if (!named) name(); });
  }
  function firstFrame() { el.classList.add('view'); }
  function tiles(stream) {
    if (!stream) { done(); return; }
    status('Die Stadt lädt: Häuser, Straßen, Bäume …');
    const t0 = performance.now();
    // coarse-ready (stream.ready(), START_RULE in js/stream.js): drivable before full detail;
    // an older streamer without it: the whole first view (idle())
    const coarse = typeof stream.ready === 'function';
    let idle = false;
    (coarse ? stream.ready() : stream.idle()).then(() => { idle = true; });
    const poll = () => {
      if (finished || failed) return;
      if (idle) { done(); return; }
      const ev = stream.events || {}, m = coarse ? stream.startMissing : stream.mainMissing;
      const miss = Number.isFinite(m) ? m : null;
      if (miss !== null) {
        const got = ev.enter || 0, f = got + miss > 0 ? got / (got + miss) : 0;
        progress(PHASE1 + (1 - PHASE1) * Math.min(0.97, f));   // 100 % only on ready()
      }
      if (performance.now() - t0 > SAFETY_S * 1000) { status('Die Stadt lädt im Hintergrund weiter …'); done(); return; }
      pollT = setTimeout(poll, 250);
    };
    poll();
  }
  function done() {
    if (finished || failed) return;
    progress(1); finished = true;
    status('Los geht’s');
    clearTimeout(pollT);
    setTimeout(() => {   // the last sharpening step lands, then the text goes
      el.classList.add('out');
      open = false;
      document.body.classList.remove('loading');
      setTimeout(() => {
        el.style.display = 'none';
        if (canvas) { canvas.style.filter = ''; canvas.style.transition = ''; }   // no filter left behind
      }, 700);
    }, 450);
  }
  function fail(err) {
    failed = true;
    el.classList.add('failed');
    statusEl.textContent = 'Das Laden ist fehlgeschlagen.';
    const msg = String(err?.message || err || '');
    const plain = /HTTP 404|run build_/i.test(msg) ? 'Ein Teil der Level-Daten fehlt auf dem Server.'
      : /Failed to fetch|NetworkError|network/i.test(msg) ? 'Keine Verbindung zum Server.'
      : /WebGL|context/i.test(msg) ? 'Dieser Browser kann die 3D-Grafik nicht anzeigen (WebGL).'
      : 'Berlin konnte nicht geladen werden.';
    errEl.innerHTML = '';
    errEl.append(plain + ' Bitte die Seite neu laden.');
    if (msg) { const s = document.createElement('small'); s.textContent = msg; errEl.append(s); }
  }

  return {
    step, setStart, firstFrame, tiles, done, fail,
    get open() { return open; }, get named() { return named; }, get progress() { return shownP; },
    hide() {}, show() {},
  };
}

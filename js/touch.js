// Touch controls for phones and tablets (symbols only, no lettering: quiet game).
//
//   import { createTouch } from './js/touch.js';
//   createTouch({ balloon: () => balloon, paused: () => pauseBy.size > 0, onBlock: (on) => setPause('rotate', on) });
//
// Shown only on touch devices: `(pointer: coarse)` at load, or the first touchstart anywhere
// (a laptop with a touchscreen). A mouse-only desktop never sees anything of this.
// Every control goes through the keyboard paths: it dispatches the same keydown / keyup
// events on window that a key would (held directions once on engage and once on release, so
// index.html's `keys` set - via driveKey, behind the pauseBy gate - holds exactly what a held
// key would hold; one-shot buttons send keydown + keyup). Nothing in the game reads touch directly.
//
// Two sticks (2026-11-22, replace the steering pad and the pedal pad), game-controller look:
// a round base with a knob in the middle, each knob held to ONE axis (faint arrowheads on it).
//   left stick, bottom left:   x only: right -> ArrowRight, left -> ArrowLeft (steering)
//   right stick, bottom right: y only: up -> ArrowUp (gas), down -> ArrowDown (brake; held at
//                              standstill = reverse, as the game already does)
// Knob offset / base radius (the knob travels up to 0.55), hysteresis: engage 0.25, release 0.15.
// Floating start: a thumb landing in a stick's lower quarter (lower half, outer 40 % of the
// width; on the left below the minimap) puts that base under the thumb; on the resting base it
// stays put. One finger per stick, own pointer capture each, so both thumbs + a button work at once.
// Released (keys up, knob springs back) on pointerup / pointercancel / lostpointercapture, window
// blur, page hidden, and whenever the game pauses (paused(): menu, map, loading, rotate);
// while paused the controls are inert.
//   round (above the right stick): jump (Space), map (N) beside it, balloon ride (E) above the
//          jump only while the car stands at the Weltballon platform.
// The S-Bahn "Runter von den Gleisen" button (#sbahnOff) is already tappable, so G has no pad.
//
// Rotate blocker: a touch device (no fine pointer) held upright (orientation: portrait) gets
// an opaque cover with a rocking phone symbol and "Bitte das Handy quer drehen." above
// everything (loading screen, menu); the page keeps loading underneath. onBlock(on) tells
// index.html (pause reason 'rotate'). Goes by itself in landscape, comes back upright.
// After the first tap: screen.orientation.lock('landscape') is tried once (works only in
// fullscreen / installed mode; a rejection is ignored).
// Layout on touch (body.touch): the minimap sits top left, the round menu button
// (js/menu.js #menuBtn) top right, so the bottom corners are free.

const mm = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
const coarse = mm('(pointer: coarse)');
let touch = coarse;
const subs = [];
if (!touch && typeof addEventListener === 'function') {
  const first = () => {
    removeEventListener('touchstart', first, true);
    touch = true;
    for (const cb of subs.splice(0)) cb();
  };
  addEventListener('touchstart', first, { capture: true, passive: true });
}
/** cb() now if this is a touch device, else on the first touchstart (once). */
export function onTouch(cb) { if (touch) cb(); else subs.push(cb); }
export const isTouch = () => touch;
export const isCoarse = () => coarse;

const svg = (body) => `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">${body}</svg>`;
const LINE = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
export const ICON = {
  // steering stick: ring, knob, arrowheads left / right; pedal stick: arrowheads up / down
  steer: svg(`<circle cx="12" cy="12" r="10" ${LINE} stroke-width="1.6"/><circle cx="12" cy="12" r="4.6" fill="currentColor"/>` +
    '<path d="M2.9 12 L5.4 9.8 V14.2 Z M21.1 12 L18.6 9.8 V14.2 Z" fill="currentColor"/>'),
  pedal: svg(`<circle cx="12" cy="12" r="10" ${LINE} stroke-width="1.6"/><circle cx="12" cy="12" r="4.6" fill="currentColor"/>` +
    '<path d="M12 2.9 L9.8 5.4 H14.2 Z M12 21.1 L9.8 18.6 H14.2 Z" fill="currentColor"/>'),
  jump: svg(`<path d="M3.5 19 H8 M16 19 H20.5" ${LINE}/><path d="M6 15 Q12 1 18 15" ${LINE}/><path d="M18 15 L14.4 13.6 M18 15 L18.9 11.3" ${LINE}/>`),
  map: svg(`<path d="M3 6.5 L9 4 L15 6.5 L21 4 V17.5 L15 20 L9 17.5 L3 20 Z M9 4 V17.5 M15 6.5 V20" ${LINE}/>`),
  balloon: svg(`<circle cx="12" cy="9" r="6" fill="currentColor"/><path d="M8.2 13.6 L10.6 18.5 M15.8 13.6 L13.4 18.5" ${LINE} stroke-width="1.4"/><rect x="10" y="18.5" width="4" height="3" rx="0.6" fill="currentColor"/>`),
};

// ---------- rotate blocker (module level: up from page start, before the level loads) ----------
const BLOCK_CSS = `
#rotateblock { position: fixed; inset: 0; z-index: 10000; display: none; flex-direction: column; align-items: center;
  justify-content: center; gap: 22px; background: #111214; color: #e8e8e8; touch-action: none;
  font: 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 24px; box-sizing: border-box; }
#rotateblock.on { display: flex; }
#rotateblock svg { width: 120px; height: 120px; color: #fff; }
#rotateblock .ph { transform-origin: 60px 60px; animation: bdrock 2.6s ease-in-out infinite; }
@keyframes bdrock { 0%, 25% { transform: rotate(0deg); } 55%, 80% { transform: rotate(-90deg); } 100% { transform: rotate(0deg); } }
@media (prefers-reduced-motion: reduce) { #rotateblock .ph { animation: none; } }
`;
const PHONE_SVG = `<svg viewBox="0 0 120 120" aria-hidden="true">
  <path d="M28 28 A44 44 0 0 1 92 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.45"/>
  <path d="M92 24 L84 21 M92 24 L90 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.45"/>
  <g class="ph"><rect x="42" y="26" width="36" height="68" rx="6" fill="none" stroke="currentColor" stroke-width="3.5"/>
  <line x1="54" y1="87" x2="66" y2="87" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></g></svg>`;
let blocked = false, blockEl = null;
const blockSubs = [];
const wantBlock = () => touch && !mm('(any-pointer: fine)') && mm('(orientation: portrait)');
function checkBlock() {
  const b = wantBlock();
  if (b && !blockEl && typeof document !== 'undefined' && document.body) {
    const st = document.createElement('style'); st.textContent = BLOCK_CSS; document.head.appendChild(st);
    blockEl = document.createElement('div'); blockEl.id = 'rotateblock';
    blockEl.innerHTML = `${PHONE_SVG}<div>Bitte das Handy quer drehen.</div>`;
    for (const t of ['pointerdown', 'touchstart', 'contextmenu']) blockEl.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    document.body.appendChild(blockEl);
  }
  if (b === blocked) return;
  blocked = b;
  blockEl?.classList.toggle('on', b);
  for (const cb of blockSubs) cb(b);
}
export const isBlocked = () => blocked;
if (typeof addEventListener === 'function' && typeof document !== 'undefined') {
  for (const q of ['(orientation: portrait)', '(any-pointer: fine)']) {
    try { matchMedia(q).addEventListener('change', checkBlock); } catch { /* old Safari: resize below */ }
  }
  addEventListener('resize', checkBlock);
  addEventListener('orientationchange', checkBlock);
  onTouch(checkBlock);
  // prefer landscape where the browser allows it (fullscreen / installed only; rejects elsewhere)
  const lock = () => {
    removeEventListener('pointerdown', lock, true);
    try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* not supported */ }
  };
  onTouch(() => addEventListener('pointerdown', lock, true));
}

const CSS = `
#touchui { position: absolute; inset: 0; pointer-events: none; z-index: 1050;
  --s: clamp(110px, 30vmin, 150px); --b: clamp(50px, 15vmin, 64px); --g: 12px; --e: 16px; --bot: 24px; }
#touchui .zone, #touchui .tb { position: absolute; pointer-events: auto; touch-action: none;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
#touchui .zone { bottom: 0; width: 40vw; }
#touchui .zone.l { left: 0; }
#touchui .zone.r { right: 0; }
#touchui .base { position: absolute; width: var(--s); height: var(--s); margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  box-sizing: border-box; border-radius: 50%; background: rgba(0, 0, 0, 0.42); pointer-events: none; color: rgba(255, 255, 255, 0.5);
  border: 2px solid rgba(255, 255, 255, 0.45); box-shadow: inset 0 0 0 calc(var(--s) * 0.07) rgba(255, 255, 255, 0.08), 0 0 10px rgba(0, 0, 0, 0.3); }
#touchui .base > svg { position: absolute; inset: 0; width: 100%; height: 100%; }
#touchui .knob { position: absolute; left: 50%; top: 50%; width: 45%; height: 45%; margin: -22.5% 0 0 -22.5%; border-radius: 50%;
  background: rgba(235, 238, 242, 0.7); border: 1px solid rgba(255, 255, 255, 0.8); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  transition: transform 0.12s ease-out; }
#touchui .base.on .knob { transition: none; background: rgba(250, 251, 252, 0.85); }
#touchui .tb { box-sizing: border-box; width: var(--b); height: var(--b); border-radius: 50%; padding: calc(var(--b) * 0.22);
  color: rgba(255, 255, 255, 0.88); background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.35); }
#touchui .tb.on { background: rgba(255, 255, 255, 0.3); color: #fff; }
#touchui .jump { right: calc(var(--e) + (var(--s) - var(--b)) / 2); bottom: calc(var(--bot) + var(--s) + var(--g)); }
#touchui .map { right: calc(var(--e) + (var(--s) - var(--b)) / 2 + var(--b) + var(--g)); bottom: calc(var(--bot) + var(--s) + var(--g)); }
#touchui .ride { right: calc(var(--e) + (var(--s) - var(--b)) / 2); bottom: calc(var(--bot) + var(--s) + 2 * var(--g) + var(--b)); display: none; }
#touchui .ride.show { display: block; }
body.touch { -webkit-touch-callout: none; overscroll-behavior: none; }
body.touch #c { touch-action: none; }
body.touch #sbahnOff { z-index: 1060 !important; }   /* above the right stick's zone where they meet */
body.touch #mm { top: calc(var(--toprow, 42px) + 14px); bottom: auto; --mmd: 110px; }   /* round map + text column; +14 px for the N on the rim */
`;
// faint track on a base: arrowheads along the stick's one axis (viewBox 0..100)
const TRACK = {
  x: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M8 50 L17 43 V57 Z M92 50 L83 43 V57 Z" fill="currentColor"/><path d="M22 50 H78" stroke="currentColor" stroke-width="1.5" opacity="0.5"/></svg>',
  y: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 8 L43 17 H57 Z M50 92 L43 83 H57 Z" fill="currentColor"/><path d="M50 22 V78" stroke="currentColor" stroke-width="1.5" opacity="0.5"/></svg>',
};

export function createTouch({ balloon = () => null, paused = () => false, onBlock = () => {}, parent = document.body } = {}) {
  // the rotate blocker pauses the game (index.html pause reason 'rotate'); now if already up
  blockSubs.push((b) => onBlock(b));
  if (blocked) onBlock(true);
  let built = false;
  onTouch(build);
  function build() {
    if (built) return;
    built = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    document.body.classList.add('touch');

    const root = document.createElement('div');
    root.id = 'touchui';
    root.innerHTML = `
      <div class="zone l"></div><div class="zone r"></div>
      <div class="base l">${TRACK.x}<div class="knob"></div></div>
      <div class="base r">${TRACK.y}<div class="knob"></div></div>
      <div class="tb jump">${ICON.jump}</div>
      <div class="tb map">${ICON.map}</div>
      <div class="tb ride">${ICON.balloon}</div>`;
    parent.appendChild(root);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari pinch zoom ignores user-scalable=no; its gesture events can be cancelled
    for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });

    const CODE = { ' ': 'Space', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
    const send = (type, key) => dispatchEvent(new KeyboardEvent(type, {
      key, code: CODE[key] || 'Key' + key.toUpperCase(), bubbles: true, cancelable: true }));
    const held = new Set();
    const hold = (key, on) => {
      if (on && !held.has(key)) { held.add(key); send('keydown', key); }
      else if (!on && held.has(key)) { held.delete(key); send('keyup', key); }
    };

    // ---------- the two sticks: same look, one axis each ----------
    const ON = 0.25, OFF = 0.15;   // engage / release, fraction of the base's radius (the knob travels 0.55)
    function stick(side, ax, neg, pos) {
      const zone = root.querySelector('.zone.' + side), base = root.querySelector('.base.' + side), knob = base.querySelector('.knob');
      let sp = null;   // { id, cx, cy } the finger on this stick
      const size = () => base.offsetWidth || 130;
      const rest = () => {   // resting centre (px from the viewport's left / top)
        const r = size() / 2;
        return { x: side === 'l' ? 16 + r : innerWidth - 16 - r, y: innerHeight - 24 - r };
      };
      const place = (x, y) => { base.style.left = x + 'px'; base.style.top = y + 'px'; };
      function layout() {
        // the zone: lower half; on the left also below the minimap (its round map takes taps)
        let top = innerHeight / 2;
        const m = side === 'l' && document.querySelector('#mm canvas');
        if (m) { const r = m.getBoundingClientRect(); if (r.height) top = Math.max(top, r.bottom + 10); }
        zone.style.top = Math.round(Math.min(top, innerHeight - size() - 30)) + 'px';
        if (!sp) { const p = rest(); place(p.x, p.y); }
      }
      function move(e) {
        const rad = size() / 2, travel = rad * 0.55;
        const d = Math.max(-travel, Math.min(travel, ax === 'x' ? e.clientX - sp.cx : e.clientY - sp.cy));
        knob.style.transform = ax === 'x' ? `translateX(${d.toFixed(1)}px)` : `translateY(${d.toFixed(1)}px)`;
        const v = (ax === 'x' ? d : -d) / rad;   // y: up is positive (gas)
        hold(pos, held.has(pos) ? v > OFF : v > ON);
        hold(neg, held.has(neg) ? v < -OFF : v < -ON);
      }
      function up() {
        hold(neg, false); hold(pos, false);
        if (sp) { try { zone.releasePointerCapture(sp.id); } catch { /* gone */ } }
        sp = null;
        base.classList.remove('on');
        knob.style.transform = '';
        const p = rest(); place(p.x, p.y);
      }
      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (sp || paused() || blocked) return;
        const r = size() / 2, p = rest(), x = e.clientX, y = e.clientY;
        // on the resting base: it stays (the press itself counts); elsewhere it comes under the thumb
        const onBase = Math.hypot(x - p.x, y - p.y) <= r;
        const cx = onBase ? p.x : Math.min(Math.max(x, r + 4), innerWidth - r - 4);
        const cy = onBase ? p.y : Math.min(Math.max(y, r + 4), innerHeight - r - 22);   // clear of the credit line
        sp = { id: e.pointerId, cx, cy };
        try { zone.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        place(cx, cy);
        base.classList.add('on');
        move(e);
      });
      zone.addEventListener('pointermove', (e) => { if (sp && e.pointerId === sp.id) move(e); });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        zone.addEventListener(t, (e) => { if (sp && e.pointerId === sp.id) up(); });
      }
      return { up, layout, get busy() { return !!sp; } };
    }
    const sticks = [stick('l', 'x', 'ArrowLeft', 'ArrowRight'), stick('r', 'y', 'ArrowDown', 'ArrowUp')];

    // ---------- one-shot buttons: keydown + keyup, as a key tap ----------
    function tap(el, key) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (paused() || blocked) return;
        send('keydown', key); send('keyup', key);
        el.classList.add('on');
        setTimeout(() => el.classList.remove('on'), 150);
      });
    }
    tap(root.querySelector('.jump'), ' ');
    tap(root.querySelector('.map'), 'n');
    const ride = root.querySelector('.ride');
    tap(ride, 'e');

    // everything up (the game drops its keys on blur / pause as well; keyup keeps both in step)
    const releaseAll = () => { for (const s of sticks) s.up(); held.clear(); };
    const layout = () => { for (const s of sticks) s.layout(); };
    addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
    addEventListener('pagehide', releaseAll);
    blockSubs.push((b) => { if (b) releaseAll(); });
    addEventListener('resize', () => { releaseAll(); layout(); });
    layout();

    // a pause (menu, map, loading, rotate) lets go of both sticks; the balloon button only while
    // the car stands at the platform and no ride is running; the left zone follows the minimap
    let wasPaused = false;
    setInterval(() => {
      const p = !!paused() || blocked;
      if (p && !wasPaused) releaseAll();
      wasPaused = p;
      let b = null;
      try { b = balloon(); } catch { /* not created yet */ }
      ride.classList.toggle('show', !!(b && b.near && !b.riding));
      for (const s of sticks) if (!s.busy) s.layout();
    }, 200);
  }
  return { get active() { return built; } };
}

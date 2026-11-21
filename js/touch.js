// Touch controls for phones and tablets (symbols only, no lettering: quiet game).
//
//   import { createTouch } from './js/touch.js';
//   createTouch({ balloon: () => balloon });   // after the keyboard listeners exist
//
// Shown only on touch devices: `(pointer: coarse)` at load, or the first touchstart anywhere
// (a laptop with a touchscreen). A mouse-only desktop never sees anything of this.
// Every control goes through the keyboard paths: it dispatches the same keydown / keyup
// events on window that a key would (held controls once on press and once on release, so
// index.html's `keys` set holds exactly what a held key would hold; one-shot buttons send
// keydown + keyup). Nothing in the game reads touch directly.
//   left thumb:  one steering pad, left half = ArrowLeft, right half = ArrowRight (slide across)
//   right thumb: one pedal pad, left half = ArrowDown (brake, hold at standstill = reverse),
//                right half = ArrowUp (gas)
//   round:       jump (Space) above the gas, overview map (N) above the brake,
//                balloon ride (E) only while the car stands at the Weltballon platform
// The S-Bahn "Runter von den Gleisen" button (#sbahnOff) is already tappable, so G has no pad.
// Pointer capture per finger, any number of fingers; released on pointerup / pointercancel /
// lostpointercapture, on window blur (the game clears its keys there) and when the page hides.
// Layout on touch (body.touch): the minimap moves to the top left (--toprow is 0 since the top
// row is gone, index.html), the round menu button (js/menu.js #menuBtn) sits in the top right
// corner, the area sign top centre between them (js/areasign.js keeps clear of the map), so the
// bottom corners are free for the pads.

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
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
  left: svg('<path d="M16 4.5 L6.5 12 L16 19.5 Z" fill="currentColor"/>'),
  right: svg('<path d="M8 4.5 L17.5 12 L8 19.5 Z" fill="currentColor"/>'),
  gas: svg('<path d="M12 4 L20 18.5 H4 Z" fill="currentColor"/>'),
  brake: svg('<path d="M12 20 L20 5.5 H4 Z" fill="currentColor"/>'),
  jump: svg(`<path d="M3.5 19 H8 M16 19 H20.5" ${LINE}/><path d="M6 15 Q12 1 18 15" ${LINE}/><path d="M18 15 L14.4 13.6 M18 15 L18.9 11.3" ${LINE}/>`),
  map: svg(`<path d="M3 6.5 L9 4 L15 6.5 L21 4 V17.5 L15 20 L9 17.5 L3 20 Z M9 4 V17.5 M15 6.5 V20" ${LINE}/>`),
  balloon: svg(`<circle cx="12" cy="9" r="6" fill="currentColor"/><path d="M8.2 13.6 L10.6 18.5 M15.8 13.6 L13.4 18.5" ${LINE} stroke-width="1.4"/><rect x="10" y="18.5" width="4" height="3" rx="0.6" fill="currentColor"/>`),
};

const CSS = `
#touchui { position: absolute; inset: 0; pointer-events: none; z-index: 1050;
  --p: clamp(60px, 21vmin, 96px); --b: clamp(44px, 14vmin, 60px); --g: 10px; --e: 12px; --bot: 24px; }
#touchui .tz, #touchui .tb { position: absolute; pointer-events: auto; touch-action: none; box-sizing: border-box;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
  color: rgba(255, 255, 255, 0.85); }
#touchui .tz { display: flex; gap: var(--g); bottom: var(--bot); width: calc(2 * var(--p) + var(--g)); }
#touchui .tz > span { flex: 1; display: flex; align-items: center; justify-content: center; padding: 22%;
  box-sizing: border-box; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 14px; }
#touchui .tz > span.on, #touchui .tb.on { background: rgba(255, 255, 255, 0.3); color: #fff; }
#touchui .steer { left: var(--e); height: var(--p); }
#touchui .pedal { right: var(--e); height: calc(1.25 * var(--p)); }
#touchui .tb { width: var(--b); height: var(--b); border-radius: 50%; padding: calc(var(--b) * 0.2);
  bottom: calc(var(--bot) + 1.25 * var(--p) + var(--g)); background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.35); }
#touchui .jump { right: calc(var(--e) + (var(--p) - var(--b)) / 2); }
#touchui .map { right: calc(var(--e) + var(--p) + var(--g) + (var(--p) - var(--b)) / 2); }
#touchui .ride { right: calc(var(--e) + 2 * var(--p) + 2 * var(--g)); display: none; }
#touchui .ride.show { display: block; }
body.touch { -webkit-touch-callout: none; overscroll-behavior: none; }
body.touch #c { touch-action: none; }
body.touch #mm { top: calc(var(--toprow, 42px) + 14px); bottom: auto; --mmd: 110px; }   /* round map + text column; +14 px for the N on the rim */
`;

export function createTouch({ balloon = () => null, parent = document.body } = {}) {
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
      <div class="tz steer"><span>${ICON.left}</span><span>${ICON.right}</span></div>
      <div class="tz pedal"><span>${ICON.brake}</span><span>${ICON.gas}</span></div>
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
    const held = new Map();   // key -> number of fingers holding it
    const zones = [];
    function hold(key, on) {
      const n = (held.get(key) || 0) + (on ? 1 : -1);
      if (n > 0) { if (!held.get(key)) send('keydown', key); held.set(key, n); }
      else if (held.has(key)) { held.delete(key); send('keyup', key); }
    }

    // a pad split in two halves; a finger may slide across (small hysteresis in the middle)
    function zone(el, keyA, keyB) {
      const halves = el.children, ptr = new Map();   // pointerId -> key
      const paint = () => {
        const now = new Set(ptr.values());
        halves[0].classList.toggle('on', now.has(keyA));
        halves[1].classList.toggle('on', now.has(keyB));
      };
      const pick = (e, cur) => {
        const r = el.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
        if (cur === keyA && f < 0.56) return keyA;
        if (cur === keyB && f > 0.44) return keyB;
        return f < 0.5 ? keyA : keyB;
      };
      const set = (id, key) => {
        const cur = ptr.get(id);
        if (cur === key) return;
        if (key) { ptr.set(id, key); hold(key, true); } else ptr.delete(id);
        if (cur) hold(cur, false);
        paint();
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        set(e.pointerId, pick(e, null));
      });
      el.addEventListener('pointermove', (e) => { if (ptr.has(e.pointerId)) set(e.pointerId, pick(e, ptr.get(e.pointerId))); });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => set(e.pointerId, null));
      zones.push({ reset() { ptr.clear(); paint(); } });
    }
    zone(root.querySelector('.steer'), 'ArrowLeft', 'ArrowRight');
    zone(root.querySelector('.pedal'), 'ArrowDown', 'ArrowUp');

    // one-shot buttons: keydown + keyup, as a key tap
    function tap(el, key) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        send('keydown', key); send('keyup', key);
        el.classList.add('on');
        setTimeout(() => el.classList.remove('on'), 150);
      });
    }
    tap(root.querySelector('.jump'), ' ');
    tap(root.querySelector('.map'), 'n');
    const ride = root.querySelector('.ride');
    tap(ride, 'e');

    // everything up: the game has already dropped its keys on blur; keyup for the rest
    function releaseAll(sendUp) {
      for (const z of zones) z.reset();
      if (sendUp) for (const k of held.keys()) send('keyup', k);
      held.clear();
    }
    addEventListener('blur', () => releaseAll(false));
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(true); });
    addEventListener('pagehide', () => releaseAll(true));

    // balloon button: only while the car stands at the platform and no ride is running
    setInterval(() => {
      let b = null;
      try { b = balloon(); } catch { /* not created yet */ }
      ride.classList.toggle('show', !!(b && b.near && !b.riding));
    }, 250);
  }
  return { get active() { return built; } };
}

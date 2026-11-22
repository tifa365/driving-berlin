// Game controllers (Gamepad API), 2026-11-22. Polled once per frame from index.html frame()
// (also while paused, so the menu can be worked). Quiet game: no message on connect.
//
//   import { createGamepad } from './js/gamepad.js';
//   const pad = createGamepad({ analog, key, blocked, paused, menu, minimap, mapDriving, toggleView });
//   pad.poll(now)          // every frame
//   pad.connected / pad.id / pad.state() / pad.inject(getPads | null)   (berlinDrive.gamepad)
//
// Driving goes through index.html's analog object (vehicle.setSteeringTarget / fractional
// setThrottle / setBrake in stepOnce); every other button through the same key events as the
// keyboard (key(k): keydown + keyup on window), so menu, map, S-Bahn, jump work unchanged.
// Standard mapping (gamepad.mapping === 'standard'):
//   left stick x      steering, analog: dead zone 12 %, then js/touch.js steerCurve (|x|^1.6)
//   d-pad left/right  steering, digital (full lock at the normal rate)
//   right trigger (7) gas, analog      left trigger (6) brake, analog; held at a standstill = reverse
//   A (0) jump (Space)   B (1) turn around (U)   X (2) off the S-Bahn tracks (G)   Y (3) view Standard <-> Horizont
//   Start (9) menu (Esc)   Back (8) map (N)   bumpers (4 / 5) nothing in the game
//   pads without triggers (fewer than 8 buttons): right stick up / down or A / B = gas / brake
// Menu: d-pad / left stick = arrow keys (first step at once, then after 350 ms every 140 ms),
//   A = activate the focused control (a slider: one step), B = Esc (back / close), Start = close.
// Map overview: left stick pans, bumpers zoom (RB in, LB out), A re-centres, B closes; the gas
//   trigger starts the hidden map drive like an arrow key, after that the pad drives as usual.
// Non-standard mapping (''): axis 0 steers, gas / brake = buttons 7 / 6 if present, else 0 / 1.
// Mixed with keyboard / touch: the pad writes an analog channel only when its value CHANGES
// (a resting pad writes nothing, so it never overrides keys or the touch stick); a real key press
// for steering or a pedal clears that channel until the pad moves clearly again: last input wins.
// Buttons act on the press edge. Nothing while blocked() (loading screen, rotate blocker) or
// while paused outside menu / map; drive channels are released on disconnect and on any pause.
// Phones: while a pad is in use body.padmode hides the touch controls (#touchui); they come back
// after IDLE_S without pad input, on disconnect, or on the next touch.

import { steerCurve } from './touch.js';

const DEAD = 0.12, TRIG_DEAD = 0.05, EPS = 0.03, EPS_AFTER_KEY = 0.15, IDLE_S = 30;
const REPEAT_FIRST = 350, REPEAT_EVERY = 140;
const PAN_PX_S = 700, ZOOM_PER_S = 1.8;

export function createGamepad({ analog, key = () => {}, blocked = () => false, paused = () => false, menu = () => null, minimap = () => null,
                                mapDriving = () => false, toggleView = () => {},
                                getPads = () => (navigator.getGamepads ? navigator.getGamepads() : []) } = {}) {
  let source = getPads, index = -1, id = '', prevBtn = [], prevGas = false, lastT = 0, lastInput = -1e9, mode = 'none';
  const last = { steer: null, gas: null, brake: null }, eps = { steer: EPS, gas: EPS, brake: EPS };
  const rep = new Map();   // direction -> next fire time (menu key repeat)

  const st = document.createElement('style');
  st.textContent = 'body.padmode #touchui { display: none !important; }';
  document.head.appendChild(st);
  const padmode = (on) => document.body.classList.toggle('padmode', on);
  addEventListener('touchstart', () => padmode(false), { capture: true, passive: true });

  // a real key for steering / a pedal: that channel goes back to the keys until the pad moves clearly
  const KEYCH = { ArrowLeft: 'steer', ArrowRight: 'steer', a: 'steer', d: 'steer', ArrowUp: 'pedal', ArrowDown: 'pedal', w: 'pedal', s: 'pedal' };
  addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const ch = KEYCH[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (ch === 'steer') { analog.steer = 0; eps.steer = EPS_AFTER_KEY; }
    else if (ch === 'pedal') { analog.gas = 0; analog.brake = 0; eps.gas = eps.brake = EPS_AFTER_KEY; }
  }, true);

  function write(ch, v) {
    const l = last[ch];
    if (l === null) { if (v !== 0) analog[ch] = v; last[ch] = v; return; }   // (re)entering: a resting pad writes nothing
    if (Math.abs(v - l) > eps[ch] || (v === 0 && l !== 0)) { analog[ch] = v; last[ch] = v; eps[ch] = EPS; }
  }
  function releaseDrive() {
    for (const ch of ['steer', 'gas', 'brake']) { if (last[ch]) analog[ch] = 0; last[ch] = null; eps[ch] = EPS; }
  }
  function forget() { releaseDrive(); index = -1; id = ''; prevBtn = []; rep.clear(); padmode(false); }
  addEventListener('gamepaddisconnected', (e) => { if (e.gamepad?.index === index) forget(); });
  addEventListener('gamepadconnected', () => { /* picked up by polling on its first input */ });

  const pressed = (b) => !!b && (b.pressed || b.value > 0.5);
  const val = (b) => (b ? (typeof b.value === 'number' ? b.value : b.pressed ? 1 : 0) : 0);
  const busy = (p) => p.buttons.some(pressed) || p.axes.some((a) => Math.abs(a) > 0.3);

  function pick(list) {
    const cur = index >= 0 ? list[index] : null;
    if (cur && cur.connected !== false) return cur;
    if (index >= 0) forget();
    for (const p of list) if (p && p.connected !== false && busy(p)) { index = p.index ?? list.indexOf(p); id = String(p.id || '').slice(0, 60); return p; }
    return null;
  }

  // per-frame reading of the pad into one small record
  function read(p) {
    const b = p.buttons, a = p.axes, std = p.mapping === 'standard';
    const r = { steer: 0, gas: 0, brake: 0, btn: b.map(pressed), dir: { up: false, down: false, left: false, right: false }, panX: 0, panY: 0, std };
    const lx = a[0] || 0, ly = a[1] || 0;
    if (std) {
      r.steer = pressed(b[14]) ? -1 : pressed(b[15]) ? 1 : steerCurve(lx, DEAD);
      if (b.length > 7) { r.gas = val(b[7]); r.brake = val(b[6]); }
      else {   // no triggers: right stick or A / B
        const ry = a[3] || 0;
        r.gas = Math.max(pressed(b[0]) ? 1 : 0, ry < -0.2 ? -ry : 0);
        r.brake = Math.max(pressed(b[1]) ? 1 : 0, ry > 0.2 ? ry : 0);
      }
      r.dir.up = pressed(b[12]) || ly < -0.5; r.dir.down = pressed(b[13]) || ly > 0.5;
      r.dir.left = pressed(b[14]) || lx < -0.5; r.dir.right = pressed(b[15]) || lx > 0.5;
    } else {
      r.steer = steerCurve(lx, DEAD);
      const g = b.length > 7 ? [b[7], b[6]] : [b[0], b[1]];
      r.gas = val(g[0]); r.brake = val(g[1]);
      r.dir.up = ly < -0.5; r.dir.down = ly > 0.5; r.dir.left = lx < -0.5; r.dir.right = lx > 0.5;
    }
    if (r.gas < TRIG_DEAD) r.gas = 0;
    if (r.brake < TRIG_DEAD) r.brake = 0;
    r.panX = Math.abs(lx) > DEAD ? lx : 0; r.panY = Math.abs(ly) > DEAD ? ly : 0;
    return r;
  }

  function poll(now = performance.now()) {
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    let list = [];
    try { list = [...(source() || [])]; } catch { list = []; }
    const p = pick(list);
    if (!p) { if (now - lastInput > IDLE_S * 1000) padmode(false); return; }
    const r = read(p), edge = (i) => r.btn[i] && !prevBtn[i];
    const used = r.btn.some(Boolean) || r.steer !== 0 || r.gas > 0 || r.brake > 0 || r.panY !== 0;
    if (used) { lastInput = now; padmode(true); } else if (now - lastInput > IDLE_S * 1000) padmode(false);

    const ov = !!minimap()?.overview, m = menu();
    const next = blocked() ? 'none' : ov && !mapDriving() ? 'map' : m?.isOpen ? 'menu' : paused() ? 'none' : 'game';
    if (next !== mode) { if (mode === 'game') releaseDrive(); rep.clear(); mode = next; }

    if (mode === 'game') {
      write('steer', r.steer); write('gas', r.gas); write('brake', r.brake);
      if (r.std) {
        if (b7(p) && edge(0)) key(' ');   // A: jump (pads without triggers use A as gas)
        if (b7(p) && edge(1)) key('u');   // B: turn around
        if (edge(2)) key('g');            // X: off the S-Bahn tracks (only on them)
        if (edge(3)) toggleView();        // Y: Standard <-> Horizont
        if (edge(9)) key('Escape');       // Start: menu
        if (edge(8)) key('n');            // Back: map
      }
    } else if (mode === 'menu') {
      repeat(r.dir, now);
      if (edge(0)) activate();
      if (edge(1)) key('Escape');
      if (edge(9)) m.close();
      if (edge(8)) key('n');
    } else if (mode === 'map') {
      const mp = minimap();
      if ((r.panX || r.panY) && mp.pan) mp.pan(r.panX * PAN_PX_S * dt, r.panY * PAN_PX_S * dt);
      const z = (r.btn[5] ? 1 : 0) - (r.btn[4] ? 1 : 0);
      if (z && mp.zoom) mp.zoom(Math.exp(z * ZOOM_PER_S * dt));
      if (edge(0)) mp.recentre?.();
      if (edge(1) || edge(8)) key('Escape');
      if (edge(9)) key('Escape');
      if (r.gas > 0.2 && !prevGas) key('ArrowUp');   // starts the hidden map drive (index.html keydown)
    }
    prevGas = r.gas > 0.2;
    prevBtn = r.btn;
  }
  const b7 = (p) => p.buttons.length > 7;

  const DIRKEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  function repeat(dir, now) {
    for (const d of Object.keys(DIRKEY)) {
      if (!dir[d]) { rep.delete(d); continue; }
      const t = rep.get(d);
      if (t === undefined) { key(DIRKEY[d]); rep.set(d, now + REPEAT_FIRST); }
      else if (now >= t) { key(DIRKEY[d]); rep.set(d, now + REPEAT_EVERY); }
    }
  }
  // A in the menu: what Enter / Space would do on the focused control
  function activate() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    if (el.type === 'range') { try { el.stepUp(); } catch { /* not steppable */ } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return; }
    if (typeof el.click === 'function') el.click();
  }

  return {
    poll,
    inject(fn) { forget(); source = fn || getPads; },   // tests: a fake getPads (null = the browser's)
    get connected() { return index >= 0; },
    get id() { return id; },
    state() { return { connected: index >= 0, id, mode, steer: analog.steer, gas: analog.gas, brake: analog.brake, padmode: document.body.classList.contains('padmode') }; },
  };
}

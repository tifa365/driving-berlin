// Esc menu (2026-11-21): a clean screen while driving, everything else here. Opening it pauses
// the game (index.html pause reason 'menu'); the frozen picture stays behind, dimmed and blurred.
//
//   import { createMenu } from './js/menu.js';
//   const menu = createMenu({ bears, openMap, restart, newGame, settings, onPause, isBlocked, isOverview, onChange });
//   restart = "Zum Start" (key R: the car back to the start, progress kept); newGame = "Neustart"
//   (all progress back to zero), asked once in place first (page 'newgame'; Esc / Abbrechen = cancel).
//   menu.open(page = 'main')   // 'main' | 'settings' | 'controls' | 'info'
//   menu.close(); menu.isOpen; menu.page; menu.mapClosed() (the overview closed: back to the list)
//
// Header: the title "Driving Berlin" only (owner: no plate / sign in the menu).
// Main list: Karte, Einstellungen, Steuerung, Info, Zum Start, Neustart (resume: Esc / close button), and a plain line
// "Bären  7 / 18" (bears(): { count } - only the found count, no list, names or hints anywhere
// in the menu; not clickable, not in the arrow navigation).
// Keys (capture listener on window, registered after js/loading.js's, so the loading screen
// keeps every key while up): Esc opens the list / goes back one page / resumes from the list;
// H opens it on "Steuerung"; while open no key reaches the game; arrows move, Enter picks, N = map.
// While the overview map is up (isOverview) only Esc / N (js/minimap.js closes it) and the driving
// keys + Space (the hidden map drive, index.html) pass;
// the menu never opens over it.
// Touch: a round button with three bars top right (#menuBtn, body.touch only).
// settings(): rows [{ label, choices: [[value, text]], get(), set(v), disabled?, note? } | { label, node } | { action, run }],
// re-read on every open of the page; set() is the old control's function (same storage keys).

import { ensureSignFont } from './areasign.js';
import { HELP_CSS, MENU_ICON, controlsHtml, modesHtml, sourcesHtml, bearCount } from './intro.js';
import { onTouch } from './touch.js';

const CSS = `
#menu { position: absolute; inset: 0; z-index: 2500; display: none; background: rgba(8, 9, 11, 0.45);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e6e6e6; }
#menu.on { display: block; }
#menu.away { display: none; }
#c.paused { filter: blur(4px) brightness(0.7) saturate(0.75); }
#menu { transition: background-color var(--mfx-appear, 0s) ease-out; }
#menu .mpanel { transition: opacity var(--mfx-appear, 0s) ease-out, margin-left var(--mfx-appear, 0s) ease-out; }
#menu.opening { background-color: transparent; }
#menu.opening .mpanel, #menu.opening .mclose { opacity: 0; margin-left: -14px; pointer-events: none; }
#menu .mpanel { position: absolute; left: max(16px, 5vw); top: 50%; transform: translateY(-50%);
  width: min(440px, calc(100vw - 32px)); max-height: calc(100% - 32px); box-sizing: border-box; overflow: auto;
  padding: 22px 20px 18px; background: rgba(16, 17, 20, 0.86); border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
#menu .mpanel.wide { width: min(760px, calc(100vw - 32px)); }
#menu .mhead { margin: 0 0 16px 6px; }
#menu h1 { margin: 0 0 10px; font-size: 28px; font-family: "BerlinSign", "Liberation Sans Narrow", "Arial Narrow", sans-serif; font-weight: 700; font-synthesis: none; letter-spacing: 0.03em; color: #fff; }
#menu h2 { margin: 0; font-size: 19px; font-weight: 600; color: #fff; }
#menu .mclose { position: absolute; right: 14px; top: 14px; width: 44px; height: 44px; padding: 11px; box-sizing: border-box;
  border-radius: 50%; cursor: pointer; color: #fff; background: rgba(16, 17, 20, 0.8); border: 1px solid rgba(255, 255, 255, 0.35); }
#menu .mclose:hover, #menu .mclose:focus-visible { background: rgba(60, 62, 68, 0.95); outline: none; }
#menu .mi { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 46px; box-sizing: border-box;
  margin: 2px 0; padding: 0 14px; border: 0; border-left: 3px solid transparent; border-radius: 6px; background: transparent;
  color: #e6e6e6; font: 500 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left; cursor: pointer; }
#menu .mi:hover, #menu .mi:focus-visible, #menu .mi:focus { background: rgba(255, 255, 255, 0.09); border-left-color: #fff; outline: none; color: #fff; }
#menu .mi .cnt { font-size: 14px; color: #a8abb1; font-variant-numeric: tabular-nums; }
#menu .mback { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px 0 6px; margin: 0 0 6px -6px;
  border: 0; border-radius: 6px; background: transparent; color: #c9ccd1; font: 15px system-ui, sans-serif; cursor: pointer; }
#menu .mback:hover, #menu .mback:focus-visible { background: rgba(255, 255, 255, 0.09); color: #fff; outline: none; }
#menu .srow { margin: 0 0 14px; }
#menu .srow .sl { margin: 0 0 6px 2px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #9a9da3; }
#menu .srow .sc { display: flex; flex-wrap: wrap; gap: 6px; }
#menu .srow .note { margin: 4px 0 0 2px; font-size: 12px; color: #888; }
#menu .ch { min-height: 44px; min-width: 52px; padding: 0 14px; box-sizing: border-box; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.04); color: #ddd; font: 15px system-ui, sans-serif; }
#menu .ch:hover, #menu .ch:focus-visible { border-color: #fff; color: #fff; outline: none; }
#menu .ch.on { background: #fff; color: #000; border-color: #fff; box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 3.5px #111; }
#menu .ch:disabled { opacity: 0.45; cursor: default; }
#menu #camui { position: static; display: grid; grid-template-columns: auto 1fr 56px; gap: 8px 12px; align-items: center;
  padding: 0; background: none; border: 0; font: 14px system-ui, sans-serif; color: #ddd; }
#menu #camui input[type=range] { width: 100%; min-height: 44px; accent-color: #fff; }
#menu .mstat { display: flex; align-items: center; justify-content: space-between; min-height: 46px; box-sizing: border-box;
  margin: 2px 0; padding: 0 14px; border-left: 3px solid transparent; color: #c9ccd1; font: 500 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
#menu .mstat .cnt { font-size: 17px; color: #fff; font-variant-numeric: tabular-nums; }
#menu .info .bdcredits { margin-top: 14px; }
#menu .sact { margin-top: 20px; }
#menu .mlink { min-height: 44px; padding: 0 2px; border: 0; background: none; cursor: pointer; color: #b9bcc1;
  font: 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-decoration: underline; text-underline-offset: 3px; }
#menu .mlink:hover, #menu .mlink:focus-visible { color: #fff; outline: none; }
#menu .mask { margin: 0 0 12px 6px; font-size: 15px; line-height: 1.45; color: #ddd; }
#menuBtn { display: none; position: absolute; right: 12px; top: 12px; z-index: 1060; width: 44px; height: 44px; padding: 10px;
  box-sizing: border-box; border-radius: 50%; cursor: pointer; color: #fff; background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.4); -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
body.touch #menuBtn { display: block; }
`;

// slow-motion open / close (seconds): the game slows to a standstill while the picture goes
// diffuse, then the list appears; closing is short. prefers-reduced-motion: instant.
export const MENU_FX = { open: 0.35, appear: 0.12, close: 0.18 };
const MAP_PASS = new Set(['Escape', 'n', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', ' ']);
const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createMenu({ base = '', bears = () => null, openMap = () => {}, restart = () => {}, newGame = () => {},
                             settings = () => [], onPause = () => {}, isBlocked = () => false, isOverview = () => false,
                             onChange = () => {}, slowMo = null, parent = document.body } = {}) {
  // slowMo(to, seconds, done): index.html eases its time scale to `to` (0 or 1), then calls done()
  const style = document.createElement('style');
  ensureSignFont();
  style.textContent = HELP_CSS + CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'menu';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Menü');
  root.innerHTML = `<div class="mpanel"></div><button type="button" class="mclose" title="Weiter (Esc)" aria-label="Weiter">${CLOSE_ICON}</button>`;
  parent.appendChild(root);
  const panel = root.querySelector('.mpanel');
  const btn = document.createElement('button');
  btn.id = 'menuBtn'; btn.type = 'button'; btn.title = 'Menü'; btn.setAttribute('aria-label', 'Menü');
  btn.innerHTML = MENU_ICON;
  parent.appendChild(btn);
  const canvas = document.getElementById('c');
  let touch = false;
  onTouch(() => { touch = true; });
  let nBears = 0;
  bearCount(base).then((n) => { nBears = n; });

  let isOpen = false, page = 'main', from = null, mounted = null;

  const ITEMS = [['map', 'Karte'],   // no "Weiter" (owner): Esc, the close button and the touch menu button resume
                  ['settings', 'Einstellungen'],
                 ['controls', 'Steuerung'], ['info', 'Info'], ['start', 'Zum Start'], ['newgame', 'Neustart']];

  function unmount() { if (mounted) { try { mounted(); } catch { /* ignore */ } mounted = null; } }
  function render() {
    unmount();
    panel.classList.toggle('wide', page === 'controls');
    const back = '<button type="button" class="mback" data-nav data-act="back">&lsaquo; Zurück</button>';
    if (page === 'main') {
      const b = bears();
      panel.innerHTML = `<div class="mhead"><h1>Driving Berlin</h1></div>` +
        ITEMS.map(([k, t]) => `<button type="button" class="mi" data-nav data-act="${k}">${t}</button>`).join('') +
        (b?.count ? `<div class="mstat"><span>\u{1F43B} Bären</span><span class="cnt">${esc(b.count)}</span></div>` : '');
    } else if (page === 'settings') {
      panel.innerHTML = `${back}<div class="mhead"><h2>Einstellungen</h2></div><div class="rows"></div>`;
      const rows = panel.querySelector('.rows');
      for (const r of settings()) {
        const row = document.createElement('div'); row.className = 'srow';
        row.innerHTML = `<div class="sl">${esc(r.label)}</div>`;
        if (r.action) {   // a quiet text button (e.g. "Auf Standard zurücksetzen")
          row.className = 'srow sact'; row.innerHTML = '';
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'mlink'; b.textContent = r.action; b.dataset.nav = '';
          b.addEventListener('click', () => r.run());
          row.appendChild(b); rows.appendChild(row); continue;
        }
        if (r.node) {
          row.appendChild(r.node);
          const n = r.node, home = r.home;
          const prev = mounted;
          mounted = () => { prev?.(); if (home) home.appendChild(n); };
        } else {
          const sc = document.createElement('div'); sc.className = 'sc';
          const cur = r.get();
          for (const [v, t] of r.choices) {
            const c = document.createElement('button');
            c.type = 'button'; c.className = 'ch' + (String(v) === String(cur) ? ' on' : '');
            c.textContent = t; c.dataset.nav = ''; c.disabled = !!r.disabled;
            c.addEventListener('click', () => {
              r.set(v); onChange();
              const now = String(r.get());   // what really holds (a refused choice stays unmarked)
              [...sc.children].forEach((o, i) => o.classList.toggle('on', String(r.choices[i][0]) === now));
            });
            sc.appendChild(c);
          }
          row.appendChild(sc);
        }
        if (r.note) row.insertAdjacentHTML('beforeend', `<div class="note">${esc(r.note)}</div>`);
        rows.appendChild(row);
      }
    } else if (page === 'newgame') {   // the one confirm step before progress is wiped
      panel.innerHTML = `<div class="mhead"><h2>Neustart</h2></div>
        <p class="mask">Alles zurücksetzen? Alle Bären sind wieder versteckt.</p>
        <button type="button" class="mi" data-nav data-act="newgame-yes">Ja, neu starten</button>
        <button type="button" class="mi" data-nav data-act="back">Abbrechen</button>`;
    } else if (page === 'controls') {
      panel.innerHTML = `${back}<div class="mhead"><h2>Steuerung</h2></div><div class="bdhelp${touch ? ' touch' : ''}">${controlsHtml()}</div>`;
    } else if (page === 'info') {
      panel.innerHTML = `${back}<div class="mhead"><h2>Info</h2></div><div class="bdhelp info">${modesHtml(nBears)}${sourcesHtml()}</div>`;
    }
    focusFirst();
  }
  const navs = () => [...panel.querySelectorAll('[data-nav], #camui input')].filter((n) => !n.disabled && n.offsetParent !== null);
  function focusFirst() {
    const want = from && page === 'main' ? panel.querySelector(`[data-act="${from}"]`)
      : page === 'newgame' ? panel.querySelector('[data-act="back"]')   // the safe choice first
      : panel.querySelector('.ch.on') || navs()[0];
    from = null;
    (want || navs()[0])?.focus({ preventScroll: true });
  }
  function go(p) { if (page !== 'main' && p === 'main') from = page; page = p; render(); }

  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  let paused = false, fxToken = 0;
  root.style.setProperty('--mfx-appear', MENU_FX.appear + 's');
  // one CSS transition on the canvas filter per open / close (no per-frame style changes)
  const canvasFx = (sec) => { if (canvas) canvas.style.transition = sec > 0 ? `filter ${sec}s ease-out` : ''; };
  function open(p = 'main') {
    if (isBlocked()) return false;
    page = p;
    if (!isOpen) {
      isOpen = true;
      const tok = ++fxToken;
      root.classList.add('on'); root.classList.remove('away');
      const fx = slowMo && !reduced();
      canvasFx(fx ? MENU_FX.open : 0);
      canvas?.classList.add('paused');
      if (!fx) { paused = true; onPause(true); render(); return true; }
      root.classList.add('opening');   // the game slows down under a diffusing picture; the list waits
      render();
      slowMo(0, MENU_FX.open, () => {
        if (tok !== fxToken || !isOpen) return;   // closed again meanwhile
        paused = true; onPause(true);
        root.classList.remove('opening');   // the list fades / slides in (MENU_FX.appear)
        focusFirst();
      });
      return true;
    }
    render();
    return true;
  }
  function close() {
    if (!isOpen) return;
    unmount();
    isOpen = false; fxToken++;
    root.classList.remove('on', 'away', 'opening');   // the menu goes at once
    const fx = slowMo && !reduced();
    canvasFx(fx ? MENU_FX.close : 0);
    canvas?.classList.remove('paused');   // the picture sharpens over MENU_FX.close
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
    if (paused) { paused = false; onPause(false); }   // driving keys work from this frame on
    if (fx) slowMo(1, MENU_FX.close, () => { if (!isOpen) canvasFx(0); });
    else slowMo?.(1, 0, () => {});
  }
  function act(a) {
    if (a === 'back') go('main');
    else if (a === 'resume') close();
    else if (a === 'map') { from = 'map'; root.classList.add('away'); openMap(); }
    else if (a === 'start') { close(); restart(); }
    else if (a === 'newgame-yes') { close(); newGame(); }
    else go(a);
  }
  function mapClosed() {
    if (!isOpen) return;
    root.classList.remove('away');
    page = 'main'; from = 'map'; render();
  }

  panel.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t) act(t.dataset.act); });
  root.querySelector('.mclose').addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });   // the dimmed game around the panel
  btn.addEventListener('click', (e) => { e.currentTarget.blur(); open('main'); });

  addEventListener('keydown', (e) => {
    if (isBlocked()) return;   // the loading screen holds the keys (its listener runs first anyway)
    const k = e.key;
    if (isOverview()) {   // the overview map handles Esc / N itself; nothing else reaches the game
      // the map's own keys (Esc, N) and - for the hidden map drive (index.html) - the driving keys and Space
      if (!MAP_PASS.has(k.length === 1 ? k.toLowerCase() : k)) e.stopImmediatePropagation();
      return;
    }
    if (!isOpen) {
      const t = e.target?.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'Escape' || ((k === 'h' || k === 'H' || k === '?') && !e.repeat)) {
        e.stopImmediatePropagation(); e.preventDefault();
        open(k === 'Escape' ? 'main' : 'controls');
      }
      return;
    }
    e.stopImmediatePropagation();   // nothing reaches the game while the menu is up
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape') { e.preventDefault(); if (!e.repeat) { if (page === 'main') close(); else go('main'); } return; }
    if ((k === 'n' || k === 'N') && !e.repeat) { e.preventDefault(); act('map'); return; }
    const range = e.target?.type === 'range';
    if (k === 'ArrowDown' || k === 'ArrowUp' || (!range && (k === 'ArrowLeft' || k === 'ArrowRight'))) {
      e.preventDefault();
      const l = navs(); if (!l.length) return;
      const i = l.indexOf(document.activeElement), d = k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1;
      l[i < 0 ? 0 : (i + d + l.length) % l.length].focus({ preventScroll: false });
      return;
    }
    if (k === ' ' && !e.target?.closest?.('button')) e.preventDefault();   // no page scroll
  }, true);

  return { open, close, mapClosed, get isOpen() { return isOpen; }, get page() { return page; }, button: btn, root };
}

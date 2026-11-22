// Shared help texts (2026-11-21: the start screen is gone; the game opens through the loading
// screen js/loading.js, everything else lives in the Esc menu js/menu.js):
//   HELP_CSS        styles for the pieces below (scoped to .bdhelp)
//   controlsHtml()  the key list, the touch layout and the controller list (menu page "Steuerung"); the wrapper
//                   gets class "touch" on touch devices (js/touch.js onTouch) to swap them
//   modesHtml()     the two ways to play (menu page "Info")
//   DATASETS, SOFTWARE  every dataset / library the game is built from (one list; README in step)
//   CREDITS_HTML    the short credit line from it (loading screen + end of the menu "Info")
//   sourcesHtml()   "Daten & Quellen" rows for the menu "Info"
//   bearCount(base) number of bears in the level's eggs.json (Promise, 0 if unknown)
// No storage key any more ('berlinDrive.intro' is no longer read or written).

import { ICON } from './touch.js';

export const HELP_CSS = `
.bdhelp { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #ddd; }
.bdhelp .ctl { display: flex; flex-wrap: wrap; gap: 14px 28px; align-items: flex-start; }
.bdhelp .main { display: grid; grid-template-columns: auto auto; gap: 12px 16px; align-items: center; }
.bdhelp .arrows { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: 44px 44px; gap: 5px; }
.bdhelp .arrows .up { grid-column: 2; }
.bdhelp .arrows .left { grid-column: 1; grid-row: 2; }
.bdhelp .arrows .down { grid-column: 2; grid-row: 2; }
.bdhelp .arrows .right { grid-column: 3; grid-row: 2; }
.bdhelp .kc { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; height: 44px; padding: 0 8px; font-size: 18px; color: #fff;
  background: linear-gradient(#4a4a4a, #262626); border: 1px solid #888; border-bottom-width: 4px; border-radius: 7px; }
.bdhelp .kc.space { width: 148px; font-size: 14px; }
.bdhelp .kc.s { min-width: 26px; height: 26px; padding: 0 6px; font-size: 13px; border-bottom-width: 3px; border-radius: 5px; }
.bdhelp .what { font-size: 15px; line-height: 1.5; color: #eee; }
.bdhelp .what b { color: #fff; }
.bdhelp .what small { color: #aaa; font-size: 13px; }
.bdhelp ul.more { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.25; color: #ccc;
  display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
.bdhelp ul.more li { display: contents; }
.bdhelp ul.more .kc { justify-self: center; }
.bdhelp .tctl { display: none; grid-template-columns: auto 1fr; gap: 10px 14px; align-items: center; }
.bdhelp.touch .tctl { display: grid; }
.bdhelp.touch .ctl { display: none; }
.bdhelp .tpad { display: flex; gap: 5px; justify-self: center; }
.bdhelp .tpad > span { box-sizing: border-box; width: 44px; height: 40px; padding: 9px; color: #fff;
  background: rgba(255, 255, 255, 0.1); border: 1px solid #888; border-radius: 9px; }
.bdhelp .tpad > span.r { width: 40px; border-radius: 50%; padding: 8px; }
.bdhelp .tpad > span.st { padding: 3px; border-color: transparent; background: none; }   /* the stick symbol draws its own ring */
.bdhelp .tctl .what { font-size: 14px; line-height: 1.35; }
.bdhelp .padh { margin: 18px 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #9a9da3; font-weight: 600; }
.bdhelp ul.pctl { list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 1.25; color: #ccc;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 14px; }
.bdhelp ul.pctl li { display: flex; align-items: center; gap: 10px; }
.bdhelp .pg { flex: none; display: inline-flex; width: 26px; height: 26px; color: #fff; align-items: center; justify-content: center; }
.bdhelp .pg .fb { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border-radius: 50%; border: 1.5px solid #bbb; font: 600 12px system-ui, sans-serif; font-style: normal; color: #fff; }
.bdhelp .pg .fb.sm { padding: 4px; }
.bdhelp .modes { display: grid; gap: 10px; }
.bdhelp .mode { padding: 10px 14px; background: rgba(255, 255, 255, 0.06); border: 1px solid #444; border-radius: 8px;
  font-size: 14px; line-height: 1.4; }
.bdhelp .mode b { display: block; font-size: 16px; color: #fff; margin-bottom: 3px; }
.bdhelp .egg { margin: 10px 0 0; font-size: 13px; color: #aaa; }
.bdcredits { font-size: 11px; line-height: 1.45; color: #8a8d93; }
.bdhelp .srch { margin: 18px 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #9a9da3; font-weight: 600; }
.bdhelp .src { display: grid; gap: 1px; margin: 0 0 10px; padding: 0 0 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 13px; line-height: 1.4; color: #b9bcc1; }
.bdhelp .src b { color: #eee; font-weight: 600; }
.bdhelp .src a.repo { color: #9fd0ff; text-decoration: underline; text-underline-offset: 2px; padding: 6px 0; display: inline-block; pointer-events: auto; }
.bdhelp .src a.repo:hover, .bdhelp .src a.repo:focus-visible { color: #fff; }
`;

const MENU_ICON = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M5 7 H19 M5 12 H19 M5 17 H19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
export { MENU_ICON };

export function controlsHtml() {
  return `
  <div class="ctl">
    <div class="main">
      <div class="arrows" aria-hidden="true">
        <span class="kc up">&uarr;</span><span class="kc left">&larr;</span><span class="kc down">&darr;</span><span class="kc right">&rarr;</span>
      </div>
      <div class="what"><b>&uarr;</b> Gas &nbsp; <b>&darr;</b> Bremse<br><b>&larr; &rarr;</b> lenken<br>
        <small>&darr; im Stand halten = rückwärts</small><br>
        <small>oder <span class="kc s">W</span> <span class="kc s">A</span> <span class="kc s">S</span> <span class="kc s">D</span></small></div>
      <span class="kc space">Leertaste</span>
      <div class="what"><b>Sprung</b><br><small>hilft, wenn das Auto feststeckt</small></div>
    </div>
    <ul class="more">
      <li><span class="kc s">Esc</span><span>Menü (das Spiel hält an)</span></li>
      <li><span class="kc s">N</span><span>Karte</span></li>
      <li><span class="kc s">B</span><span>Auto oder Bus</span></li>
      <li><span class="kc s">U</span><span>umdrehen (auch am Kartenrand)</span></li>
      <li><span class="kc s">V</span><span>Kamera: hinter dem Auto / Norden oben</span></li>
      <li><span class="kc s">C</span><span>Hindernisse an / aus</span></li>
      <li><span class="kc s">M</span><span>nächste Stimmung (Tag, Mond, Schnee)</span></li>
      <li><span class="kc s">R</span><span>zum Start (der Fortschritt bleibt)</span></li>
      <li><span class="kc s">H</span><span>diese Hilfe</span></li>
    </ul>
  </div>
  <div class="tctl" aria-hidden="true">
    <div class="tpad"><span class="r st">${ICON.steer}</span></div>
    <div class="what"><b>links: lenken</b><br><small>Steuerknüppel unten links: je weiter zur Seite, desto stärker</small></div>
    <div class="tpad"><span class="r">${ICON.back}</span><span class="r">${ICON.gas}</span></div>
    <div class="what"><b>rechts: Gas und Bremse / rückwärts</b><br><small>Bremse im Stand gehalten = rückwärts</small></div>
    <div class="tpad"><span class="r">${ICON.jump}</span></div>
    <div class="what"><b>Sprung</b><br><small>hilft, wenn das Auto feststeckt</small></div>
    <div class="tpad"><span class="r">${ICON.map}</span></div>
    <div class="what"><b>Karte</b><br><small>auch: die kleine Karte oben links antippen</small></div>
    <div class="tpad"><span class="r">${MENU_ICON}</span></div>
    <div class="what"><b>Menü</b><br><small>oben rechts; das Spiel hält an</small></div>
  </div>
  <h3 class="padh">Controller</h3>
  <ul class="pctl">
    <li><span class="pg">${PAD_GLYPH.stick}</span><span>Linker Stick: lenken</span></li>
    <li><span class="pg">${PAD_GLYPH.rt}</span><span>Rechter Trigger: Gas</span></li>
    <li><span class="pg">${PAD_GLYPH.lt}</span><span>Linker Trigger: Bremse / rückwärts</span></li>
    <li><span class="pg"><i class="fb">A</i></span><span>A: springen</span></li>
    <li><span class="pg"><i class="fb">B</i></span><span>B: umdrehen</span></li>
    <li><span class="pg"><i class="fb">X</i></span><span>X: runter von den Gleisen</span></li>
    <li><span class="pg"><i class="fb">Y</i></span><span>Y: Ansicht</span></li>
    <li><span class="pg"><i class="fb sm">${MENU_ICON}</i></span><span>Start: Menü</span></li>
    <li><span class="pg"><i class="fb sm">${PAD_GLYPH.back}</i></span><span>Back: Karte</span></li>
  </ul>`;
}
// simple controller glyphs (no brand shapes): stick = ring + knob, trigger = a rounded tab, back = two squares
const PAD_GLYPH = {
  stick: '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>',
  rt: '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M6 20 V9 Q6 4 12 4 H15 Q19 4 19 9 V20 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 15 L12.5 9.5 L15.5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lt: '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M18 20 V9 Q18 4 12 4 H9 Q5 4 5 9 V20 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 9.5 L11.5 15 L14.5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><rect x="4" y="4" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

export function modesHtml(bears = 0) {
  return `
  <div class="modes">
    <div class="mode"><b>Frei herumfahren</b>und die Stadt entdecken &ndash; auf dem echten 3D-Modell von Berlin-Mitte,
      vermessen aus Luftbildern.</div>
    <div class="mode"><b>&#x1F43B; ${bears ? `Die ${bears} Berliner Bären finden` : 'Die Berliner Bären finden'}</b>Einfach hineinfahren.
      Welche schon gefunden sind, steht im Menü unter &bdquo;Bären&ldquo;.</div>
  </div>
  <p class="egg">Unterwegs wartet noch mehr &ndash; Augen auf.</p>`;
}

// every dataset and library the published game is built from: ONE list for the loading screen's
// short line, the menu's "Daten & Quellen" and README "Licence and credits" (keep README in step).
// Licences only as stated in the repo (build scripts, README); where none is established the row
// says so instead of guessing.
export const DATASETS = [
  { name: '3D-Meshmodell Berlin 2025', short: '3D-Meshmodell Berlin 2025 © Berlin Partner für Wirtschaft und Technologie GmbH',
    by: 'Berlin Partner für Wirtschaft und Technologie GmbH (Datenregister: Senatsverwaltung für Wirtschaft, Energie und Betriebe)',
    licence: 'Nutzungsbedingungen des Anbieters (Berlin 3D Download-Portal)',
    use: 'das Bild der Stadt (3D-Kacheln) und die Straßenhöhen' },
  { name: 'OpenStreetMap', short: 'Straßen, Gebäude, Wasser © OpenStreetMap-Mitwirkende (ODbL)',
    by: '© OpenStreetMap-Mitwirkende', licence: 'ODbL 1.0',
    use: 'Straßen und Straßennamen, Gebäudeumrisse (Wände), Wasser, Brücken, Tunnel, S-Bahn-Strecke, Ortsteile, Karte' },
  { name: 'Baumkataster Berlin (Straßenbäume und Anlagenbäume, WFS „baumbestand“)', short: 'Bäume: Baumkataster Berlin (dl-de/zero-2.0)',
    by: 'Geoportal Berlin (gdi.berlin.de)', licence: 'dl-de/zero-2.0',
    use: 'Baumstämme als Hindernisse (nur wo das 3D-Modell eine Krone zeigt)' },
  { name: 'Straßenbefahrung 2014 (WFS „strassenbefahrung“: Fahrbahn, Parkflächen, Bushaltebereiche, Straßenbahngleise)', short: null,
    by: 'Geoportal Berlin (gdi.berlin.de)', licence: 'dl-de/zero-2.0',
    use: 'freie Fahrbahn: auf der Straße stehen keine Hindernisse' },
];
export const SOFTWARE = [
  { name: 'three.js', by: 'three.js authors', licence: 'MIT', use: '3D-Darstellung', short: 'three.js (MIT)' },
  { name: 'Box2D (box2dweb)', by: '© Erin Catto', licence: 'zlib', use: 'Fahrphysik', short: 'Box2D © Erin Catto (zlib)' },
  { name: 'D-DIN / D-DIN Condensed', by: '© 2017 Datto Inc.', licence: 'SIL OFL 1.1', use: 'Schrift der Schilder und des Titels',
    short: 'Schrift: D-DIN / D-DIN Condensed © Datto Inc. (SIL OFL 1.1)' },
  { name: 'Himmel (Himmelsbild, assets/sky/sky.webp)', by: 'Skyfall Protocol', licence: 'mit Erlaubnis des Autors',
    use: 'der Himmel und das Himmelslicht auf Auto und Bus', short: 'Himmel: Skyfall Protocol, mit Erlaubnis des Autors' },
];
// the public repository: shown as a link on the menu's Info page only (owner 2026-11-22)
export const REPO_URL = 'https://github.com/tifa365/driving-berlin';
const escT = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// the short line (loading screen, end of the menu's Info page)
export const CREDITS_HTML = `<p class="bdcredits">
  ${[...DATASETS, ...SOFTWARE].filter((d) => d.short).map((d) => escT(d.short)).join(' &middot;\n  ')}</p>`;
// the menu's "Daten & Quellen": one row per dataset / library
export function sourcesHtml() {
  const row = (d) => `<div class="src"><b>${escT(d.name)}</b><span>${escT(d.by)}</span>` +
    `<span>Lizenz: ${escT(d.licence)}</span><span>im Spiel: ${escT(d.use)}</span></div>`;
  return `<h3 class="srch">Daten &amp; Quellen</h3>${DATASETS.map(row).join('')}<h3 class="srch">Software, Schrift &amp; Himmel</h3>${SOFTWARE.map(row).join('')}` +
    `<h3 class="srch">Quelltext</h3><div class="src"><a class="repo" href="${REPO_URL}" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}</a></div>`;
}

// bears in the level's eggs.json (same file js/eggs.js reads; browser-cached)
export function bearCount(base = '') {
  return fetch(base + 'eggs.json').then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.items || []).filter((it) => it.kind === 'bear').length).catch(() => 0);
}

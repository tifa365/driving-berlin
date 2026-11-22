// Shared help texts (2026-11-21: the start screen is gone; the game opens through the loading
// screen js/loading.js, everything else lives in the Esc menu js/menu.js):
//   HELP_CSS        styles for the pieces below (scoped to .bdhelp)
//   controlsHtml()  the key list and the touch layout (menu page "Steuerung"); the wrapper
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
.bdhelp .tctl .what { font-size: 14px; line-height: 1.35; }
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
    <div class="tpad"><span>${ICON.left}</span><span>${ICON.right}</span></div>
    <div class="what"><b>lenken</b><br><small>linker Daumen, Feld unten links</small></div>
    <div class="tpad"><span>${ICON.brake}</span><span>${ICON.gas}</span></div>
    <div class="what"><b>Bremse</b> &nbsp; <b>Gas</b><br><small>Bremse im Stand halten = rückwärts</small></div>
    <div class="tpad"><span class="r">${ICON.jump}</span></div>
    <div class="what"><b>Sprung</b><br><small>hilft, wenn das Auto feststeckt</small></div>
    <div class="tpad"><span class="r">${ICON.map}</span></div>
    <div class="what"><b>Karte</b><br><small>auch: die kleine Karte oben links antippen</small></div>
    <div class="tpad"><span class="r">${MENU_ICON}</span></div>
    <div class="what"><b>Menü</b><br><small>oben rechts; das Spiel hält an</small></div>
  </div>`;
}

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
    licence: 'keine offene Lizenz; Nutzungsbedingungen des Download-Portals, siehe Datenportal',
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
const escT = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// the short line (loading screen, end of the menu's Info page)
export const CREDITS_HTML = `<p class="bdcredits">
  ${[...DATASETS, ...SOFTWARE].filter((d) => d.short).map((d) => escT(d.short)).join(' &middot;\n  ')}</p>`;
// the menu's "Daten & Quellen": one row per dataset / library
export function sourcesHtml() {
  const row = (d) => `<div class="src"><b>${escT(d.name)}</b><span>${escT(d.by)}</span>` +
    `<span>Lizenz: ${escT(d.licence)}</span><span>im Spiel: ${escT(d.use)}</span></div>`;
  return `<h3 class="srch">Daten &amp; Quellen</h3>${DATASETS.map(row).join('')}<h3 class="srch">Software, Schrift &amp; Himmel</h3>${SOFTWARE.map(row).join('')}`;
}

// bears in the level's eggs.json (same file js/eggs.js reads; browser-cached)
export function bearCount(base = '') {
  return fetch(base + 'eggs.json').then((r) => (r.ok ? r.json() : null))
    .then((d) => (d?.items || []).filter((it) => it.kind === 'bear').length).catch(() => 0);
}

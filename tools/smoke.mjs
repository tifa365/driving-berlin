#!/usr/bin/env node
// Layer 2 of the test suite: one headless load of the local game (about 1-3 minutes with
// software rendering). No uncaught error, no failed request except the optional site.json, the
// loading screen ends, every module is present on window.berlinDrive, the menu opens and
// pauses, the map opens and pauses.
//   node tools/smoke.mjs [--url http://127.0.0.1:8765/] [--port 9361] [--only NAME] [--list]
// (all layers in one browser session: tools/test.sh)
import { Browser, parseArgs, HELP, selected, row, timed, printTable, sleep } from './testlib.mjs';

// modules the game must have once loaded: name -> page expression (true = present)
export const MODULES = {
  vehicle: '!!B.vehicle', stream: '!!B.stream', minimap: '!B.minimap.pending', menu: '!!B.menu', loading: '!!B.intro',
  walls: '!!B.walls', clutter: '!!B.clutter', bridges: '!!B.bridges', sbahn: '!!B.sbahn?.data', tunnels: 'B.tunnels?.routes?.length > 0',
  roofs: '!!B.roofs?.data', noDrive: 'B.noDrive?.zones?.length > 0', respectLine: 'typeof B.respectLine?.show === "function"',
  balloon: '!!B.balloon', eggs: '!!B.eggs', skid: '!!B.skid', dust: '!!B.dust', areaSign: '!!B.areaSign', borderShimmer: '!!B.borderShimmer',
  doves: '!!B.doves', edge: '!!B.edgeModule', spots: 'B.spots().length > 0',
};
const OPTIONAL_FAIL = [/\/site\.json(\?|$)/];   // js/site.js: optional (only the published copy has one)

export const SMOKE_NAMES = ['start.load', 'start.errors', 'start.requests', 'start.modules', 'start.menu', 'start.map'];

// navigates b to url and waits for the game; returns { rows, loaded }
export async function runSmoke(b, { url, loadTimeout = 300, only = [] }) {
  const rows = [], t0 = Date.now();
  await b.navigate(url);
  // wait for the loading screen to end; give up early when an uncaught error has stopped the start
  // (no progress for 60 s after it) instead of waiting out the whole timeout
  let t = null, errAt = null, lastP = null;
  while ((Date.now() - t0) / 1000 < loadTimeout) {
    let v = null;
    try { v = await b.ev('window.berlinDrive && berlinDrive.intro ? [berlinDrive.intro.open, berlinDrive.intro.progress] : null', 30000); } catch { /* between documents */ }
    if (v && v[0] === false) { t = (Date.now() - t0) / 1000; break; }
    const p = await b.ev('(() => { const e = document.querySelector("#loading"); return e ? e.innerText.length + ":" + (window.berlinDrive?.intro?.progress ?? "") : ""; })()').catch(() => '');
    if (b.errors.some((e) => e.startsWith('uncaught'))) {
      if (errAt === null || p !== lastP) errAt = Date.now();
      if (Date.now() - errAt > 60000) break;
    }
    lastP = p;
    await sleep(2000);
  }
  const status = await b.ev('(document.querySelector("#loading .status, #loading")?.innerText || "").replace(/\\s+/g, " ").slice(0, 160)').catch(() => '');
  const loaded = t !== null;
  rows.push(row('start.load', loaded, loaded ? `loading screen gone after ${t.toFixed(0)} s` : `still open after ${((Date.now() - t0) / 1000).toFixed(0)} s`, `gone within ${loadTimeout} s`,
    loaded ? (t >= 60 ? 'Note: it took the 60 s safety exit of js/loading.js (tiles still streaming), normal with software rendering.' : '')
      : `The loading screen never went away (a start-up error stops the game before it can run). Screen text: "${status}". Errors: ${b.errors.slice(0, 3).join(' / ') || 'none'}`, (Date.now() - t0) / 1000));
  if (loaded) {   // the lazily loaded modules (import().then) get a little time to arrive
    const tm = Date.now();
    const expr = '(() => { const B = berlinDrive; const r = {}; ' + Object.entries(MODULES).map(([k, e]) => `try { r[${JSON.stringify(k)}] = !!(${e}); } catch { r[${JSON.stringify(k)}] = false; }`).join(' ') + ' return r; })()';
    let have = {};
    for (let i = 0; i < 30; i++) { have = await b.ev(expr); if (Object.values(have).every(Boolean)) break; await sleep(2000); }
    const miss = Object.keys(MODULES).filter((k) => !have[k]);
    rows.push(row('start.modules', !miss.length, `${Object.keys(MODULES).length - miss.length}/${Object.keys(MODULES).length} present`, 'all present',
      miss.length ? `Missing on window.berlinDrive after the load: ${miss.join(', ')} (the module failed to load or was renamed).` : '', (Date.now() - tm) / 1000));
  } else rows.push(row('start.modules', false, 'not loaded', 'all present', 'The game did not load.'));

  if (loaded && selected('start.menu', only)) rows.push(...await timed('start.menu', async () => {
    await b.ev('berlinDrive.menu.open()');
    const tp = await b.waitFor('berlinDrive.paused === true && berlinDrive.menu.isOpen === true', 60, 500);
    await b.ev('berlinDrive.menu.close()');
    const tr = await b.waitFor('berlinDrive.paused === false && berlinDrive.menu.isOpen === false', 60, 500);
    return row('start.menu', tp !== null && tr !== null, `paused ${tp !== null ? 'yes' : 'no'}, resumed ${tr !== null ? 'yes' : 'no'}`, 'pauses and resumes',
      tp === null ? 'berlinDrive.menu.open() did not pause the game within 60 s.' : tr === null ? 'Closing the menu did not end the pause.' : '');
  }));
  if (loaded && selected('start.map', only)) rows.push(...await timed('start.map', async () => {
    await b.ev('berlinDrive.minimap.setOverview(true)');
    const tp = await b.waitFor('berlinDrive.minimap.overview === true && berlinDrive.paused === true', 30, 500);
    await b.ev('berlinDrive.minimap.setOverview(false)');
    const tr = await b.waitFor('berlinDrive.minimap.overview === false && berlinDrive.paused === false', 30, 500);
    return row('start.map', tp !== null && tr !== null, `map ${tp !== null ? 'open + paused' : 'not paused'}, ${tr !== null ? 'closed' : 'stuck'}`, 'opens paused, closes',
      tp === null ? 'Opening the map did not show it paused.' : tr === null ? 'Closing the map did not end the pause.' : '');
  }));
  // errors + failed requests of the whole load (and the menu / map steps above)
  const errs = [...new Set(b.errors)];
  rows.push(row('start.errors', errs.length === 0, `${b.errors.length} errors`, '0 errors', errs.length ? 'Errors in the page: ' + errs.slice(0, 6).join(' // ') : ''));
  const failed = b.failed.filter((f) => !OPTIONAL_FAIL.some((re) => re.test(f.url)));
  rows.push(row('start.requests', failed.length === 0, `${failed.length} failed`, '0 (site.json optional)',
    failed.length ? 'Failed requests: ' + [...new Set(failed.map((f) => `${f.status} ${f.url.replace(/^https?:\/\/[^/]+/, '')}`))].slice(0, 8).join(', ') : ''));
  return { rows: rows.filter((r) => selected(r.name, only) || r.name === 'start.load'), loaded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  if (a.help) { console.log(HELP); process.exit(0); }
  if (a.list) { for (const n of SMOKE_NAMES) console.log(n); process.exit(0); }
  const b = new Browser(a);
  let ok = false;
  try {
    await b.start();
    const { rows } = await runSmoke(b, a);
    ok = printTable(rows, 'Layer 2: start-up');
  } finally { await b.close(); }
  process.exit(ok ? 0 : 1);
}

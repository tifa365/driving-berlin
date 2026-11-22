#!/usr/bin/env node
// The whole test suite in one run (tools/test.sh is the command to use):
//   layer 1 static checks (tools/check.mjs), then ONE headless Chrome for
//   layer 2 start-up (tools/smoke.mjs) and layer 3 drive + settings tests (tools/drive_tests.mjs).
// One table at the end; exit 0 = everything passed (known failures do not count), 1 = a failure.
// Needs the game served locally (python3 serve.py 8765) for layers 2 and 3.
import { Browser, parseArgs, HELP, selected, row, printTable } from './testlib.mjs';
import { runStatic, staticNames } from './check.mjs';
import { runSmoke, SMOKE_NAMES } from './smoke.mjs';
import { runDrive, driveNames } from './drive_tests.mjs';

const a = parseArgs();
if (a.help) { console.log(HELP); process.exit(0); }
const names = [...staticNames(a), ...SMOKE_NAMES, ...driveNames()];
if (a.list) { for (const n of names) console.log(n); process.exit(0); }
if (a.only.length && !names.some((n) => selected(n, a.only))) { console.error('no test matches --only ' + a.only.join(' ')); process.exit(2); }

const t0 = Date.now(), rows = [];
if (staticNames(a).some((n) => selected(n, a.only))) {
  console.log('layer 1: static checks …');
  rows.push(...await runStatic(a));
}
const wantBrowser = [...SMOKE_NAMES, ...driveNames()].some((n) => selected(n, a.only));
if (wantBrowser) {
  let up = false;
  try { up = (await fetch(a.url, { method: 'HEAD' })).ok; } catch { /* not served */ }
  if (!up) rows.push(row('start.load', false, 'no server', a.url, `Nothing answers at ${a.url}: start the local server (python3 serve.py 8765) or pass --url.`));
  else {
    const b = new Browser(a);
    try {
      await b.start();
      console.log('layer 2: loading the game in headless Chrome (1-3 minutes) …');
      const smokeOnly = a.only.length ? a.only : [];
      const { rows: sr, loaded } = await runSmoke(b, { url: a.url, loadTimeout: a.loadTimeout, only: smokeOnly });
      rows.push(...sr.filter((r) => !a.only.length || selected(r.name, a.only) || r.status === 'FAIL'));
      if (loaded && driveNames().some((n) => selected(n, a.only))) {
        console.log('layer 3: drive and settings tests …');
        rows.push(...await runDrive(b, a));
      }
    } catch (e) {
      rows.push(row('browser', false, 'crashed', '', 'The browser session failed: ' + String(e?.message || e)));
    } finally { await b.close(); }
  }
}
const ok = printTable(rows, 'Driving Berlin tests');
console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(ok ? 0 : 1);

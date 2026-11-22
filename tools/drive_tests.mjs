#!/usr/bin/env node
// Layer 3 of the test suite: drive tests in the loaded game, physics only. Every case uses
// berlinDrive.teleport / spot / roofs.enter and berlinDrive.steps(n, keys) + state(): physics
// steps without rendering (simulate() renders a frame, seconds each in software rendering).
// A case runs inside one page evaluation where it can, so the game's own frames do not mix in.
// Cases and their reasons: tools/drive_cases.json "drive"; positions come from the level files.
//   node tools/drive_tests.mjs [--url ...] [--only NAME] [--list]     (loads the game itself)
// (all layers in one browser session: tools/test.sh)
import fs from 'fs';
import path from 'path';
import { ROOT, Browser, parseArgs, HELP, selected, row, timed, printTable, sleep } from './testlib.mjs';

const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/drive_cases.json'), 'utf8'));
const D = CASES.drive;
const slugify = (s) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const f1 = (v) => (v == null || !isFinite(v) ? String(v) : (+v).toFixed(1));

// test names from the level files on disk (for --list / --only before anything loads)
export function driveNames() {
  const lv = path.join(ROOT, 'levels/mitte_all');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(lv, f), 'utf8')); } catch { return null; } };
  const n = ['settings.defaults', 'settings.sbahn-camera'];
  for (const s of read('spots.json')?.spots || []) n.push('drive.spot.' + s.slug);
  for (const b of D.bridges.names) for (const e of ['start', 'end']) for (const d of ['onto', 'off']) n.push(`drive.bridge.${slugify(b)}.${e}-${d}`);
  for (const e of read('sbahn.json')?.entrances || []) n.push('drive.sbahn.' + e.id.replace(/^sbahn-/, ''));
  for (const h of D.roof.headings) n.push(`drive.roof-fall.h${h.toFixed(2)}`);
  for (const b of D.border) n.push('drive.border.' + b.name);
  n.push('drive.memorial', 'drive.coast-down', 'drive.map-drive', 'settings.new-game', 'settings.reset-settings', 'settings.after-reload', 'drive.no-errors');
  return n;
}

// ---------- in-page helpers (installed once per page as window.__bdt) ----------
function pageHelpers() {
  const B = window.berlinDrive;
  const step = (sec, keys = []) => B.steps(Math.round(sec * 60), keys);
  const away = () => { const s = B.level.spawn; B.teleport(s.x, s.z, s.heading); step(0.1); };   // every mode off, a known place
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  window.__bdt = {
    away,
    base: () => `levels/${B.level.name}/`,
    spot(slug, sec, minM) {
      away(); B.spot(slug); step(0.15); const s0 = B.state();
      let maxd = 0, sink = null;
      for (let t = 0; t < sec; t += 0.5) { step(0.5, ['ArrowUp']); const s = B.state(); maxd = Math.max(maxd, dist(s, s0)); if (s.sinking && !sink) sink = s.sinkKind; }
      const s = B.state(), r = { moved: maxd, kmh: s.kmh, sink, x: s0.x, z: s0.z };
      away(); return r;
    },
    async bridges(names, back, sec) {
      const br = (await (await fetch(this.base() + 'bridges.json')).json()).bridges, out = [];
      for (const nm of names) {
        const b = br.find((x) => x.name === nm);
        if (!b) { out.push({ name: nm, missing: true }); continue; }
        const L = b.line, A = L[0], E = L[L.length - 1], len = Math.hypot(E[0] - A[0], E[1] - A[1]), ux = (E[0] - A[0]) / len, uz = (E[1] - A[1]) / len;
        for (const [end, sh, outw] of [['start', 0, -1], ['end', len, 1]]) for (const dir of ['onto', 'off']) {
          const from = dir === 'onto' ? sh + outw * back : sh - outw * back, sg = dir === 'onto' ? -outw : outw;
          const h = Math.atan2(ux * sg, -uz * sg), x = A[0] + ux * from, z = A[1] + uz * from;
          away(); B.teleport(x, z, h); step(0.15); step(sec, ['ArrowUp']);
          const s = B.state(), sa = (s.x - A[0]) * ux + (s.z - A[1]) * uz;
          out.push({ name: nm, end, dir, past: (sa - sh) * sg, driven: Math.hypot(s.x - x, s.z - z), kmh: s.kmh, sink: s.sinkKind, x, z });
        }
      }
      away(); return out;
    },
    async sbahn(maxS) {
      const sb = await (await fetch(this.base() + 'sbahn.json')).json(), out = [];
      for (const e of sb.entrances) {
        const a = e.approach; away(); B.teleport(a.x, a.z, a.h); step(0.15);
        let door = null, rails = null;
        for (let t = 0; t < maxS && rails === null; t += 0.5) { step(0.5, ['ArrowUp']); if (B.state().sinking && door === null) door = t + 0.5; if (B.sbahn.active) rails = t + 0.5; }
        out.push({ id: e.id.replace(/^sbahn-/, ''), name: e.name, door, rails, sink: B.state().sinkKind });
      }
      away(); return out;
    },
    async roof(route, h, maxS) {
      const R = (await (await fetch(this.base() + 'roofs_deck.json')).json()).routes.find((r) => r.id === route);
      if (!R) return { missing: true };
      const st = R.start; away(); B.roofs.enter(route, { x: st.x, z: st.z, h }); step(0.15);
      const on0 = B.roofs.active; let fall = null, end = null, kind = null;
      for (let t = 0; t < maxS; t += 0.5) {
        step(0.5, fall === null ? ['ArrowUp'] : []); const s = B.state();
        if (s.sinking) { if (fall === null) { fall = t + 0.5; kind = s.sinkKind; } } else if (fall !== null) { end = t + 0.5; break; }
      }
      const s = B.state(), r = { on0, fall, end, kind, roof: B.roofs.active, d: dist(s, st), heading: B.vehicle.getHeading(), startH: st.h };
      away(); return r;
    },
    border(road, startGap, sec) {
      const ex = B.level.extent, [x0, z0, x1, z1] = road, L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L;
      const gapOf = (p) => Math.min(p.x - ex.minX, ex.maxX - p.x, p.z - ex.minZ, ex.maxZ - p.z);
      // start on the road startGap m from the border it crosses, facing the border
      let lo = 0, hi = L; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (gapOf({ x: x0 + ux * m, z: z0 + uz * m }) > startGap) lo = m; else hi = m; }
      const sx = x0 + ux * lo, sz = z0 + uz * lo; away(); B.teleport(sx, sz, Math.atan2(ux, -uz)); step(0.15);
      let minGap = Infinity, turnAt = null;
      for (let t = 0; t < sec; t += 0.25) { step(0.25, ['ArrowUp']); const s = B.state(); minGap = Math.min(minGap, gapOf(s)); if (B.edge.turning && turnAt === null) turnAt = t + 0.25; }
      const r = { start: gapOf({ x: sx, z: sz }), minGap, turnAt, endGap: gapOf(B.state()), sink: B.state().sinkKind };
      away(); return r;
    },
    memorial(slug, maxS) {
      away(); B.spot(slug); step(0.15);
      const el = document.getElementById('respect'), before = !!el?.classList.contains('on');
      let at = null, kind = null;
      for (let t = 0; t < maxS && at === null; t += 0.25) { step(0.25, ['ArrowUp']); const s = B.state(); if (s.sinking) { at = t + 0.25; kind = s.sinkKind; } }
      const r = { before, at, kind, on: !!el?.classList.contains('on'), text: el?.textContent ?? null };
      for (let i = 0; i < 60 && B.state().sinking; i++) step(0.5);
      away(); return r;
    },
    coast(fromKmh) {
      const s = B.level.spawn; away(); B.teleport(s.x, s.z, s.heading); step(0.15);
      let t = 0; while (B.state().kmh < fromKmh && t < 20) { B.steps(1, ['ArrowUp']); t += 1 / 60; }
      let p = B.state(); const k0 = p.kmh; let tc = 0, d = 0;
      while (B.state().kmh > 0.5 && tc < 15) { B.steps(1, []); tc += 1 / 60; const q = B.state(); d += dist(q, p); p = q; }
      const r = { reach: t, k0, secs: tc, metres: d, sink: B.state().sinkKind };
      away(); return r;
    },
  };
  return true;
}

async function install(b) {
  await b.ev(`(${pageHelpers.toString()})()`);
}

// ---------- settings ----------
async function defaults(b, only) {
  const rows = [], d = D.defaults;
  if (selected('settings.defaults', only)) rows.push(...await timed('settings.defaults', async () => {
    const v = await b.ev(`(() => { const B = berlinDrive, $ = (i) => document.getElementById(i);
      return { camH: +$('camH').value, camD: +$('camD').value, cam: [B.cam.height, B.cam.dist], speed: B.speedLimit, speedSel: +$('speedSel').value,
               obstacles: B.collision, blinkers: B.blinkers, detail: $('detailSel')?.value ?? null }; })()`);
    const bad = [];
    if (v.camH !== d.camH || v.camD !== d.camD) bad.push(`street camera sliders ${v.camH} / ${v.camD}, expected ${d.camH} / ${d.camD}`);
    if (v.cam[0] !== d.camH || v.cam[1] !== d.camD) bad.push(`live camera ${v.cam[0]} / ${v.cam[1]}, expected ${d.camH} / ${d.camD}`);
    if (v.speed !== d.speed || v.speedSel !== d.speed) bad.push(`speed limit ${v.speed} (menu ${v.speedSel}), expected ${d.speed}`);
    if (v.obstacles !== d.obstacles) bad.push(`obstacles ${v.obstacles ? 'on' : 'off'}, expected ${d.obstacles ? 'on' : 'off'}`);
    if (v.blinkers !== d.blinkers) bad.push(`blinkers ${v.blinkers ? 'on' : 'off'}, expected ${d.blinkers ? 'on' : 'off'}`);
    if (v.detail !== d.detail) bad.push(`detail ${v.detail}, expected ${d.detail}`);
    return row('settings.defaults', !bad.length, `cam ${v.camH}/${v.camD}, ${v.speed} km/h, obst ${v.obstacles ? 'on' : 'off'}, blink ${v.blinkers ? 'on' : 'off'}, ${v.detail}`,
      `cam ${d.camH}/${d.camD}, ${d.speed} km/h, obst off, blink on, ${d.detail}`, bad.length ? 'On a fresh profile: ' + bad.join('; ') + '.' : '');
  }));
  if (selected('settings.sbahn-camera', only)) rows.push(...await timed('settings.sbahn-camera', async () => {
    // the sliders show the ACTIVE set: give the street set other values, go on the tracks, read the S-Bahn set
    await b.ev(`(() => { __bdt.away(); berlinDrive.setCam('height', 40); berlinDrive.setCam('dist', 75); return true; })()`);
    const station = JSON.parse(fs.readFileSync(path.join(ROOT, 'levels/mitte_all/sbahn.json'), 'utf8')).entrances[0].name;
    await b.ev(`berlinDrive.sbahn.enter(${JSON.stringify(station)}), true`);
    const t = await b.waitFor(`berlinDrive.sbahn.active && document.getElementById('camH').value !== '40'`, 90, 500);
    const v = await b.ev(`[+document.getElementById('camH').value, +document.getElementById('camD').value, berlinDrive.sbahn.active]`);
    await b.ev(`__bdt.away(), true`);
    await b.waitFor(`!berlinDrive.sbahn.active && document.getElementById('camH').value === '40'`, 90, 500);
    await b.ev(`(() => { berlinDrive.setCam('height', ${d.camH}); berlinDrive.setCam('dist', ${d.camD});
      for (const k of Object.keys(localStorage)) if (/^berlinDrive\\.cam7\\./.test(k)) localStorage.removeItem(k); return true; })()`);
    const ok = t !== null && v[0] === d.sbahn[0] && v[1] === d.sbahn[1];
    return row('settings.sbahn-camera', ok, v[2] ? `${v[0]} / ${v[1]}` : 'rails mode did not start', `${d.sbahn[0]} / ${d.sbahn[1]}`,
      ok ? '' : v[2] ? `The S-Bahn camera set starts at ${v[0]} / ${v[1]} on a fresh profile, expected ${d.sbahn[0]} / ${d.sbahn[1]}.` : 'berlinDrive.sbahn.enter() did not put the car on the tracks within 90 s.');
  }));
  return rows;
}

// newGame() / resetSettings(): storage is read in the same evaluation as the call (before the
// reload begins), then the test waits for the reloaded game.
async function storageTests(b, opts) {
  const rows = [], only = opts.only, P = D.progress_keys, SP = D.session_progress_keys;
  const keysJs = JSON.stringify({ P, SP, prog: D.test_progress, set: D.test_settings });
  const snap = `(() => { const o = { local: {}, session: {} }; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('berlinDrive.')) o.local[k] = localStorage.getItem(k); }
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k.startsWith('berlinDrive.')) o.session[k] = sessionStorage.getItem(k); } return o; })()`;
  const waitGame = (s) => b.waitFor('!window.__bdtMark && window.berlinDrive && berlinDrive.vehicle && berlinDrive.intro && berlinDrive.intro.open === false', s, 2000);
  const doNew = selected('settings.new-game', only), doReset = selected('settings.reset-settings', only) || selected('settings.after-reload', only);
  if (!doNew && !doReset) return rows;
  let reloadOk = true;
  if (doNew) rows.push(...await timed('settings.new-game', async () => {
    const r = await b.ev(`(() => { const K = ${keysJs}, B = berlinDrive, p = B.state();
      for (const [k, v] of Object.entries(K.prog)) localStorage.setItem(k, v);
      localStorage.setItem('berlinDrive.pos', JSON.stringify({ type: 'pos', level: B.level.name, x: p.x, z: p.z, heading: 0, t: Date.now() }));
      sessionStorage.setItem('berlinDrive.resume', JSON.stringify({ level: B.level.name, kind: 'car', x: p.x, z: p.z, h: 0 }));
      for (const [k, v] of Object.entries(K.set)) localStorage.setItem(k, v);
      window.__bdtMark = 1; B.newGame(); return ${snap}; })()`);
    const left = [...P.filter((k) => k in r.local), ...SP.filter((k) => k in r.session)];
    const lost = Object.entries(D.test_settings).filter(([k, v]) => r.local[k] !== v).map(([k]) => k);
    const t = await waitGame(opts.loadTimeout);
    if (t === null) reloadOk = false;
    let applied = null;
    if (t !== null) { await install(b); applied = await b.ev('({ speed: berlinDrive.speedLimit, blink: berlinDrive.blinkers })'); }
    const keptLive = applied && applied.speed === +D.test_settings['berlinDrive.speedLimit'] && applied.blink === (D.test_settings['berlinDrive.blinkers'] === '1');
    const ok = !left.length && !lost.length && t !== null && keptLive;
    return row('settings.new-game', ok, `${left.length} progress left, ${lost.length} settings lost`, '0 left, 0 lost, reload ok',
      ok ? '' : [left.length ? `newGame() left progress keys: ${left.join(', ')}.` : '', lost.length ? `newGame() removed or changed setting keys: ${lost.join(', ')}.` : '',
        t === null ? 'The game did not load again after newGame().' : !keptLive ? `After the reload the kept settings are not in effect (speed ${applied?.speed}, blinkers ${applied?.blink}).` : ''].filter(Boolean).join(' '));
  }));
  if (doReset && reloadOk) {
    let snapR = null, t2 = null;
    rows.push(...await timed('settings.reset-settings', async () => {
      if (!doNew) await b.ev(`(() => { const K = ${keysJs}; for (const [k, v] of Object.entries(K.set)) localStorage.setItem(k, v); return true; })()`);
      snapR = await b.ev(`(() => { const K = ${keysJs}, B = berlinDrive, p = B.state();
        for (const [k, v] of Object.entries(K.prog)) localStorage.setItem(k, v);
        localStorage.setItem('berlinDrive.pos', JSON.stringify({ type: 'pos', level: B.level.name, x: p.x, z: p.z, heading: 0, t: Date.now() }));
        window.__bdtMark = 1; B.resetSettings(); return ${snap}; })()`);
      const settingsLeft = Object.keys(snapR.local).filter((k) => !P.includes(k) && k !== 'berlinDrive.cmd');
      const progLost = P.filter((k) => !(k in snapR.local));
      const ok = !settingsLeft.length && !progLost.length;
      return row('settings.reset-settings', ok, `${settingsLeft.length} settings left, ${progLost.length} progress lost`, '0 left, 0 lost',
        ok ? '' : [settingsLeft.length ? `resetSettings() kept setting keys: ${settingsLeft.join(', ')}.` : '', progLost.length ? `resetSettings() removed progress keys: ${progLost.join(', ')}.` : ''].join(' '));
    }));
    rows.push(...await timed('settings.after-reload', async () => {
      t2 = await waitGame(opts.loadTimeout);
      if (t2 === null) return row('settings.after-reload', false, 'no reload', 'menu on Einstellungen', 'The game did not load again after resetSettings().');
      const tm = await b.waitFor('berlinDrive.menu.isOpen && berlinDrive.menu.page === "settings"', 30, 1000);
      const v = await b.ev(`(() => { const B = berlinDrive, $ = (i) => document.getElementById(i); return { page: B.menu.isOpen ? B.menu.page : null, camH: +$('camH').value, camD: +$('camD').value, speed: B.speedLimit, blink: B.blinkers, detail: $('detailSel')?.value }; })()`);
      await b.ev('berlinDrive.menu.close(), true'); await b.waitFor('berlinDrive.paused === false', 30, 500);
      await install(b);
      const d = D.defaults, bad = [];
      if (tm === null) bad.push(`the menu is ${v.page ? 'on ' + v.page : 'closed'}, expected open on Einstellungen`);
      if (v.camH !== d.camH || v.camD !== d.camD) bad.push(`camera ${v.camH} / ${v.camD}`);
      if (v.speed !== d.speed) bad.push(`speed ${v.speed}`);
      if (v.blink !== d.blinkers) bad.push(`blinkers ${v.blink}`);
      if (v.detail !== d.detail) bad.push(`detail ${v.detail}`);
      return row('settings.after-reload', !bad.length, `menu ${v.page ?? 'closed'}, cam ${v.camH}/${v.camD}, ${v.speed} km/h`, `settings page, defaults`,
        bad.length ? 'After resetSettings() and the reload: ' + bad.join('; ') + '.' : '');
    }));
  } else if (doReset) rows.push(row('settings.reset-settings', false, 'not run', '', 'Skipped: the game did not come back after newGame().'));
  return rows;
}

// ---------- map driving (real key path for the mode) ----------
async function mapDrive(b) {
  const st = () => b.ev('(() => { const s = berlinDrive.state(); return { x: s.x, z: s.z, kmh: s.kmh, paused: berlinDrive.paused, md: berlinDrive.mapDrive, ov: !!berlinDrive.minimap.overview }; })()');
  await b.ev(`(() => { __bdt.away(); berlinDrive.spot(${JSON.stringify(D.map_drive.spot)}); berlinDrive.steps(10, []); return true; })()`);
  const p0 = await st();
  await b.press('n', 'KeyN', 78);
  const tOpen = await b.waitFor('berlinDrive.minimap.overview === true && berlinDrive.paused === true', 30, 500);
  await b.key('keyDown', 'w', 'KeyW', 87);
  const tDrive = await b.waitFor('berlinDrive.mapDrive === true && berlinDrive.paused === false', 30, 500);
  await b.ev('berlinDrive.steps(120, ["ArrowUp"]), true');   // 2 s of driving while on the map (frames are too slow for real-time distance)
  await b.key('keyUp', 'w', 'KeyW', 87);
  await b.ev('berlinDrive.steps(360, []), true'); await sleep(1000);   // roll to a stop
  const p1 = await st();
  await b.press('Escape', 'Escape', 27);
  const tClose = await b.waitFor('berlinDrive.minimap.overview === false && berlinDrive.mapDrive === false', 30, 500);
  const p2 = await st();
  await b.ev('__bdt.away(), true');
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z), jump = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const bad = [];
  if (tOpen === null) bad.push('N did not open the map paused');
  if (tDrive === null) bad.push('W on the map did not start map driving (mapDrive true, pause lifted)');
  if (moved < 3) bad.push(`the car moved only ${f1(moved)} m while map driving`);
  if (tClose === null) bad.push('Escape did not close the map and end map driving');
  if (jump > 0.05) bad.push(`closing the map moved the car by ${jump.toFixed(2)} m (it must stay where it was)`);
  return row('drive.map-drive', !bad.length, `moved ${f1(moved)} m, ${jump.toFixed(3)} m on close`, 'opens, drives, 0 m on close', bad.join('; ') + (bad.length ? '.' : ''));
}

export async function runDrive(b, opts) {
  const only = opts.only || [], rows = [], add = async (name, fn) => { if (selected(name, only)) rows.push(...await timed(name, fn)); };
  const errs0 = b.errors.length;
  await install(b);
  rows.push(...await defaults(b, only));   // first: the fresh profile (before anything is saved)

  const S = D.spots, slugs = await b.ev('berlinDrive.spots().map((s) => s.slug)');
  for (const slug of slugs) await add('drive.spot.' + slug, async () => {
    const ex = S.expect[slug], min = ex?.min_m ?? S.min_m;
    const r = await b.ev(`__bdt.spot(${JSON.stringify(slug)}, ${S.seconds}, ${min})`);
    return row('drive.spot.' + slug, r.moved >= min, `${f1(r.moved)} m${r.sink ? ' (' + r.sink + ')' : ''}`, `>= ${min} m in ${S.seconds} s`,
      r.moved >= min ? (ex ? 'Exception: ' + ex.why : '') : `From the spot's start pose (${f1(r.x)}, ${f1(r.z)}) the car moved only ${f1(r.moved)} m in ${S.seconds} s of full throttle: it is stuck at the start.`);
  });

  const BR = D.bridges, brNames = driveNames().filter((n) => n.startsWith('drive.bridge.'));
  if (brNames.some((n) => selected(n, only))) {
    const t0 = Date.now(), res = await b.ev(`__bdt.bridges(${JSON.stringify(BR.names)}, ${BR.back_m}, ${BR.seconds})`), secs = (Date.now() - t0) / 1000 / Math.max(1, res.length);
    for (const r of res) {
      if (r.missing) { rows.push(row(`drive.bridge.${slugify(r.name)}`, false, 'missing', 'in bridges.json', `No bridge named ${r.name} in bridges.json.`, secs)); continue; }
      const name = `drive.bridge.${slugify(r.name)}.${r.end}-${r.dir}`;
      if (!selected(name, only)) continue;
      const ok = r.past >= BR.min_past_m;
      rows.push(row(name, ok, `${f1(r.past)} m past the head`, `>= ${BR.min_past_m} m`, ok ? '' :
        `${r.name}, ${r.end} head, driving ${r.dir === 'onto' ? 'onto the deck' : 'off the deck'} from ${BR.back_m} m before it: after ${BR.seconds} s of throttle the car is ${r.past < 0 ? f1(-r.past) + ' m short of' : 'only ' + f1(r.past) + ' m past'} the head (${f1(r.kmh)} km/h${r.sink ? ', ' + r.sink : ''}). A rail or wall closes the head.`, secs));
    }
  }

  if (driveNames().some((n) => n.startsWith('drive.sbahn.') && selected(n, only))) {
    const t0 = Date.now(), res = await b.ev(`__bdt.sbahn(${D.sbahn.max_s})`), secs = (Date.now() - t0) / 1000 / Math.max(1, res.length);
    for (const r of res) {
      const name = 'drive.sbahn.' + r.id; if (!selected(name, only)) continue;
      rows.push(row(name, r.rails !== null, r.rails !== null ? `rails after ${r.rails} s` : r.door !== null ? `door at ${r.door} s, no rails` : 'no door', `rails within ${D.sbahn.max_s} s`,
        r.rails !== null ? '' : `Driving straight from the ${r.name} approach pose (sbahn.json) did not put the car on the tracks within ${D.sbahn.max_s} s (${r.door !== null ? 'a sequence started (' + r.sink + ') but rails mode never came on' : 'the door was never reached'}).`, secs));
    }
  }

  for (const h of D.roof.headings) await add(`drive.roof-fall.h${h.toFixed(2)}`, async () => {
    const R = D.roof, r = await b.ev(`__bdt.roof(${JSON.stringify(R.route)}, ${h}, ${R.max_s})`);
    if (r.missing) return row(`drive.roof-fall.h${h.toFixed(2)}`, false, 'no route', R.route, `roofs_deck.json has no route ${R.route}.`);
    const ok = r.on0 && r.fall !== null && r.end !== null && r.roof && r.d <= R.tol_m;
    return row(`drive.roof-fall.h${h.toFixed(2)}`, ok, r.end !== null ? `${f1(r.d)} m from start, roof ${r.roof ? 'on' : 'off'}` : r.fall === null ? 'no fall' : 'sequence did not end',
      `<= ${R.tol_m} m, roof on`, ok ? '' : !r.on0 ? 'roofs.enter() did not switch roof mode on.' : r.fall === null ? `Driving off the roof (heading ${h}) never started a fall within ${R.max_s} s.`
        : r.end === null ? `The fall (${r.kind}) did not end within ${R.max_s} s.` : `After the fall the car is ${f1(r.d)} m from the route's start pose with roof mode ${r.roof ? 'on' : 'off'}; expected back at the start, on the roof.`);
  });

  const BRu = D.border_rule;
  for (const c of D.border) await add('drive.border.' + c.name, async () => {
    const r = await b.ev(`__bdt.border(${JSON.stringify(c.road)}, ${c.start_gap_m}, ${BRu.seconds})`);
    const ok = r.minGap >= BRu.min_gap_m && r.turnAt !== null && r.turnAt <= BRu.turn_within_s && r.endGap >= BRu.end_gap_m;
    return row('drive.border.' + c.name, ok, `closest ${f1(r.minGap)} m, turn ${r.turnAt ?? '-'} s, end ${f1(r.endGap)} m`, `>= ${BRu.min_gap_m} m, turn <= ${BRu.turn_within_s} s, end >= ${BRu.end_gap_m} m`,
      ok ? '' : [r.minGap < BRu.min_gap_m ? `the car centre came within ${f1(r.minGap)} m of the ${c.name} border (${r.minGap < 0 ? 'it left the level' : 'too close'})` : '',
        r.turnAt === null ? `no turn-around within ${BRu.seconds} s of pushing at the border` : r.turnAt > BRu.turn_within_s ? `the turn-around came only after ${r.turnAt} s` : '',
        r.endGap < BRu.end_gap_m ? `at the end the car is only ${f1(r.endGap)} m inside (not driven back into the level)` : ''].filter(Boolean).join('; ') + '.');
  });

  await add('drive.memorial', async () => {
    const M = D.memorial, r = await b.ev(`__bdt.memorial(${JSON.stringify(M.spot)}, ${M.max_s})`);
    const ok = !r.before && r.kind === 'nodrive' && r.on && r.text === M.text;
    return row('drive.memorial', ok, r.at === null ? 'zone not reached' : `${r.kind} at ${r.at} s, line ${r.on ? 'shown' : 'not shown'}`, `nodrive, "${M.text}" shown`,
      ok ? '' : r.at === null ? `From the ${M.spot} spot the car never entered the no-drive zone within ${M.max_s} s.` : r.kind !== 'nodrive' ? `The car stopped by "${r.kind}", not the no-drive zone.`
        : `Entering the memorial zone did not show "${M.text}" (element #respect ${r.text === null ? 'missing' : 'text "' + r.text + '", on ' + r.on}).`);
  });

  await add('drive.coast-down', async () => {
    const C = D.coast, r = await b.ev(`__bdt.coast(${C.from_kmh})`);
    const okS = Math.abs(r.secs - C.s) <= C.s * C.tol, okM = Math.abs(r.metres - C.m) <= C.m * C.tol, ok = r.k0 >= C.from_kmh && okS && okM && !r.sink;
    return row('drive.coast-down', ok, `${r.secs.toFixed(2)} s, ${f1(r.metres)} m`, `${C.s} s, ${C.m} m ±${C.tol * 100}%`,
      ok ? '' : r.k0 < C.from_kmh ? `The car did not reach ${C.from_kmh} km/h from the spawn (${f1(r.k0)} km/h after ${f1(r.reach)} s).`
        : `Releasing all keys at ${C.from_kmh} km/h stopped the car in ${r.secs.toFixed(2)} s / ${f1(r.metres)} m; expected about ${C.s} s / ${C.m} m (±${C.tol * 100} %)${r.sink ? ', and it ended in a ' + r.sink + ' sequence' : ''}.`);
  });

  await add('drive.map-drive', () => mapDrive(b));
  rows.push(...await storageTests(b, opts));   // last: these reload the page

  if (selected('drive.no-errors', only)) {
    const errs = [...new Set(b.errors.slice(errs0))];
    rows.push(row('drive.no-errors', !errs.length, `${errs.length} errors`, '0 errors', errs.length ? 'Errors in the page during the drive and settings tests (reloads included): ' + errs.slice(0, 6).join(' // ') : ''));
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  if (a.help) { console.log(HELP); process.exit(0); }
  if (a.list) { for (const n of driveNames()) console.log(n); process.exit(0); }
  const b = new Browser(a);
  let ok = false;
  try {
    await b.start();
    await b.navigate(a.url);
    const t = await b.waitFor('window.berlinDrive && berlinDrive.intro && berlinDrive.intro.open === false', a.loadTimeout, 2000);
    if (t === null) { printTable([row('start.load', false, 'not loaded', '', 'The game did not load.')]); process.exit(1); }
    ok = printTable(await runDrive(b, a), 'Layer 3: drive tests');
  } finally { await b.close(); }
  process.exit(ok ? 0 : 1);
}

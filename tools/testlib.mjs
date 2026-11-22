// Shared helpers of the test suite (tools/test.sh): the result table, command-line flags,
// and a headless Chrome driven over the DevTools protocol with Node's own fetch + WebSocket
// (no packages). Used by tools/check.mjs, tools/smoke.mjs, tools/drive_tests.mjs, tools/test.mjs.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');   // racing/
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- flags: --only <name> (repeatable, substring or * pattern), --list, --slow, --url, --port, --chrome ----------
export function parseArgs(argv = process.argv.slice(2)) {
  const a = { only: [], list: false, slow: false, url: 'http://127.0.0.1:8765/', port: 9361,
              chrome: '/usr/bin/google-chrome', keep: false, loadTimeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(k + ' needs a value'); return argv[++i]; };
    if (k === '--only') a.only.push(v());
    else if (k === '--list') a.list = true;
    else if (k === '--slow') a.slow = true;
    else if (k === '--url') a.url = v();
    else if (k === '--port') a.port = +v();
    else if (k === '--chrome') a.chrome = v();
    else if (k === '--load-timeout') a.loadTimeout = +v();
    else if (k === '--keep-profile') a.keep = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error('unknown flag ' + k);
  }
  return a;
}
export const HELP = `usage: tools/test.sh [--only NAME]... [--list] [--slow] [--url URL] [--port N] [--load-timeout S]
  --only NAME   run only tests whose name contains NAME (or matches it with * wildcards); repeatable
  --list        list the test names and exit
  --slow        add the slow static checks (build_spots.py --dry-run: needs ../berlin_mesh_2025_wab)
  --url URL     the game to load (default http://127.0.0.1:8765/ = python3 serve.py 8765)
  --port N      DevTools port of the headless Chrome (default 9361)
  --load-timeout S  seconds to wait for the loading screen to end (default 300)`;

export function selected(name, only) {
  if (!only || !only.length) return true;
  return only.some((o) => (o.includes('*')
    ? new RegExp('^' + o.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name)
    : name.includes(o)));
}

// ---------- results ----------
// row: { name, status: 'PASS' | 'FAIL' | 'KNOWN' | 'SKIP', measured, expected, detail, secs }
// KNOWN = a known failure (listed with its reason in tools/drive_cases.json): shown, does not fail the run;
// if a known failure starts to pass, the row says so (PASS, "known failure no longer happens").
export function row(name, ok, measured, expected, detail = '', secs = 0) {
  return { name, status: ok ? 'PASS' : 'FAIL', measured: String(measured ?? ''), expected: String(expected ?? ''), detail, secs };
}
export function known(r, reason) {
  if (r.status === 'FAIL') return { ...r, status: 'KNOWN', detail: (r.detail ? r.detail + ' ' : '') + 'Known failure: ' + reason };
  if (r.status === 'PASS') return { ...r, detail: (r.detail ? r.detail + ' ' : '') + 'Listed as a known failure, but it passes now: remove it from the known list.' };
  return r;
}
export async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const rows = Array.isArray(r) ? r : [r];
    for (const x of rows) if (!x.secs) x.secs = (Date.now() - t0) / 1000 / rows.length;
    return rows;
  } catch (e) {
    return [{ name, status: 'FAIL', measured: 'error', expected: '', detail: 'The test itself crashed: ' + (e?.stack || e).toString().split('\n').slice(0, 3).join(' | '), secs: (Date.now() - t0) / 1000 }];
  }
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export function printTable(rows, title = null) {
  const W = { name: Math.min(56, Math.max(4, ...rows.map((r) => r.name.length))), m: 30, e: 30 };
  const line = (a, b, c, d, e) => `${a.padEnd(W.name)}  ${b.padEnd(6)}  ${c.padEnd(W.m)}  ${d.padEnd(W.e)}  ${e.padStart(7)}`;
  if (title) console.log('\n' + title);
  console.log(line('Test', 'Result', 'Measured', 'Expected', 'Time'));
  console.log('-'.repeat(W.name + W.m + W.e + 25));
  for (const r of rows) console.log(line(cut(r.name, W.name), r.status, cut(r.measured, W.m), cut(r.expected, W.e), r.secs.toFixed(1) + ' s'));
  const bad = rows.filter((r) => r.status === 'FAIL'), kn = rows.filter((r) => r.status === 'KNOWN'), note = rows.filter((r) => r.status === 'PASS' && r.detail.startsWith('Listed as a known'));
  if (bad.length) { console.log('\nWhat went wrong:'); for (const r of bad) console.log(`  ${r.name}: ${r.detail || `expected ${r.expected}, measured ${r.measured}`}`); }
  if (kn.length) { console.log('\nKnown failures (do not fail the run):'); for (const r of kn) console.log(`  ${r.name}: ${r.detail}`); }
  if (note.length) { console.log('\nNotes:'); for (const r of note) console.log(`  ${r.name}: ${r.detail}`); }
  const n = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('KNOWN')} known failures, ${n('SKIP')} skipped`);
  return bad.length === 0;
}

// ---------- headless Chrome over the DevTools protocol ----------
// Software rendering (no GPU): frames can take seconds, so tests never wait for frames; they
// wait for conditions with generous timeouts and step physics with berlinDrive.simulate/steps.
export class Browser {
  constructor({ chrome = '/usr/bin/google-chrome', port = 9361, keep = false } = {}) {
    this.chrome = chrome; this.port = port; this.keep = keep;
    this.proc = null; this.ws = null; this.id = 0; this.pend = new Map();
    this.capture = false; this.errors = []; this.failed = []; this.reqs = new Map(); this.listeners = [];
  }
  async start() {
    this.prof = fs.mkdtempSync(path.join(os.tmpdir(), 'berlin-drive-test-'));   // fresh profile: empty localStorage
    // own process group (detached): kill(-pid) ends Chrome and all its helpers, nothing else
    this.proc = spawn(this.chrome, ['--headless=new', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.prof}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1400,800', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', 'about:blank'],
      { detached: true, stdio: 'ignore' });
    this.pid = this.proc.pid;
    const kill = () => this.kill();
    this._onExit = kill; process.on('exit', kill);
    this._onSig = () => { this.kill(); process.exit(130); };
    process.on('SIGINT', this._onSig); process.on('SIGTERM', this._onSig);
    let tabs = null;
    for (let i = 0; i < 150 && !tabs; i++) {
      try { const t = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json(); if (t.some((x) => x.type === 'page')) tabs = t; } catch { /* not up yet */ }
      if (!tabs) await sleep(200);
    }
    if (!tabs) throw new Error(`Chrome did not open its DevTools port ${this.port} within 30 s`);
    this.ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => this._msg(JSON.parse(m.data));
    await this.send('Runtime.enable'); await this.send('Log.enable'); await this.send('Page.enable'); await this.send('Network.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    return this;
  }
  _msg(d) {
    if (d.id && this.pend.has(d.id)) { const p = this.pend.get(d.id); this.pend.delete(d.id); clearTimeout(p.t); p.res(d); return; }
    const p = d.params;
    for (const l of this.listeners) l(d);
    if (!this.capture) return;   // Runtime.enable replays old messages: only count what follows our own navigation
    if (d.method === 'Runtime.exceptionThrown') {
      const x = p.exceptionDetails;
      this.errors.push('uncaught ' + (x.exception?.description || x.text || '').split('\n').slice(0, 3).join(' | ') + (x.url ? ` (${x.url.split('/').pop()}:${x.lineNumber + 1})` : ''));
    } else if (d.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      this.errors.push('console.error ' + p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    } else if (d.method === 'Log.entryAdded' && p.entry.level === 'error' && !/Failed to load resource/.test(p.entry.text)) {
      this.errors.push('log ' + p.entry.text.slice(0, 300) + (p.entry.url ? ' ' + p.entry.url : ''));
    } else if (d.method === 'Network.requestWillBeSent') {
      this.reqs.set(p.requestId, p.request.url);
    } else if (d.method === 'Network.responseReceived' && p.response.status >= 400) {
      this.failed.push({ status: p.response.status, url: p.response.url });
    } else if (d.method === 'Network.loadingFailed' && !p.canceled) {
      this.failed.push({ status: p.errorText, url: this.reqs.get(p.requestId) || '?' });
    }
  }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const t = setTimeout(() => { this.pend.delete(i); rej(new Error(`DevTools call ${method} gave no answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.pend.set(i, { res, t });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  // evaluate an expression in the page; returns its value (JSON-able) or throws with the page's error
  async ev(expression, timeoutMs = 60000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.error) throw new Error('DevTools: ' + r.error.message);
    const x = r.result?.exceptionDetails;
    if (x) throw new Error('page error: ' + (x.exception?.description || x.text).split('\n')[0]);
    return r.result?.result?.value;
  }
  async navigate(url) {
    this.errors.length = 0; this.failed.length = 0;
    this.capture = true;
    await this.send('Page.navigate', { url });
  }
  // wait until expr is truthy; returns seconds waited, or null on timeout
  async waitFor(expr, timeoutS, everyMs = 1000) {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < timeoutS) {
      try { if (await this.ev(expr, 30000)) return (Date.now() - t0) / 1000; } catch { /* page between documents */ }
      await sleep(everyMs);
    }
    return null;
  }
  async key(type, key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  async press(key, code, vk) { await this.key('keyDown', key, code, vk); await this.key('keyUp', key, code, vk); }
  kill() {
    if (this.pid && !this.killed) {
      this.killed = true;
      try { this.ws?.close(); } catch { /* closed */ }
      try { process.kill(-this.pid, 'SIGTERM'); } catch { /* gone */ }
      const pid = this.pid;
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
    }
    if (this.prof && !this.keep) { try { fs.rmSync(this.prof, { recursive: true, force: true }); } catch { /* chrome still writing */ } }
    if (this._onExit) { process.off('exit', this._onExit); process.off('SIGINT', this._onSig); process.off('SIGTERM', this._onSig); this._onExit = null; }
  }
  async close() {
    this.kill();
    // wait for the process group to be gone, then remove the profile (Chrome writes into it on exit)
    for (let i = 0; i < 30; i++) { try { process.kill(-this.pid, 0); await sleep(200); } catch { break; } }
    if (this.prof && !this.keep) fs.rmSync(this.prof, { recursive: true, force: true });
  }
}

#!/usr/bin/env node
// Layer 1 of the test suite: static checks, no browser, about half a minute.
//   node tools/check.mjs [--only NAME] [--list] [--slow]      (or all layers: tools/test.sh)
// - syntax of js/*.js, tools/*.mjs and the inline scripts of index.html / map.html (node --check)
// - every relative import (static and dynamic) in the page and js/*.js resolves to a file that
//   exports the imported names (text-level parse, nothing is executed)
// - every Python build script compiles (in memory, nothing written)
// - the car bench against tools/vehicle_ref.json
// - the build scripts' read-only data checks: bridge heads (audit_roads.py --heads-only), S-Bahn
//   doors (build_sbahn.py --check-doors), the publish staging + its guard (tools/publish_site.py
//   into a temp folder, removed after); --slow adds build_spots.py --dry-run (needs the mesh mirror
//   ../berlin_mesh_2025_wab and a few minutes)
// - privacy: no /home/<user>/ paths, scratch paths or mail addresses in the files git would commit
// Known failures and accepted findings: tools/drive_cases.json "static".
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT, parseArgs, HELP, selected, row, known, timed, printTable } from './testlib.mjs';

const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/drive_cases.json'), 'utf8'));
const KNOWN = CASES.static;

function run(cmd, args, { cwd = ROOT, timeout = 300000, env = process.env } = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); err += `\n(killed after ${timeout / 1000} s)`; }, timeout);
    p.on('close', (code) => { clearTimeout(t); res({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e) }); });
  });
}
const lastLines = (s, n = 4) => s.trim().split('\n').slice(-n).join(' | ');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'berlin-drive-check-'));
const jsFiles = () => fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).sort();

// inline <script> blocks of a page, padded with blank lines so line numbers match the page
function inlineScripts(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8'), out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (/\bsrc=/.test(attrs) || /importmap/.test(attrs) || !m[2].trim()) continue;
    const line = src.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    out.push({ module: /type\s*=\s*["']module["']/.test(attrs), code: '\n'.repeat(line) + m[2], line: line + 1 });
  }
  return out;
}

// ---------- syntax ----------
async function syntax() {
  const dir = tmpDir(), bad = [];
  try {
    const jobs = [];
    for (const f of jsFiles()) { const t = path.join(dir, f.replace(/\.js$/, '.mjs')); fs.copyFileSync(path.join(ROOT, 'js', f), t); jobs.push(['js/' + f, t]); }
    for (const f of fs.readdirSync(path.join(ROOT, 'tools')).filter((x) => x.endsWith('.mjs'))) jobs.push(['tools/' + f, path.join(ROOT, 'tools', f)]);
    for (const page of ['index.html', 'map.html']) {
      if (!fs.existsSync(path.join(ROOT, page))) continue;
      inlineScripts(page).forEach((s, i) => { const t = path.join(dir, `${page}.${i}.${s.module ? 'mjs' : 'cjs'}`); fs.writeFileSync(t, s.code); jobs.push([`${page} <script> at line ${s.line}`, t]); });
    }
    for (const [label, file] of jobs) {
      const r = await run(process.execPath, ['--check', file]);
      if (r.code !== 0) bad.push(`${label}: ${(r.err.split('\n').find((l) => /Error/.test(l)) || lastLines(r.err, 2)).trim()} (${(r.err.match(/:(\d+)\n/) || [])[1] ? 'line ' + r.err.match(/:(\d+)\n/)[1] : ''})`);
    }
    return row('static.syntax', !bad.length, `${jobs.length - bad.length}/${jobs.length} files parse`, `${jobs.length}/${jobs.length}`,
      bad.length ? 'Syntax errors: ' + bad.join('; ') : '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- imports: files exist, named imports are exported ----------
function stripComments(src) {   // block comments and whole-line // comments (enough for import parsing)
  return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '');
}
function exportsOf(src) {
  const s = stripComments(src), names = new Set();
  for (const m of s.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const p of m[1].split(',')) { const n = p.split(':').pop().trim().split('=')[0].trim(); if (n) names.add(n); }
  for (const m of s.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  if (/^[ \t]*export\s+default\b/m.test(s)) names.add('default');
  // let/const lists: export const A = 1, B = 2
  for (const m of s.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+([^;\n]*)/gm)) for (const p of m[1].split(/,(?![^([{]*[)\]}])/)) { const n = p.trim().match(/^([A-Za-z_$][\w$]*)\s*=/); if (n) names.add(n[1]); }
  return names;
}
function importsOf(src) {   // [{ spec, names: [..] | null (namespace / side effect), line, dynamic }]
  const s = stripComments(src), out = [];
  const lineAt = (i) => s.slice(0, i).split('\n').length;
  for (const m of s.matchAll(/^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1], names = [];
    const br = clause.match(/\{([\s\S]*)\}/);
    if (br) for (const p of br[1].split(',')) { const n = p.trim().split(/\s+as\s+/)[0].trim(); if (n) names.push(n); }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').split(',')[0].trim();
    if (def) names.push('default');
    out.push({ spec: m[2], names, line: lineAt(m.index) });
  }
  for (const m of s.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) out.push({ spec: m[1], names: [], line: lineAt(m.index) });
  for (const m of s.matchAll(/^[ \t]*export\s+(?:\*|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/gm)) {
    out.push({ spec: m[2], names: m[1] ? m[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : [], line: lineAt(m.index) });
  }
  for (const m of s.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const names = [], before = s.slice(Math.max(0, m.index - 200), m.index), after = s.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const de = before.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s*$/);
    if (de) for (const p of de[1].split(',')) { const n = p.split(':')[0].trim(); if (n) names.push(n); }
    const th = after.match(/^\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/);
    if (th) {
      const body = after.slice(th[0].length).split(/\.catch\(|\n\S/)[0];
      for (const u of body.matchAll(new RegExp('\\b' + th[1] + '\\.([A-Za-z_$][\\w$]*)', 'g'))) names.push(u[1]);
    }
    out.push({ spec: m[1], names: [...new Set(names)], line: lineAt(m.index), dynamic: true });
  }
  return out;
}
async function imports() {
  const sources = [['index.html', inlineScripts('index.html').filter((s) => s.module).map((s) => s.code).join('\n'), ROOT]];
  for (const f of jsFiles()) sources.push(['js/' + f, fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), path.join(ROOT, 'js')]);
  const cache = new Map(), bad = [];
  let n = 0, names = 0;
  for (const [label, src, dir] of sources) {
    for (const im of importsOf(src)) {
      if (!im.spec.startsWith('.') && !im.spec.startsWith('/')) continue;   // three, three/addons/...: from the CDN import map
      n++;
      const file = path.resolve(dir, im.spec), rel = path.relative(ROOT, file);
      if (!fs.existsSync(file)) { bad.push(`${label}:${im.line} imports ${im.spec}, but ${rel} does not exist`); continue; }
      if (!cache.has(file)) cache.set(file, exportsOf(fs.readFileSync(file, 'utf8')));
      const ex = cache.get(file);
      for (const nm of im.names) { names++; if (!ex.has(nm)) bad.push(`${label}:${im.line} imports '${nm}' from ${rel}, which does not export it`); }
    }
  }
  return row('static.imports', !bad.length, `${n} imports, ${names} names, ${bad.length} broken`, 'all resolve', bad.join('; '));
}

// ---------- python: every script compiles (compile() in memory, no __pycache__ written) ----------
async function python() {
  const files = [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.py')), ...fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => f.endsWith('.py')).map((f) => 'tools/' + f)];
  const code = 'import sys\nbad=[]\nfor f in sys.argv[1:]:\n  try: compile(open(f,encoding="utf-8").read(), f, "exec")\n  except SyntaxError as e: bad.append(f"{f}:{e.lineno}: {e.msg}")\nprint("\\n".join(bad))\nsys.exit(1 if bad else 0)';
  const r = await run('python3', ['-c', code, ...files]);
  const bad = r.out.trim() ? r.out.trim().split('\n') : [];
  return row('static.python', r.code === 0, `${files.length - bad.length}/${files.length} compile`, `${files.length}/${files.length}`, bad.length ? 'Python syntax errors: ' + bad.join('; ') : (r.code ? lastLines(r.err) : ''));
}

// ---------- car bench ----------
async function bench() {
  const r = await run(process.execPath, ['tools/vehicle_bench.mjs', '--compare', 'tools/vehicle_ref.json']);
  const total = r.out.match(/(\d+)\/(\d+) within tolerance/);
  if (!total) return row('static.car-bench', false, 'no result', 'bench table', 'The bench did not print its summary: ' + lastLines(r.err || r.out));
  const fails = [...r.out.matchAll(/^(\S+)\s+.*\bFAIL\s*$/gm)].map((m) => m[1]);
  const kn = new Set(Object.keys(KNOWN.bench_known_fail || {}));
  const fresh = fails.filter((f) => !kn.has(f)), gone = [...kn].filter((f) => !fails.includes(f));
  const out = [row('static.car-bench', fresh.length === 0, `${total[1]}/${total[2]} in tolerance`, `all but ${kn.size} known`,
    fresh.length ? `The car bench is outside its reference tolerance for: ${fresh.join(', ')} (node tools/vehicle_bench.mjs --compare tools/vehicle_ref.json shows old vs new).` : '')];
  if (kn.size) {
    const still = fails.filter((f) => kn.has(f));
    const k = row('static.car-bench.known', still.length === 0, `${still.length} of ${kn.size} still off`, 'in tolerance',
      `Values outside tolerance: ${still.join(', ')}.` + (gone.length ? ` In tolerance again: ${gone.join(', ')}.` : ''));
    out.push(known(k, KNOWN.bench_reason));
  }
  return out;
}

// ---------- bridge heads (audit_roads.py --heads-only) ----------
async function heads() {
  const r = await run('python3', ['audit_roads.py', '--heads-only'], { timeout: 180000 });
  const m = r.out.match(/bridge heads: (\d+) checked, (\d+) closed/);
  if (r.code !== 0 || !m) {
    if (/No module named 'osm_semantic'/.test(r.err)) return { ...row('static.bridge-heads', true, 'skipped', ''), status: 'SKIP', detail: 'needs ../osm_semantic.py (the parent repo)' };
    return row('static.bridge-heads', false, `exit ${r.code}`, 'exit 0', 'audit_roads.py --heads-only failed: ' + lastLines(r.err || r.out));
  }
  const closed = [...r.out.matchAll(/^\s{2}(.{34}) (start|end )\s+x\s+(\S+) z\s+(\S+)\s+obstacles off: CLOSED/gm)].map((x) => `${x[1].trim()} ${x[2].trim()}`);
  const ok = new Set(KNOWN.closed_heads_accepted.map((h) => h.head));
  const fresh = closed.filter((c) => !ok.has(c));
  return row('static.bridge-heads', fresh.length === 0, `${m[2]} of ${m[1]} closed, ${fresh.length} new`, `only the ${ok.size} accepted closed`,
    fresh.length ? `A car cannot pass these bridge heads (rail or wall across the head, obstacles off): ${fresh.join(', ')}. Accepted ones are listed in tools/drive_cases.json static.closed_heads_accepted.` : '');
}

// ---------- S-Bahn doors on their stations (build_sbahn.py --check-doors) ----------
async function doors() {
  const env = { ...process.env }; delete env.OSM_PBF;   // read-only check of sbahn.json; never the OSM extract
  const r = await run('python3', ['build_sbahn.py', '--check-doors'], { env });
  const n = JSON.parse(fs.readFileSync(path.join(ROOT, 'levels/mitte_all/sbahn.json'), 'utf8')).entrances.length;
  const okn = (r.out.match(/-> OK/g) || []).length;
  return row('static.sbahn-doors', r.code === 0 && okn === n, `${okn}/${n} doors on their station`, `${n}/${n}, exit 0`,
    r.code === 0 && okn === n ? '' : 'build_sbahn.py --check-doors: ' + lastLines(r.err || r.out));
}

// ---------- publish staging + its guard (tools/publish_site.py into a temp folder) ----------
async function publish() {
  const dir = tmpDir();
  try {
    const r = await run('python3', ['tools/publish_site.py', '--out', path.join(dir, 'site'), '--tiles', 'http://127.0.0.1:1/tiles/']);
    const st = r.out.match(/staged (\d+) files, ([\d.]+) MB/);
    return row('static.publish-staging', r.code === 0 && /guard ok/.test(r.out), st ? `${st[1]} files, ${st[2]} MB, guard ok` : `exit ${r.code}`, 'exit 0, guard ok',
      r.code === 0 ? '' : 'tools/publish_site.py failed (a missing level file or private text in the staged site): ' + lastLines(r.err || r.out, 6));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- privacy over what git would commit ----------
async function privacy() {
  const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (r.code !== 0) return row('static.privacy', false, 'git failed', '', lastLines(r.err));
  const files = r.out.split('\0').filter(Boolean).filter((f) => /\.(html|js|mjs|json|md|py|sh|txt|css|svg)$/i.test(f) && fs.existsSync(path.join(ROOT, f)));
  const pats = [[/\/home\/[A-Za-z0-9._-]+\//g, 'home path'], [/\/tmp\/claude-[^\s'"]*/g, 'scratch path'],
                [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'mail address']];
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [re, what] of pats) {
      for (const m of s.matchAll(re)) hits.push(`${f}:${s.slice(0, m.index).split('\n').length} ${what} '${m[0].slice(0, 40)}'`);
    }
  }
  return row('static.privacy', !hits.length, `${files.length} files, ${hits.length} hits`, '0 hits',
    hits.length ? 'Private-looking text in files git would commit: ' + hits.slice(0, 12).join('; ') : '');
}

// ---------- slow: spot start poses (build_spots.py --dry-run) ----------
async function spotsSlow() {
  if (!fs.existsSync(path.join(ROOT, '..', 'berlin_mesh_2025_wab'))) return { ...row('static.spots-dry-run', true, 'skipped', ''), status: 'SKIP', detail: 'needs ../berlin_mesh_2025_wab' };
  const r = await run('python3', ['build_spots.py', '--dry-run'], { timeout: 1200000 });
  return row('static.spots-dry-run', r.code === 0, `exit ${r.code}`, 'exit 0', r.code === 0 ? '' : 'build_spots.py --dry-run: a spot fails its check: ' + lastLines(r.out + r.err, 6));
}

export const STATIC_TESTS = [
  ['static.syntax', syntax], ['static.imports', imports], ['static.python', python], ['static.privacy', privacy],
  ['static.car-bench', bench], ['static.bridge-heads', heads], ['static.sbahn-doors', doors], ['static.publish-staging', publish],
];
export const SLOW_TESTS = [['static.spots-dry-run', spotsSlow]];

export function staticNames({ slow = false } = {}) {
  const n = STATIC_TESTS.map(([k]) => k);
  if (Object.keys(KNOWN.bench_known_fail || {}).length) n.splice(n.indexOf('static.car-bench') + 1, 0, 'static.car-bench.known');
  return slow ? [...n, ...SLOW_TESTS.map(([k]) => k)] : n;
}

// two at a time (2-core machine): the bridge-head audit (~25 s) runs beside the rest
export async function runStatic({ only = [], slow = false } = {}) {
  const tests = [...STATIC_TESTS, ...(slow ? SLOW_TESTS : [])].filter(([k]) => selected(k, only) || (k === 'static.car-bench' && selected('static.car-bench.known', only)));
  const order = [...tests].sort((a, b) => (b[0] === 'static.bridge-heads') - (a[0] === 'static.bridge-heads'));
  const res = new Map(); let i = 0;
  const worker = async () => { while (i < order.length) { const [k, fn] = order[i++]; res.set(k, await timed(k, fn)); } };
  await Promise.all([worker(), worker()]);
  return tests.flatMap(([k]) => res.get(k));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  if (a.help) { console.log(HELP); process.exit(0); }
  if (a.list) { for (const n of staticNames(a)) console.log(n); process.exit(0); }
  const t0 = Date.now();
  const rows = await runStatic(a);
  const ok = printTable(rows, 'Layer 1: static checks');
  console.log(`layer 1 took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(ok ? 0 : 1);
}

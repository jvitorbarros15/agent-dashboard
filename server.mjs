#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costOfHours, usd } from './pricing.mjs';
import { watchSessions, forecastPlan } from './watch.mjs';
import { buildReport, spendByProject } from './vizier.mjs';
import { desktopNotify } from './notify.mjs';
import { absorbHistory, profileState } from './profile.mjs';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : process.env['AGENT_PARTY_' + name.toUpperCase()] || def; };
if (flag('help') || argv.includes('-h')) {
  console.log(`agentparty v${VERSION}: a pixel-art dashboard for your AI coding agents

Usage: npx agent-party-dashboard [options]

  --port <n>       Port to listen on (default 4300)
  --host <addr>    Address to bind (default 127.0.0.1)
  --no-open        Don't open the browser
  --disable <ids>  Comma-separated adapters to skip, e.g. cursor,aider
  --version        Print the version
  --test-notify    Show a test desktop notification and exit

Env: DASHBOARD_ORIGINS lets a hosted copy of the UI read this API.
     AGENT_PARTY_AIDER_DIRS lists folders to search for Aider repos.
Custom adapters: drop .mjs files into ~/.agent-party/adapters/`);
  process.exit(0);
}
if (flag('version') || argv.includes('-v')) { console.log(VERSION); process.exit(0); }
if (flag('test-notify')) { desktopNotify('Agent Party', 'Desktop notifications work. Budget alerts will show up like this.'); await new Promise(r => setTimeout(r, 4000)); process.exit(0); }
const PORT = +opt('port', 4300), HOST = opt('host', '127.0.0.1');
const DISABLED = new Set(opt('disable', '').split(',').map(s => s.trim()).filter(Boolean));

// ---------- adapters: built-in ones plus any in ~/.agent-party/adapters ----------
const ADAPTER_DIRS = [path.join(HERE, 'adapters'), path.join(HOME, '.agent-party', 'adapters')];
const adapters = [];
for (const dir of ADAPTER_DIRS) {
  let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort(); } catch { continue; }
  for (const f of files) {
    try {
      const a = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!a?.id || typeof a.sessions !== 'function') { console.warn(`skipping ${f}: needs a default export with id and sessions()`); continue; }
      if (DISABLED.has(a.id)) continue;
      const i = adapters.findIndex(x => x.id === a.id);
      i >= 0 ? (adapters[i] = a) : adapters.push(a);
    } catch (e) { console.warn(`skipping adapter ${f}: ${e.message}`); }
  }
}

// ---------- Claude plan limits (written by ~/.claude/statusline-command.sh, cached by mtime) ----------
const STATUS_LINE_JSON = path.join(HOME, '.claude', 'statusline-last.json');
let planCache = { mtime: 0, plan: null };
function claudePlan() {
  let st; try { st = fs.statSync(STATUS_LINE_JSON); } catch { return null; }
  if (st.mtimeMs === planCache.mtime) return planCache.plan;
  let plan = null;
  try {
    const rl = JSON.parse(fs.readFileSync(STATUS_LINE_JSON, 'utf8')).rate_limits;
    const win = w => (w && typeof w.used_percentage === 'number' ? { pct: w.used_percentage, resetsAt: w.resets_at } : null);
    const fiveHour = win(rl?.five_hour), weekly = win(rl?.seven_day);
    if (fiveHour || weekly) plan = { fiveHour, weekly, updatedAt: st.mtimeMs };
  } catch {}
  planCache = { mtime: st.mtimeMs, plan };
  return plan;
}

// ---------- Machine ----------
let prevCpu = os.cpus(), cpuPct = 0;
function sampleCpu() {
  const cur = os.cpus(); let idle = 0, tot = 0;
  cur.forEach((c, i) => { const p = prevCpu[i]; for (const k in c.times) tot += c.times[k] - p.times[k]; idle += c.times.idle - p.times.idle; });
  prevCpu = cur; cpuPct = tot ? Math.round(100 * (1 - idle / tot)) : 0;
}
// GPUs: NVIDIA everywhere via nvidia-smi, Apple Silicon via ioreg, AMD/Intel on Linux via sysfs,
// anything else on Windows via performance counters. Force one with AGENT_PARTY_GPU=nvidia|apple|sysfs|ps|none.
let gpus = [], gpuMode = process.env.AGENT_PARTY_GPU || 'auto', gpuBusy = false;
const run = (cmd, args, t = 4000) => new Promise(r => execFile(cmd, args, { timeout: t, windowsHide: true }, (e, so) => r(e ? null : String(so))));
const readNum = f => { try { const v = parseFloat(fs.readFileSync(f, 'utf8')); return isNaN(v) ? null : v; } catch { return null; } };
const PS_GPU = `$u=(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -EA SilentlyContinue).CounterSamples|Measure-Object CookedValue -Sum|%{$_.Sum};
$m=(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -EA SilentlyContinue).CounterSamples|Measure-Object CookedValue -Sum|%{$_.Sum};
$n=(Get-CimInstance Win32_VideoController|Sort-Object AdapterRAM -Descending|Select -First 1).Name;
$q=(Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -EA SilentlyContinue).'HardwareInformation.qwMemorySize'|Measure-Object -Maximum|%{$_.Maximum};
@{u=$u;m=$m;n=$n;q=$q}|ConvertTo-Json -Compress`;
const GPU_READERS = {
  async nvidia() {
    const o = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
    if (!o) return null;
    return o.trim().split('\n').filter(Boolean).map(l => { const [name, util, mu, mt, temp] = l.split(',').map(x => x.trim()); return { name, util: +util, vramUsed: +mu, vramTotal: +mt, temp: isNaN(+temp) ? null : +temp }; });
  },
  async apple() {
    const o = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
    const util = o && /"Device Utilization %"\s*=\s*(\d+)/.exec(o);
    if (!util) return null;
    const mem = /"In use system memory"\s*=\s*(\d+)/.exec(o), chip = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']) || '').trim();
    return [{ name: (chip || 'Apple') + ' GPU', util: +util[1], vramUsed: mem ? Math.round(+mem[1] / 2 ** 20) : 0, vramTotal: Math.round(os.totalmem() / 2 ** 20), temp: null, shared: true }];
  },
  async sysfs() {
    const out = [];
    let cards = []; try { cards = fs.readdirSync('/sys/class/drm').filter(c => /^card\d+$/.test(c)); } catch {}
    for (const c of cards) {
      const d = `/sys/class/drm/${c}/device`, util = readNum(`${d}/gpu_busy_percent`);
      if (util == null) continue;
      let temp = null; try { for (const h of fs.readdirSync(`${d}/hwmon`)) { const t = readNum(`${d}/hwmon/${h}/temp1_input`); if (t != null) { temp = Math.round(t / 1000); break; } } } catch {}
      let name = ''; try { name = fs.readFileSync(`${d}/product_name`, 'utf8').trim(); } catch {}
      const vendor = (() => { try { return fs.readFileSync(`${d}/vendor`, 'utf8').trim(); } catch { return ''; } })();
      out.push({ name: name || (vendor === '0x1002' ? 'AMD GPU' : vendor === '0x8086' ? 'Intel GPU' : 'GPU'), util,
        vramUsed: Math.round((readNum(`${d}/mem_info_vram_used`) || 0) / 2 ** 20), vramTotal: Math.round((readNum(`${d}/mem_info_vram_total`) || 0) / 2 ** 20), temp });
    }
    return out.length ? out : null;
  },
  async ps() {
    const o = await run('powershell', ['-NoProfile', '-Command', PS_GPU], 8000);
    let j; try { j = JSON.parse(o); } catch { return null; }
    if (j?.u == null) return null;
    return [{ name: j.n || 'GPU', util: Math.min(100, Math.round(j.u)), vramUsed: Math.round((j.m || 0) / 2 ** 20), vramTotal: Math.round((j.q || 0) / 2 ** 20), temp: null }];
  },
};
const GPU_ORDER = { win32: ['nvidia', 'ps'], darwin: ['apple', 'nvidia'], linux: ['nvidia', 'sysfs'] }[process.platform] || ['nvidia'];
async function sampleGpu() {
  if (gpuBusy || gpuMode === 'none') return;
  gpuBusy = true;
  try {
    if (gpuMode !== 'auto') { gpus = (await GPU_READERS[gpuMode]?.()) || []; return; }
    for (const m of GPU_ORDER) { const g = await GPU_READERS[m](); if (g) { gpus = g; gpuMode = m; return; } }
    gpus = []; gpuMode = 'none';
  } finally { gpuBusy = false; }
}
let ollama = { up: false, models: [] };
async function sampleOllama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    ollama = { up: true, models: (j.models || []).map(m => ({ name: m.name, size: m.size, vram: m.size_vram })) };
  } catch { ollama = { up: false, models: [] }; }
}
async function sampleMachine() { sampleCpu(); await Promise.all([sampleGpu(), sampleOllama()]); }
setInterval(sampleMachine, 2000); sampleMachine();

// ---------- State ----------
let sessions = [], notes = [], costToday = 0, spark = [], collisions = [], treasury = [], prof = { levels: {}, achievements: [] };
async function refresh() {
  const all = [], nt = [];
  await Promise.all(adapters.map(async a => {
    try { all.push(...await a.sessions()); }
    catch (e) { nt.push(`${a.label || a.id}: not tracked (${String(e.message).slice(0, 60)})`); }
  }));
  const midH = Math.floor(new Date().setHours(0, 0, 0, 0) / 36e5);
  let today = 0;
  const nowH = Math.floor(Date.now() / 36e5), sp = new Array(24).fill(0);
  for (const s of all) {
    if (!s.hours) continue;
    for (const [key, v] of Object.entries(s.hours)) { const i = +key.slice(0, key.indexOf('|')) - (nowH - 23); if (i >= 0 && i < 24) sp[i] += v[0]; }
    const c = costOfHours(s.hours), t = costOfHours(s.hours, midH);
    s.cost = c.usd; s.costUnpriced = c.unpriced; s.todayCost = t.usd; if (t.usd) today += t.usd;
    s.hourSpan = new Set(Object.keys(s.hours).map(k => k.slice(0, k.indexOf('|')))).size;
    delete s.hours;
  }
  collisions = watchSessions(all);
  treasury = spendByProject(all);
  sessions = all; notes = nt; costToday = today; spark = sp;
  checkBudgets();
  prof = profileState(all);
}

// Treasury: budget limits live here so alerts fire as desktop notifications even with no dashboard tab open.
const BUDGET_FILE = path.join(HOME, '.agent-party', 'budgets.json');
const budgets = (() => { let b = {}; try { b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch {} return { daily: b.daily > 0 ? b.daily : null, projects: b.projects || {}, fired: b.fired || {} }; })();
const saveBudgets = () => { try { fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true }); fs.writeFileSync(BUDGET_FILE, JSON.stringify(budgets, null, 1)); } catch (e) { console.warn('budgets:', e.message); } };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function checkBudgets() {
  const day = localDay();
  for (const k of Object.keys(budgets.fired)) if (k !== day) delete budgets.fired[k];
  const fired = budgets.fired[day] ||= [], hits = [];
  if (budgets.daily > 0) hits.push({ key: 'daily', name: 'All projects', spend: costToday, limit: budgets.daily });
  for (const p of treasury) if (budgets.projects[p.key] > 0) hits.push({ key: p.key, name: p.name, spend: p.usd, limit: budgets.projects[p.key] });
  let changed = false;
  for (const h of hits) for (const th of [1, 0.8]) {
    if (h.spend < h.limit * th) continue;
    const k = h.key + '@' + th; if (fired.includes(k)) break;
    fired.push(k); changed = true;
    desktopNotify(th === 1 ? 'Agent Party: budget reached' : 'Agent Party: 80% of budget', `${h.name} spent $${h.spend.toFixed(2)} of its $${h.limit} limit today`);
    break;
  }
  if (changed) saveBudgets();
}
setInterval(refresh, 5000);

// Black holes: big sessions abandoned for 30+ days. Old files never change, so this is a slow background scan.
const HOLE_MIN_OUT = +(process.env.AGENT_PARTY_BLACKHOLE_MIN_OUT || 20000);
let archive = [];
async function refreshArchive() {
  const all = [];
  for (const a of adapters) {
    if (typeof a.archive !== 'function') continue;
    try { all.push(...await a.archive()); } catch (e) { console.warn(`${a.id} archive: ${e.message}`); }
    await new Promise(r => setImmediate(r));
  }
  archive = all.filter(s => s.tokOut >= HOLE_MIN_OUT || (s.mass || 0) >= 8 << 20)
    .sort((a, b) => b.tokOut - a.tokOut).slice(0, 12).map(({ hours, ...s }) => ({ ...s, cost: costOfHours(hours).usd, status: 'abandoned', archived: true, parent: null }));
}
setInterval(refreshArchive, 15 * 60e3);

// Usage history: hourly buckets for 30 days, plus totals per model and per project.
const pause = () => new Promise(r => setImmediate(r));
const reports = new Map();
let history = { ready: false }, historyBusy = null;
async function buildHistory(slow) {
  const minH = Math.floor(Date.now() / 36e5) - 30 * 24, rows = new Map(), models = [], projects = [], mi = new Map(), pi = new Map();
  const idx = (map, list, key, make) => { if (!map.has(key)) { map.set(key, list.length); list.push(make()); } return map.get(key); };
  for (const a of adapters) {
    if (typeof a.history !== 'function') continue;
    let entries = []; try { entries = await a.history(slow ? pause : null); } catch (e) { console.warn(`${a.id} history: ${e.message}`); }
    for (const e of entries) for (const [key, v] of Object.entries(e.hours || {})) {
      const i = key.indexOf('|'), h = +key.slice(0, i), model = key.slice(i + 1);
      if (h < minH || !(v[0] || v[1] || v[2] || v[3])) continue;
      const m = idx(mi, models, model, () => model), p = idx(pi, projects, a.id + '|' + e.project, () => ({ project: e.project, source: a.id }));
      const k = h + ':' + m + ':' + p, r = rows.get(k) || [h * 36e5, m, p, 0, 0, 0, 0];
      for (let n = 0; n < 4; n++) r[3 + n] += v[n];
      rows.set(k, r);
    }
  }
  // one row per hour, model and project: [hourMs, modelIndex, projectIndex, out, in, cacheRead, cacheWrite, usd or -1 when unpriced]
  const out = [...rows.values()].sort((a, b) => a[0] - b[0]).map(r => { const c = usd(models[r[1]], r.slice(3, 7)); r.push(c == null ? -1 : c); return r; });
  return { ready: true, at: Date.now(), models, projects, rows: out };
}
function refreshHistory(slow) {
  historyBusy ||= buildHistory(slow).then(h => { history = h; absorbHistory(h); prof = profileState(sessions); }).catch(e => console.warn('history:', e.message)).finally(() => { historyBusy = null; });
  return historyBusy;
}

// opt-in: lets a hosted copy of the dashboard read this local API (?api=http://127.0.0.1:4300). Never '*' — session data is private.
const ORIGINS = new Set((process.env.DASHBOARD_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));
const cors = (req) => ORIGINS.has(req.headers.origin) ? {
  'access-control-allow-origin': req.headers.origin, 'vary': 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true',
} : {};
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
  const u = new URL(req.url, 'http://x'), url = u.pathname;
  if (url === '/api/state') {
    const body = JSON.stringify({
      now: Date.now(), version: VERSION, sessions, archive, notes, collisions, treasury, budgets: { daily: budgets.daily, projects: budgets.projects }, profile: prof, claudePlan: claudePlan(), planForecast: forecastPlan(claudePlan()),
      sources: adapters.map(a => ({ id: a.id, label: a.label || a.id, resume: a.resume || '' })),
      todayTokens: sessions.reduce((a, s) => a + (s.today || 0), 0), costToday, spark,
      machine: { cpu: cpuPct, ramUsed: os.totalmem() - os.freemem(), ramTotal: os.totalmem(), gpu: gpus[0] || null, gpus, ollama },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) }); return res.end(body);
  }
  if (url === '/api/budgets' && req.method === 'POST') {
    const o = req.headers.origin;
    if (o && o !== `http://${req.headers.host}` && !ORIGINS.has(o)) { res.writeHead(403); return res.end(); }
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    return req.on('end', () => {
      try {
        const x = JSON.parse(b), num = v => (+v > 0 && isFinite(+v) ? +v : null), projects = {};
        for (const [k, v] of Object.entries(x.projects || {})) if (k.length < 500 && num(v)) projects[k] = num(v);
        budgets.daily = num(x.daily); budgets.projects = projects; saveBudgets(); checkBudgets();
        res.writeHead(204, cors(req));
      } catch { res.writeHead(400, cors(req)); }
      res.end();
    });
  }
  if (url === '/api/report') {
    const day = u.searchParams.get('day') || '', hit = reports.get(day);
    const send = r => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) }); res.end(JSON.stringify(r)); };
    if (hit && Date.now() - hit.at < 60e3) return send(hit.r);
    return buildReport(adapters, day, pause).then(r => { reports.set(day, { at: Date.now(), r }); send(r); })
      .catch(e => { res.writeHead(500, cors(req)); res.end(e.message); });
  }
  if (url === '/api/timeline') {
    const a = adapters.find(x => x.id === u.searchParams.get('source'));
    let ev = null; try { ev = a?.timeline?.(u.searchParams.get('id')) ?? null; } catch (e) { console.warn('timeline:', e.message); }
    res.writeHead(ev ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) });
    return res.end(JSON.stringify(ev ? { events: ev } : { error: a?.timeline ? 'Session not found' : 'This tool has no timeline yet' }));
  }
  if (url === '/api/profile') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) });
    return res.end(JSON.stringify(prof));
  }
  if (url === '/api/history') {
    const send = () => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) }); res.end(JSON.stringify(history)); };
    if (history.ready && Date.now() - history.at > 60e3) return refreshHistory(false).then(send);
    return send();
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
  }
  res.writeHead(404); res.end();
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch {}
}

await refresh();
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: npx agent-party-dashboard --port ${PORT + 1}` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  console.log(`\n  ⚔  Agent Party v${VERSION} is up at ${url}\n  Tracking: ${adapters.map(a => a.label || a.id).join(', ')}\n`);
  if (!flag('no-open')) openBrowser(url);
  setTimeout(refreshArchive, 1500);
  setTimeout(() => refreshHistory(true), 3000);
  setInterval(() => refreshHistory(true), 10 * 60e3);
});

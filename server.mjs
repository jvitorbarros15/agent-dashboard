#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

Env: DASHBOARD_ORIGINS lets a hosted copy of the UI read this API.
     AGENT_PARTY_AIDER_DIRS lists folders to search for Aider repos.
Custom adapters: drop .mjs files into ~/.agent-party/adapters/`);
  process.exit(0);
}
if (flag('version') || argv.includes('-v')) { console.log(VERSION); process.exit(0); }
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
let gpu = null, gpuMode = 'nvidia';
const run = (cmd, args, t = 4000) => new Promise(r => execFile(cmd, args, { timeout: t, windowsHide: true }, (e, so) => r(e ? null : String(so))));
const PS_GPU = "(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Sum | Select -Expand Sum";
async function sampleGpu() {
  if (gpuMode === 'nvidia') {
    const o = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
    if (o) { const [name, util, mu, mt, temp] = o.trim().split('\n')[0].split(',').map(s => s.trim()); gpu = { name, util: +util, vramUsed: +mu, vramTotal: +mt, temp: +temp }; return; }
    gpuMode = process.platform === 'win32' ? 'ps' : 'none';
  }
  if (gpuMode === 'ps') {
    const o = await run('powershell', ['-NoProfile', '-Command', PS_GPU], 8000);
    if (o && !isNaN(parseFloat(o))) { gpu = { name: 'GPU', util: Math.min(100, Math.round(parseFloat(o))), vramUsed: 0, vramTotal: 0, temp: null }; return; }
  }
  gpu = null;
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
let sessions = [], notes = [];
async function refresh() {
  const all = [], nt = [];
  await Promise.all(adapters.map(async a => {
    try { all.push(...await a.sessions()); }
    catch (e) { nt.push(`${a.label || a.id}: not tracked (${String(e.message).slice(0, 60)})`); }
  }));
  sessions = all; notes = nt;
}
setInterval(refresh, 5000);

// opt-in: lets a hosted copy of the dashboard read this local API (?api=http://127.0.0.1:4300). Never '*' — session data is private.
const ORIGINS = new Set((process.env.DASHBOARD_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));
const cors = (req) => ORIGINS.has(req.headers.origin) ? {
  'access-control-allow-origin': req.headers.origin, 'vary': 'Origin', 'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true',
} : {};
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
  const url = new URL(req.url, 'http://x').pathname;
  if (url === '/api/state') {
    const body = JSON.stringify({
      now: Date.now(), version: VERSION, sessions, notes, claudePlan: claudePlan(),
      sources: adapters.map(a => ({ id: a.id, label: a.label || a.id, resume: a.resume || '' })),
      todayTokens: sessions.reduce((a, s) => a + (s.today || 0), 0),
      machine: { cpu: cpuPct, ramUsed: os.totalmem() - os.freemem(), ramTotal: os.totalmem(), gpu, ollama },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) }); return res.end(body);
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
});

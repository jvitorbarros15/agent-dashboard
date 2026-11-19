import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const OC_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 3600e3;
const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const status = (ms) => { const a = Date.now() - ms; return a < 120e3 ? 'active' : a < 1800e3 ? 'idle' : 'sleeping'; };

// ---------- Claude Code sessions (incremental, cached by file offset) ----------
const cache = new Map();
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  return '';
}

function ingest(st, line, mid) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'ai-title' && o.aiTitle) st.title = o.aiTitle;
  else if (o.type === 'user' && !st.prompt && !o.isMeta && o.message) {
    const t = textOf(o.message.content).trim();
    if (t && !t.startsWith('<')) st.prompt = t;
  } else if (o.type === 'assistant' && o.message?.usage) {
    const m = o.message, u = m.usage;
    const inn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const out = u.output_tokens || 0;
    const ts = Date.parse(o.timestamp) || 0;
    if (m.model && m.model !== '<synthetic>') st.model = m.model;
    // streamed blocks repeat the same message id: replace, don't add
    if (st.lastId && st.lastId === m.id) { st.out += out - st.lastOut; st.freshIn += (u.input_tokens || 0) - st.lastFresh; if (ts >= mid) st.today += out - st.lastOut; }
    else { st.out += out; st.freshIn += u.input_tokens || 0; if (ts >= mid) st.today += out; }
    st.lastId = m.id; st.lastOut = out; st.lastFresh = u.input_tokens || 0;
    st.ctx = inn;
    const c = Array.isArray(m.content) ? m.content : [];
    const tool = [...c].reverse().find(b => b.type === 'tool_use');
    const txt = [...c].reverse().find(b => b.type === 'text' && b.text?.trim());
    if (tool) st.activity = 'Tool: ' + tool.name;
    else if (txt) st.activity = txt.text;
  }
}

const claudeState = () => ({ offset: 0, out: 0, freshIn: 0, today: 0, ctx: 0, model: '', prompt: '', title: '', activity: '', lastId: '', lastOut: 0, lastFresh: 0 });
function readFile(file, size, ing, mk) {
  let st = cache.get(file);
  if (!st || size < st.offset) {
    st = mk();
    cache.set(file, st);
  }
  if (size === st.offset) return st;
  const mid = midnight();
  const fd = fs.openSync(file, 'r');
  try {
    const CH = 8 << 20;
    let pos = st.offset, carry = Buffer.alloc(0);
    while (pos < size) {
      const len = Math.min(CH, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const all = Buffer.concat([carry, buf]);
      const nl = all.lastIndexOf(10);
      if (nl < 0) { carry = all; continue; }
      for (const l of all.subarray(0, nl).toString('utf8').split('\n')) if (l) ing(st, l, mid);
      carry = all.subarray(nl + 1);
      st.offset = pos - carry.length;
    }
  } finally { fs.closeSync(fd); }
  return st;
}

function claudeSessions() {
  const out = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  const now = Date.now();
  for (const p of projs) {
    const dir = path.join(PROJECTS, p.name);
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const files = [];
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ f: path.join(dir, e.name), sid: e.name.slice(0, -6), sub: false });
      else if (e.isDirectory()) {
        const sd = path.join(dir, e.name, 'subagents');
        try { for (const s of fs.readdirSync(sd)) if (s.endsWith('.jsonl')) files.push({ f: path.join(sd, s), sid: e.name, sub: true, aid: s.slice(0, -6) }); } catch {}
      }
      for (const { f, sid, sub, aid } of files) {
        let s; try { s = fs.statSync(f); } catch { continue; }
        if (now - s.mtimeMs > DAY) continue;
        const st = readFile(f, s.size, ingest, claudeState);
        let desc = '';
        if (sub) { try { desc = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || ''; } catch {} }
        const model = st.model || '';
        out.push({
          id: sub ? aid : sid, parent: sub ? sid : null, source: 'claude',
          project: p.name.replace(/^[a-zA-Z]--?/, '').replace(/-/g, '/'),
          name: trunc(sub ? (desc || st.prompt) : (st.title || st.prompt || '(untitled)'), 60),
          prompt: trunc(st.prompt, 400),
          model, status: status(s.mtimeMs), mtime: s.mtimeMs,
          activity: trunc(st.activity || '...', 80),
          tokOut: st.out, tokIn: st.freshIn, ctx: st.ctx,
          ctxMax: /\[1m\]$/.test(model) || st.ctx > 2e5 ? 1e6 : 2e5, today: st.today,
        });
      }
    }
  }
  return out;
}

// ---------- Codex CLI rollouts (~/.codex/sessions, same incremental cache; subagents link via parent_thread_id) ----------
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const CODEX_KEEP = /"(session_meta|turn_context|token_count|function_call|custom_tool_call|message)"/;
const codexState = () => ({ offset: 0, id: '', parent: null, prompt: '', activity: '', model: '', out: 0, freshIn: 0, today: 0, ctx: 0, ctxMax: 0 });
const partsOf = (c, type) => (Array.isArray(c) ? c.filter(b => b.type === type).map(b => b.text).join(' ') : '').trim();

function ingestCodex(st, line, mid) {
  if (!CODEX_KEEP.test(line)) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const p = o.payload || {};
  if (o.type === 'session_meta') {
    st.id = p.id || '';
    if (p.parent_thread_id && p.parent_thread_id !== p.id) st.parent = p.parent_thread_id;
  } else if (o.type === 'turn_context') {
    if (p.model) st.model = p.model;
  } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
    const t = p.info.total_token_usage || {}, l = p.info.last_token_usage || {};
    st.out = t.output_tokens || 0;
    st.freshIn = (t.input_tokens || 0) - (t.cached_input_tokens || 0);
    st.ctx = l.input_tokens || 0;
    st.ctxMax = p.info.model_context_window || 0;
    if ((Date.parse(o.timestamp) || 0) >= mid) st.today += l.output_tokens || 0;
  } else if (o.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') st.activity = 'Tool: ' + p.name;
    else if (p.type === 'message' && p.role === 'user') {
      const t = partsOf(p.content, 'input_text');
      if (t && !st.prompt && !t.startsWith('<')) st.prompt = t;
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = partsOf(p.content, 'output_text');
      if (t) st.activity = t;
    }
  }
}

function codexFiles(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) codexFiles(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function codexSessions() {
  const out = [], now = Date.now();
  for (const f of codexFiles(CODEX_DIR)) {
    let s; try { s = fs.statSync(f); } catch { continue; }
    if (now - s.mtimeMs > DAY) continue;
    const st = readFile(f, s.size, ingestCodex, codexState);
    if (!st.id) continue;
    out.push({ id: st.id, parent: st.parent, source: 'codex', project: '', name: trunc(st.prompt || '(untitled)', 60), prompt: trunc(st.prompt, 400),
      model: st.model, status: status(s.mtimeMs), mtime: s.mtimeMs, activity: trunc(st.activity || '...', 80),
      tokOut: st.out, tokIn: st.freshIn, ctx: st.ctx, ctxMax: st.ctxMax, today: st.today });
  }
  return out;
}

// ---------- OpenCode (sqlite, read-only) ----------
let ocDb = null;
async function openCode() {
  try {
    if (!fs.existsSync(OC_DB)) return { note: 'OpenCode: not found', sessions: [] };
    if (!ocDb) { const { DatabaseSync } = await import('node:sqlite'); ocDb = new DatabaseSync(OC_DB, { readOnly: true }); }
    const rows = ocDb.prepare('select id,title,slug,model,tokens_input,tokens_output,tokens_cache_read,time_updated from session_v2 where time_updated > ? and parent_id is null order by time_updated desc limit 12').all(Date.now() - DAY);
    return { note: '', sessions: rows.map(r => {
      let m = ''; try { m = JSON.parse(r.model).id; } catch {}
      return { id: r.id, parent: null, source: 'opencode', project: '', name: trunc(r.title || r.slug, 60), model: m || 'opencode', status: status(r.time_updated), mtime: r.time_updated,
        activity: 'OpenCode session', tokOut: r.tokens_output, tokIn: r.tokens_input + r.tokens_cache_read, ctx: 0, ctxMax: 0, today: 0 };
    }) };
  } catch (e) { ocDb = null; return { note: 'OpenCode: not tracked (' + trunc(e.message, 50) + ')', sessions: [] }; }
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
    gpuMode = 'ps';
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
let sessions = [], oc = { note: '', sessions: [] };
async function refresh() {
  try { sessions = claudeSessions().concat(codexSessions()); } catch (e) { console.error(e); }
  oc = await openCode();
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
  if (req.url === '/api/state') {
    const body = JSON.stringify({
      now: Date.now(), sessions: sessions.concat(oc.sessions), openCodeNote: oc.note, claudePlan: claudePlan(),
      todayTokens: sessions.reduce((a, s) => a + s.today, 0),
      machine: { cpu: cpuPct, ramUsed: os.totalmem() - os.freemem(), ramTotal: os.totalmem(), gpu, ollama },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) }); return res.end(body);
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
  }
  res.writeHead(404); res.end();
});
await refresh();
server.listen(4300, '127.0.0.1', () => console.log('Agent dashboard on http://127.0.0.1:4300'));

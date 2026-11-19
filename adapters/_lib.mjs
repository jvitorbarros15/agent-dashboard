import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DAY = 24 * 3600e3;
export const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const statusOf = (ms) => { const a = Date.now() - ms; return a < 120e3 ? 'active' : a < 1800e3 ? 'idle' : 'sleeping'; };
export const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const recent = (ms) => Date.now() - ms <= DAY;

// Watchtower signals, filled while a transcript is read. Tools that hand work to a subagent or the
// background never count as "waiting on you".
const WAIT_EXEMPT = new Set(['Task', 'Agent', 'TaskOutput', 'TodoWrite', 'Monitor']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// edits keeps a longer record than files for the Vizier's daily Quest report.
export const watchState = () => ({ pending: {}, calls: [], files: [], edits: [], beats: [], errStreak: 0, askedAt: 0, ctxHist: [], cwd: '', lastText: '' });
export function onToolUse(st, id, name, input, ts, paths) {
  if (!id || st.calls.some(c => c.id === id)) return;
  const hint = String(input?.command ?? input?.cmd ?? input?.file_path ?? input?.notebook_path ?? input?.pattern ?? input?.url ?? input?.description ?? '').replace(/\s+/g, ' ').slice(0, 80);
  st.calls.push({ id, name, sig: name + ':' + JSON.stringify(input ?? '').slice(0, 300), ts, hint });
  if (st.calls.length > 30) st.calls.shift();
  if (!WAIT_EXEMPT.has(name)) st.pending[id] = { name, since: ts, hint };
  const edited = paths || (EDIT_TOOLS.has(name) && (input?.file_path || input?.notebook_path) ? [input.file_path || input.notebook_path] : []);
  for (const p of edited) { st.files.push({ path: p, ts }); st.edits.push({ path: p, ts }); }
  if (st.files.length > 60) st.files.splice(0, st.files.length - 60);
  if (st.edits.length > 500) st.edits.splice(0, st.edits.length - 500);
}
export function onToolResult(st, id, isError, text) {
  delete st.pending[id];
  if (!isError) st.errStreak = 0;
  else if (!/user (doesn't|does not) want|rejected|interrupted|denied|declined/i.test(text || '')) st.errStreak++;
}
export const watchFields = st => ({ pending: Object.values(st.pending), calls: st.calls, files: st.files, errStreak: st.errStreak, askedAt: st.askedAt, ctxHist: st.ctxHist, cwd: st.cwd });
// What the Quest report needs about one session: usage per hour, edits with times, where it ran, its last words.
export const reportFields = st => ({ hours: st.hours, edits: st.edits, beats: st.beats, cwd: st.cwd, lastText: st.lastText, model: st.model, prompt: st.prompt });

// Timeline events for one transcript, newest kept when it's long.
export function timelineEvent(list, e) { list.push(e); if (list.length > 2000) list.shift(); }
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Adds (sign 1) or removes (sign -1) one usage record: v = [output, freshInput, cacheRead, cacheWrite].
// Keeps running totals on st plus hourly buckets keyed "<hourIndex>|<model>" for history and cost.
export function addUsage(st, ts, model, v, sign, mid) {
  st.out += sign * v[0]; st.freshIn += sign * v[1]; st.cr = (st.cr || 0) + sign * v[2]; st.cw = (st.cw || 0) + sign * v[3];
  if (ts >= mid) st.today += sign * v[0];
  if (!ts) return;
  // beats: the minutes in which the model produced output, for the day replay
  if (st.beats && sign > 0) { const m = Math.floor(ts / 6e4); if (st.beats[st.beats.length - 1] !== m) { st.beats.push(m); if (st.beats.length > 4000) st.beats.shift(); } }
  const key = Math.floor(ts / 36e5) + '|' + (model || '?'), b = st.hours[key] || (st.hours[key] = [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) b[i] += sign * v[i];
}

// Per-OS folder where VS Code-style editors keep globalStorage.
export const appData = () => process.platform === 'win32' ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'));

export function stat(f) { try { return fs.statSync(f); } catch { return null; } }
export function ls(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
export function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

export function walk(dir, pred, out = [], depth = 8) {
  if (depth < 0) return out;
  for (const e of ls(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out, depth - 1);
    else if (pred(e.name, p)) out.push(p);
  }
  return out;
}

// Normalizes an adapter's row into the shape the UI expects.
export function session(o) {
  return {
    parent: null, project: '', prompt: '', model: '', activity: '...', tokOut: 0, tokIn: 0, ctx: 0, ctxMax: 0, today: 0,
    ...o, name: trunc(o.name || o.prompt || '(untitled)', 60), prompt: trunc(o.prompt, 400), activity: trunc(o.activity || '...', 80),
    status: o.status || statusOf(o.mtime),
  };
}

// Reads only the bytes appended since the last call, line by line. State is kept per file.
const cache = new Map();
export function readIncremental(file, size, ingest, mk) {
  let st = cache.get(file);
  if (!st || size < st.offset) { st = { offset: 0, ...mk() }; cache.set(file, st); }
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
      for (const l of all.subarray(0, nl).toString('utf8').split('\n')) if (l) ingest(st, l, mid);
      carry = all.subarray(nl + 1);
      st.offset = pos - carry.length;
    }
  } finally { fs.closeSync(fd); }
  return st;
}

// Re-parses a file only when its mtime changes.
const byMtime = new Map();
export function cachedByMtime(file, mtimeMs, parse) {
  const c = byMtime.get(file);
  if (c && c.m === mtimeMs) return c.v;
  const v = parse(file);
  byMtime.set(file, { m: mtimeMs, v });
  return v;
}

const dbs = new Map();
export async function sqlite(file) {
  if (dbs.has(file)) return dbs.get(file);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  dbs.set(file, db);
  return db;
}
export function dropDb(file) { try { dbs.get(file)?.close(); } catch {} dbs.delete(file); }

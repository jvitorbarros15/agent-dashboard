import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DAY = 24 * 3600e3;
export const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const statusOf = (ms) => { const a = Date.now() - ms; return a < 120e3 ? 'active' : a < 1800e3 ? 'idle' : 'sleeping'; };
export const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const recent = (ms) => Date.now() - ms <= DAY;

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

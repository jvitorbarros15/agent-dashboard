import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { usd } from './pricing.mjs';

const git = (cwd, args) => new Promise(r => execFile('git', ['-C', cwd, ...args], { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }, (e, so) => r(e ? null : String(so))));
const rootCache = new Map();
async function repoRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  if (!rootCache.has(cwd)) rootCache.set(cwd, (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null);
  return rootCache.get(cwd);
}

// Local calendar day "YYYY-MM-DD" -> [start, end) in ms.
export function dayRange(day) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? new Date(day + 'T00:00:00') : new Date(new Date().setHours(0, 0, 0, 0));
  const end = new Date(d); end.setDate(end.getDate() + 1);
  return [d.getTime(), end.getTime()];
}

// The Quest report: what every agent did in one day, grouped by repository (or folder), with files, commits and cost.
export async function buildReport(adapters, day, pause) {
  const [from, to] = dayRange(day), fromH = Math.floor(from / 36e5), toH = Math.ceil(to / 36e5);
  const groups = new Map();
  for (const a of adapters) {
    if (typeof a.report !== 'function') continue;
    let entries = []; try { entries = await a.report(from, pause); } catch (e) { console.warn(`${a.id} report: ${e.message}`); }
    for (const e of entries) {
      let out = 0, inn = 0, cost = 0, unpriced = false, first = Infinity, last = 0;
      for (const [key, v] of Object.entries(e.hours || {})) {
        const i = key.indexOf('|'), h = +key.slice(0, i);
        if (h < fromH || h >= toH || !(v[0] || v[1])) continue;
        out += v[0]; inn += v[1] + v[2] + v[3];
        const c = usd(key.slice(i + 1), v); if (c == null) unpriced = true; else cost += c;
        first = Math.min(first, h * 36e5); last = Math.max(last, (h + 1) * 36e5);
      }
      const edits = (e.edits || []).filter(x => x.ts >= from && x.ts < to);
      if (!out && !edits.length) continue;
      for (const x of edits) { first = Math.min(first, x.ts); last = Math.max(last, x.ts); }
      const root = await repoRoot(e.cwd), key = root || e.cwd || `${a.id}:${e.project}`;
      const g = groups.get(key) || { key, repo: root, cwd: e.cwd, name: path.basename(root || e.cwd || e.project || a.id) || key, agents: [], files: new Map(), out: 0, cost: 0, unpriced: false };
      g.agents.push({ id: e.id, parent: e.parent, source: e.source, name: e.name || e.prompt || '(untitled)', model: e.model, out, in: inn, cost, unpriced, first, last, edits: edits.length, lastText: e.lastText || '' });
      for (const x of edits) {
        let rel = root && path.isAbsolute(x.path) ? path.relative(root, x.path) : x.path;
        if (rel.startsWith('..')) rel = x.path;
        g.files.set(rel, (g.files.get(rel) || 0) + 1);
      }
      g.out += out; g.cost += cost; g.unpriced ||= unpriced;
      groups.set(key, g);
    }
  }
  const projects = [];
  for (const g of groups.values()) {
    let commits = [];
    if (g.repo) {
      const log = await git(g.repo, ['log', '--all', `--since=${new Date(from).toISOString()}`, `--until=${new Date(to).toISOString()}`, '--pretty=format:%h%x09%aI%x09%an%x09%s', '-n', '60']);
      commits = (log || '').split('\n').filter(Boolean).map(l => { const [hash, date, author, ...s] = l.split('\t'); return { hash, t: Date.parse(date), author, subject: s.join('\t') }; });
    }
    projects.push({ name: g.name, repo: g.repo, cwd: g.cwd, out: g.out, cost: g.cost, unpriced: g.unpriced, commits,
      agents: g.agents.sort((a, b) => a.first - b.first),
      files: [...g.files].map(([file, n]) => ({ file, n })).sort((a, b) => b.n - a.n).slice(0, 40), fileCount: g.files.size });
  }
  projects.sort((a, b) => b.cost - a.cost || b.out - a.out);
  return { day: new Date(from).toISOString().slice(0, 10), from, to, projects };
}

// Today's spend per project for the Treasury (budget guards), from the live session list.
export function spendByProject(sessions) {
  const m = new Map();
  for (const s of sessions) {
    if (s.todayCost == null) continue;
    const key = s.cwd || `${s.source}:${s.project}`;
    const p = m.get(key) || { key, name: path.basename(s.cwd || s.project || s.source) || key, usd: 0 };
    p.usd += s.todayCost; m.set(key, p);
  }
  return [...m.values()].filter(p => p.usd > 0).sort((a, b) => b.usd - a.usd);
}

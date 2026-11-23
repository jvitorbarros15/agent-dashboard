import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tools that finish in a blink once allowed: if one has no result after a few seconds, a permission prompt is open.
const INSTANT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'apply_patch']);
const MIN = 6e4;
const ago = ms => ms < MIN ? Math.round(ms / 1e3) + 's' : Math.round(ms / MIN) + 'm';
// Repo root plus shared .git dir, so worktrees of one repo can be told apart from unrelated repos.
const repoCache = new Map();
function repoOf(dir) {
  if (repoCache.has(dir)) return repoCache.get(dir);
  let info = null;
  try {
    const dotgit = path.join(dir, '.git');
    if (fs.statSync(dotgit).isDirectory()) info = { root: dir, common: dotgit, gitdir: dotgit };
    else {
      const gd = path.resolve(dir, fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim()), linked = /[\\/]worktrees[\\/][^\\/]+$/.test(gd);
      info = { root: dir, common: linked ? path.dirname(path.dirname(gd)) : gd, gitdir: gd, linked };
    }
  } catch {}
  if (!info) { const up = path.dirname(dir); info = up === dir ? null : repoOf(up); }
  if (repoCache.size > 500) repoCache.clear();
  repoCache.set(dir, info);
  return info;
}
// Name of the main checkout, shared by all its worktrees.
export function repoName(cwd) {
  const r = repoOf(cwd);
  return r ? path.basename(path.basename(r.common) === '.git' ? path.dirname(r.common) : r.root) : path.basename(cwd);
}
// Current branch (or short commit when detached) and, for a linked worktree, its folder name. HEAD is re-read every call.
function checkoutOf(cwd) {
  const r = repoOf(cwd); if (!r) return {};
  let branch = '';
  try { const head = fs.readFileSync(path.join(r.gitdir, 'HEAD'), 'utf8').trim(); branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 7); } catch {}
  return { branch, worktree: r.linked ? path.basename(r.root) : '', checkout: r.root };
}
const norm = p => path.normalize(p).replace(/\\/g, '/').toLowerCase();
const short = s => String(s || '').length > 60 ? String(s).slice(0, 59) + '…' : String(s || '');

// Adds s.watch = { needs, stuck, collision, ctxTurnsLeft } to every session, strips the raw signals,
// and returns the list of files more than one agent edited recently.
export function watchSessions(sessions, now = Date.now()) {
  const byPath = new Map();
  for (const s of sessions) {
    const quiet = now - s.mtime, w = { needs: null, stuck: null, collision: null, ctxTurnsLeft: null };

    // 1. Needs you
    const pending = (s.pending || []).filter(p => now - p.since < 6 * 36e5);
    const ask = pending.find(p => p.name === 'AskUserQuestion'), plan = pending.find(p => p.name === 'ExitPlanMode');
    const blocked = pending.filter(p => p !== ask && p !== plan && now - p.since > (INSTANT.has(p.name) ? 10e3 : 45e3)).at(-1);
    if (s.needsYou) w.needs = s.needsYou;
    else if (ask && quiet > 3e3) w.needs = { kind: 'question', detail: 'Asked you a question', since: ask.since };
    else if (plan && quiet > 3e3) w.needs = { kind: 'plan', detail: 'Plan is ready for your approval', since: plan.since };
    else if (blocked && quiet > 8e3) {
      const call = `${blocked.name}${blocked.hint ? ' ' + short(blocked.hint) : ''}`;
      w.needs = INSTANT.has(blocked.name)
        ? { kind: 'approval', since: blocked.since, detail: `${call} has waited ${ago(now - blocked.since)} for approval` }
        : { kind: 'maybe', since: blocked.since, detail: `Possibly waiting on ${call} · last activity ${ago(quiet)} ago` };
    }
    else if (s.askedAt && !s.parent && quiet > 3e3 && quiet < 6 * 36e5 && !pending.length) w.needs = { kind: 'reply', detail: 'Finished with a question for you', since: s.askedAt };

    // 3. Stuck: the same call over and over, or a run of failures
    if (quiet < 30 * MIN) {
      const calls = (s.calls || []).filter(c => now - c.ts < 20 * MIN).slice(-10), count = new Map();
      for (const c of calls) count.set(c.sig, (count.get(c.sig) || 0) + 1);
      const [sig, n] = [...count].sort((a, b) => b[1] - a[1])[0] || [];
      if (n >= 4) {
        let streak = 0, cur = 0;
        for (const c of calls) { cur = c.sig === sig ? cur + 1 : 0; streak = Math.max(streak, cur); }
        const c = calls.findLast(x => x.sig === sig), what = `Ran ${c.name}${c.hint ? ' ' + short(c.hint) : ''}`;
        w.stuck = { kind: 'loop', detail: streak >= 4 ? `${what} ${streak} times in a row` : `${what} ${n} times in the last ${calls.length} calls` };
      }
      else if ((s.errStreak || 0) >= 4) w.stuck = { kind: 'errors', detail: `${s.errStreak} tool calls failed in a row` };
    }

    // 4b. Context forecast: average growth per turn since the last compaction
    const h = s.ctxHist || [];
    let start = h.length - 1; while (start > 0 && h[start - 1] <= h[start]) start--;
    const run = h.slice(start);
    if (s.ctxMax > 0 && run.length >= 3) {
      const growth = (run.at(-1) - run[0]) / (run.length - 1), room = s.ctxMax * 0.92 - s.ctx;
      if (growth > 500) w.ctxTurnsLeft = Math.max(0, Math.floor(room / growth));
    }

    // 2. Collisions: the same absolute file is a clash; the same repo-relative file in two worktrees is a merge overlap
    if (quiet < 60 * MIN) for (const f of s.files || []) {
      if (now - f.ts > 30 * MIN) continue;
      const abs = path.isAbsolute(f.path) ? f.path : s.cwd ? path.resolve(s.cwd, f.path) : null;
      if (!abs) continue;
      const repo = repoOf(path.dirname(abs)), entry = { id: s.id, name: s.name, ts: f.ts, file: abs, root: repo && norm(repo.root) };
      for (const key of ['f|' + norm(abs), repo && 'r|' + norm(repo.common) + '|' + norm(path.relative(repo.root, abs))]) {
        if (!key) continue;
        const list = byPath.get(key) || []; if (!list.some(x => x.id === s.id)) list.push(entry);
        byPath.set(key, list);
      }
    }
    s.watch = w;
    if (s.cwd) { s.repo = repoName(s.cwd); Object.assign(s, checkoutOf(s.cwd)); }
    for (const k of ['pending', 'calls', 'files', 'errStreak', 'askedAt', 'ctxHist', 'needsYou']) delete s[k];
  }
  const collisions = [...byPath].filter(([k, l]) => l.length > 1 && (k[0] === 'f' || new Set(l.map(x => x.root)).size > 1))
    .map(([k, l]) => ({ kind: k[0] === 'f' ? 'clash' : 'overlap', file: l[0].file, agents: l.map(({ id, name, ts }) => ({ id, name, ts })), at: Math.max(...l.map(x => x.ts)) }))
    .sort((a, b) => b.at - a.at);
  const index = new Map(sessions.map(s => [s.id, s]));
  for (const c of collisions) for (const a of c.agents) {
    const w = index.get(a.id)?.watch;
    if (w && (!w.collision || w.collision.kind === 'overlap' && c.kind === 'clash')) w.collision = { kind: c.kind, file: c.file, with: c.agents.filter(x => x.id !== a.id).map(x => ({ id: x.id, name: x.name })) };
  }
  return collisions;
}

// 4a. Plan limit forecast from how fast the usage percentage has been climbing in the current window.
// Pace samples survive restarts so a forecast doesn't start from zero every time.
const SAMPLES_FILE = path.join(os.homedir(), '.agent-party', 'plan-samples.json');
let samples = { fiveHour: [], weekly: [] };
try { const j = JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf8')); if (Array.isArray(j.fiveHour) && Array.isArray(j.weekly)) samples = j; } catch {}
const saveSamples = () => { try { fs.mkdirSync(path.dirname(SAMPLES_FILE), { recursive: true }); fs.writeFileSync(SAMPLES_FILE, JSON.stringify(samples)); } catch {} };
export function forecastPlan(plan, now = Date.now()) {
  if (!plan) return null;
  const at = v => typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  const out = {};
  for (const key of ['fiveHour', 'weekly']) {
    const w = plan[key]; if (!w) continue;
    const reset = at(w.resetsAt), list = samples[key];
    if (list.length && list.at(-1).reset !== reset) list.length = 0;
    if (!list.length || list.at(-1).pct !== w.pct) { list.push({ t: plan.updatedAt || now, pct: w.pct, reset }); saveSamples(); }
    const lookback = key === 'fiveHour' ? 90 * MIN : 24 * 36e5;
    while (list.length > 2 && list[0].t < now - lookback) list.shift();
    const a = list[0], b = list.at(-1);
    if (!a || b.t - a.t < 3 * MIN || b.pct <= a.pct) { out[key] = { learning: true }; continue; }
    const rate = (b.pct - a.pct) / (b.t - a.t), runsOut = b.t + (100 - b.pct) / rate;
    out[key] = runsOut < reset ? { runsOutAt: Math.round(runsOut), resetsAt: reset } : { atReset: Math.min(100, Math.round(b.pct + rate * (reset - b.t))), resetsAt: reset };
  }
  return out;
}

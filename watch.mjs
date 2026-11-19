import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tools that finish in a blink once allowed: if one has no result after a few seconds, a permission prompt is open.
const INSTANT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'apply_patch']);
const MIN = 6e4;
const ago = ms => ms < MIN ? Math.round(ms / 1e3) + 's' : Math.round(ms / MIN) + 'm';
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
    if (ask && quiet > 3e3) w.needs = { kind: 'question', detail: 'Asked you a question', since: ask.since };
    else if (plan && quiet > 3e3) w.needs = { kind: 'plan', detail: 'Plan is ready for your approval', since: plan.since };
    else if (blocked && quiet > 8e3) w.needs = { kind: 'approval', since: blocked.since,
      detail: `${blocked.name}${blocked.hint ? ' ' + short(blocked.hint) : ''} has waited ${ago(now - blocked.since)}${INSTANT.has(blocked.name) ? ' for approval' : ' (approval, or still running)'}` };
    else if (s.askedAt && !s.parent && quiet > 3e3 && quiet < 6 * 36e5 && !pending.length) w.needs = { kind: 'reply', detail: 'Finished with a question for you', since: s.askedAt };

    // 3. Stuck: the same call over and over, or a run of failures
    if (quiet < 30 * MIN) {
      const calls = (s.calls || []).filter(c => now - c.ts < 20 * MIN).slice(-10), count = new Map();
      for (const c of calls) count.set(c.sig, (count.get(c.sig) || 0) + 1);
      const [sig, n] = [...count].sort((a, b) => b[1] - a[1])[0] || [];
      if (n >= 4) { const c = calls.findLast(x => x.sig === sig); w.stuck = { kind: 'loop', detail: `Ran ${c.name}${c.hint ? ' ' + short(c.hint) : ''} ${n} times in a row` }; }
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

    // 2. Collisions: remember which recent agent edited which file
    if (quiet < 60 * MIN) for (const f of s.files || []) {
      if (now - f.ts > 30 * MIN) continue;
      const key = path.normalize(f.path).replace(/\\/g, '/').toLowerCase();
      const list = byPath.get(key) || []; if (!list.some(x => x.id === s.id)) list.push({ id: s.id, name: s.name, ts: f.ts, file: f.path });
      byPath.set(key, list);
    }
    s.watch = w;
    for (const k of ['pending', 'calls', 'files', 'errStreak', 'askedAt', 'ctxHist']) delete s[k];
  }
  const collisions = [...byPath.values()].filter(l => l.length > 1)
    .map(l => ({ file: l[0].file, agents: l.map(({ id, name, ts }) => ({ id, name, ts })), at: Math.max(...l.map(x => x.ts)) }))
    .sort((a, b) => b.at - a.at);
  const index = new Map(sessions.map(s => [s.id, s]));
  for (const c of collisions) for (const a of c.agents) {
    const w = index.get(a.id)?.watch;
    if (w && !w.collision) w.collision = { file: c.file, with: c.agents.filter(x => x.id !== a.id).map(x => ({ id: x.id, name: x.name })) };
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

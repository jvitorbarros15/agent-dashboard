import fs from 'node:fs';
import path from 'node:path';
import { HOME, DAY, ls, stat, recent, readIncremental, session, addUsage } from './_lib.mjs';

const PROJECTS = path.join(HOME, '.claude', 'projects');

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  return '';
}

const mk = () => ({ out: 0, freshIn: 0, cr: 0, cw: 0, today: 0, ctx: 0, model: '', prompt: '', title: '', activity: '', lastId: '', last: null, hours: {} });
function ingest(st, line, mid) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'ai-title' && o.aiTitle) st.title = o.aiTitle;
  else if (o.type === 'user' && !st.prompt && !o.isMeta && o.message) {
    const t = textOf(o.message.content).trim();
    if (t && !t.startsWith('<')) st.prompt = t;
  } else if (o.type === 'assistant' && o.message?.usage) {
    const m = o.message, u = m.usage, ts = Date.parse(o.timestamp) || 0;
    if (m.model && m.model !== '<synthetic>') st.model = m.model;
    const v = [u.output_tokens || 0, u.input_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0];
    // streamed blocks repeat the same message id: replace the earlier numbers, don't add
    if (st.lastId === m.id && st.last) addUsage(st, st.last.ts, st.last.model, st.last.v, -1, mid);
    addUsage(st, ts, st.model, v, 1, mid);
    st.lastId = m.id; st.last = { ts, model: st.model, v };
    st.ctx = v[1] + v[2] + v[3];
    const c = Array.isArray(m.content) ? m.content : [];
    const tool = [...c].reverse().find(b => b.type === 'tool_use');
    const txt = [...c].reverse().find(b => b.type === 'text' && b.text?.trim());
    if (tool) st.activity = 'Tool: ' + tool.name;
    else if (txt) st.activity = txt.text;
  }
}

const projectOf = name => name.replace(/^[a-zA-Z]--?/, '').replace(/-/g, '/');

// Every transcript (leads and subagents) under ~/.claude/projects.
function files() {
  const out = [];
  for (const p of ls(PROJECTS)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS, p.name);
    for (const e of ls(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ f: path.join(dir, e.name), p: p.name, sid: e.name.slice(0, -6) });
      else if (e.isDirectory()) {
        const sd = path.join(dir, e.name, 'subagents');
        for (const s of ls(sd)) if (s.name.endsWith('.jsonl')) out.push({ f: path.join(sd, s.name), p: p.name, sid: e.name, aid: s.name.slice(0, -6) });
      }
    }
  }
  return out;
}

export default {
  id: 'claude',
  label: 'Claude Code',
  resume: 'claude --resume {lead}',
  sessions() {
    const out = [];
    for (const { f, p, sid, aid } of files()) {
      const s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      let desc = '';
      if (aid) { try { desc = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || ''; } catch {} }
      out.push(session({
        id: aid || sid, parent: aid ? sid : null, source: 'claude', project: projectOf(p),
        name: aid ? (desc || st.prompt) : (st.title || st.prompt), prompt: st.prompt,
        model: st.model, mtime: s.mtimeMs, activity: st.activity,
        tokOut: st.out, tokIn: st.freshIn, cacheRead: st.cr, cacheWrite: st.cw, ctx: st.ctx,
        ctxMax: /\[1m\]$/.test(st.model) || st.ctx > 2e5 ? 1e6 : 2e5, today: st.today, hours: st.hours,
      }));
    }
    return out;
  },
  // Usage per hour and model for the last 30 days. Claude Code keeps transcripts for cleanupPeriodDays (30 by default).
  async history(pause) {
    const out = [];
    for (const { f, p } of files()) {
      const s = stat(f);
      if (!s || Date.now() - s.mtimeMs > 30 * DAY) continue;
      out.push({ project: projectOf(p), hours: readIncremental(f, s.size, ingest, mk).hours });
      await pause?.();
    }
    return out;
  },
  // Lead sessions untouched for 30+ days, only present if cleanupPeriodDays was raised.
  archive() {
    const out = [], cutoff = Date.now() - 30 * DAY;
    for (const { f, p, sid, aid } of files()) {
      if (aid) continue;
      const s = stat(f);
      if (!s || s.mtimeMs > cutoff || s.size < 1 << 20) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      out.push(session({ id: sid, source: 'claude', project: projectOf(p), name: st.title || st.prompt, prompt: st.prompt,
        model: st.model, mtime: s.mtimeMs, activity: st.activity, tokOut: st.out, tokIn: st.freshIn, status: 'abandoned', mass: s.size, hours: st.hours }));
    }
    return out;
  },
};

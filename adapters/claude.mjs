import fs from 'node:fs';
import path from 'node:path';
import { HOME, DAY, ls, stat, recent, readIncremental, session } from './_lib.mjs';

const PROJECTS = path.join(HOME, '.claude', 'projects');

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  return '';
}

const mk = () => ({ out: 0, freshIn: 0, today: 0, ctx: 0, model: '', prompt: '', title: '', activity: '', lastId: '', lastOut: 0, lastFresh: 0 });
function ingest(st, line, mid) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'ai-title' && o.aiTitle) st.title = o.aiTitle;
  else if (o.type === 'user' && !st.prompt && !o.isMeta && o.message) {
    const t = textOf(o.message.content).trim();
    if (t && !t.startsWith('<')) st.prompt = t;
  } else if (o.type === 'assistant' && o.message?.usage) {
    const m = o.message, u = m.usage;
    const out = u.output_tokens || 0;
    const ts = Date.parse(o.timestamp) || 0;
    if (m.model && m.model !== '<synthetic>') st.model = m.model;
    // streamed blocks repeat the same message id: replace, don't add
    if (st.lastId && st.lastId === m.id) { st.out += out - st.lastOut; st.freshIn += (u.input_tokens || 0) - st.lastFresh; if (ts >= mid) st.today += out - st.lastOut; }
    else { st.out += out; st.freshIn += u.input_tokens || 0; if (ts >= mid) st.today += out; }
    st.lastId = m.id; st.lastOut = out; st.lastFresh = u.input_tokens || 0;
    st.ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const c = Array.isArray(m.content) ? m.content : [];
    const tool = [...c].reverse().find(b => b.type === 'tool_use');
    const txt = [...c].reverse().find(b => b.type === 'text' && b.text?.trim());
    if (tool) st.activity = 'Tool: ' + tool.name;
    else if (txt) st.activity = txt.text;
  }
}

export default {
  id: 'claude',
  label: 'Claude Code',
  resume: 'claude --resume {lead}',
  sessions() {
    const out = [];
    for (const p of ls(PROJECTS)) {
      if (!p.isDirectory()) continue;
      const dir = path.join(PROJECTS, p.name);
      for (const e of ls(dir)) {
        const files = [];
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ f: path.join(dir, e.name), sid: e.name.slice(0, -6) });
        else if (e.isDirectory()) {
          const sd = path.join(dir, e.name, 'subagents');
          for (const s of ls(sd)) if (s.name.endsWith('.jsonl')) files.push({ f: path.join(sd, s.name), sid: e.name, aid: s.name.slice(0, -6) });
        }
        for (const { f, sid, aid } of files) {
          const s = stat(f);
          if (!s || !recent(s.mtimeMs)) continue;
          const st = readIncremental(f, s.size, ingest, mk);
          let desc = '';
          if (aid) { try { desc = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || ''; } catch {} }
          out.push(session({
            id: aid || sid, parent: aid ? sid : null, source: 'claude',
            project: p.name.replace(/^[a-zA-Z]--?/, '').replace(/-/g, '/'),
            name: aid ? (desc || st.prompt) : (st.title || st.prompt), prompt: st.prompt,
            model: st.model, mtime: s.mtimeMs, activity: st.activity,
            tokOut: st.out, tokIn: st.freshIn, ctx: st.ctx,
            ctxMax: /\[1m\]$/.test(st.model) || st.ctx > 2e5 ? 1e6 : 2e5, today: st.today,
          }));
        }
      }
    }
    return out;
  },
  // Lead sessions untouched for 30+ days. Claude Code deletes transcripts after cleanupPeriodDays (30 by default).
  archive() {
    const out = [], cutoff = Date.now() - 30 * DAY;
    for (const p of ls(PROJECTS)) {
      if (!p.isDirectory()) continue;
      const dir = path.join(PROJECTS, p.name);
      for (const e of ls(dir)) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const f = path.join(dir, e.name), s = stat(f);
        if (!s || s.mtimeMs > cutoff || s.size < 1 << 20) continue;
        const st = readIncremental(f, s.size, ingest, mk);
        out.push(session({ id: e.name.slice(0, -6), source: 'claude', project: p.name.replace(/^[a-zA-Z]--?/, '').replace(/-/g, '/'),
          name: st.title || st.prompt, prompt: st.prompt, model: st.model, mtime: s.mtimeMs, activity: st.activity,
          tokOut: st.out, tokIn: st.freshIn, status: 'abandoned', mass: s.size }));
      }
    }
    return out;
  },
};

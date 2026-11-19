import fs from 'node:fs';
import path from 'node:path';
import { HOME, DAY, ls, stat, recent, readIncremental, session, addUsage, watchState, onToolUse, onToolResult, watchFields, reportFields, timelineEvent, clip } from './_lib.mjs';

const PROJECTS = path.join(HOME, '.claude', 'projects');

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  return '';
}

const mk = () => ({ out: 0, freshIn: 0, cr: 0, cw: 0, today: 0, ctx: 0, model: '', prompt: '', title: '', activity: '', lastId: '', last: null, hours: {}, ...watchState() });
function ingest(st, line, mid) {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.cwd) st.cwd = o.cwd;
  if (o.type === 'ai-title' && o.aiTitle) st.title = o.aiTitle;
  else if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
      for (const b of c) if (b.type === 'tool_result') onToolResult(st, b.tool_use_id, b.is_error, typeof b.content === 'string' ? b.content : textOf(b.content));
    } else if (!o.isMeta) {
      const t = textOf(c).trim();
      if (t && !t.startsWith('<')) { if (!st.prompt) st.prompt = t; st.askedAt = 0; }
    }
  } else if (o.type === 'assistant' && o.message?.usage) {
    const m = o.message, u = m.usage, ts = Date.parse(o.timestamp) || 0;
    if (m.model && m.model !== '<synthetic>') st.model = m.model;
    const v = [u.output_tokens || 0, u.input_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0];
    const fresh = st.lastId !== m.id;
    // streamed blocks repeat the same message id: replace the earlier numbers, don't add
    if (!fresh && st.last) addUsage(st, st.last.ts, st.last.model, st.last.v, -1, mid);
    addUsage(st, ts, st.model, v, 1, mid);
    st.lastId = m.id; st.last = { ts, model: st.model, v };
    st.ctx = v[1] + v[2] + v[3];
    if (fresh) { st.ctxHist.push(st.ctx); if (st.ctxHist.length > 12) st.ctxHist.shift(); }
    const c = Array.isArray(m.content) ? m.content : [];
    for (const b of c) {
      if (b.type === 'tool_use') { onToolUse(st, b.id, b.name, b.input, ts); st.askedAt = 0; }
      else if (b.type === 'text' && b.text?.trim()) { st.askedAt = /\?\s*$/.test(b.text.trim()) ? ts : 0; st.lastText = clip(b.text.trim(), 600); }
    }
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
const descOf = f => { try { return JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || ''; } catch { return ''; } };
const hintOf = i => String(i?.command ?? i?.file_path ?? i?.notebook_path ?? i?.pattern ?? i?.url ?? i?.description ?? i?.prompt ?? (i ? JSON.stringify(i) : '')).replace(/\s+/g, ' ');

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
      out.push(session({
        id: aid || sid, parent: aid ? sid : null, source: 'claude', project: projectOf(p),
        name: aid ? (descOf(f) || st.prompt) : (st.title || st.prompt), prompt: st.prompt,
        model: st.model, mtime: s.mtimeMs, activity: st.activity,
        tokOut: st.out, tokIn: st.freshIn, cacheRead: st.cr, cacheWrite: st.cw, ctx: st.ctx,
        ctxMax: /\[1m\]$/.test(st.model) || st.ctx > 2e5 ? 1e6 : 2e5, today: st.today, hours: st.hours, ...watchFields(st),
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
  // Everything the Quest report needs for sessions touched since `since`.
  async report(since, pause) {
    const out = [];
    for (const { f, p, sid, aid } of files()) {
      const s = stat(f);
      if (!s || s.mtimeMs < since) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      out.push({ id: aid || sid, parent: aid ? sid : null, source: 'claude', project: projectOf(p),
        name: aid ? (descOf(f) || st.prompt) : (st.title || st.prompt), ...reportFields(st) });
      await pause?.();
    }
    return out;
  },
  // Every prompt, message, tool call and result of one session, in order.
  timeline(id) {
    const hit = files().find(x => (x.aid || x.sid) === id);
    if (!hit) return null;
    const ev = [], names = {};
    for (const line of fs.readFileSync(hit.f, 'utf8').split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const t = Date.parse(o.timestamp) || 0, c = o.message?.content;
      if (o.type === 'user' && o.message) {
        if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
          for (const b of c) if (b.type === 'tool_result') {
            const txt = typeof b.content === 'string' ? b.content : textOf(b.content);
            timelineEvent(ev, { t, kind: b.is_error ? 'error' : 'result', name: names[b.tool_use_id] || 'result', text: clip(txt, 1500) });
          }
        } else if (!o.isMeta) {
          const txt = textOf(c).trim();
          if (txt && !txt.startsWith('<')) timelineEvent(ev, { t, kind: 'user', name: 'You', text: clip(txt, 1500) });
        }
      } else if (o.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) timelineEvent(ev, { t, kind: 'text', name: 'Agent', text: clip(b.text.trim(), 1500) });
          else if (b.type === 'tool_use') { names[b.id] = b.name; timelineEvent(ev, { t, kind: 'tool', name: b.name, hint: clip(hintOf(b.input), 140), text: clip(JSON.stringify(b.input, null, 2), 1500) }); }
        }
      }
    }
    return ev;
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

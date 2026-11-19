import path from 'node:path';
import { HOME, DAY, stat, recent, walk, readIncremental, session, addUsage } from './_lib.mjs';

const DIR = path.join(HOME, '.codex', 'sessions');
const KEEP = /"(session_meta|turn_context|token_count|function_call|custom_tool_call|message)"/;
const mk = () => ({ id: '', parent: null, prompt: '', activity: '', model: '', out: 0, freshIn: 0, cr: 0, cw: 0, today: 0, ctx: 0, ctxMax: 0, seen: 0, hours: {} });
const partsOf = (c, type) => (Array.isArray(c) ? c.filter(b => b.type === type).map(b => b.text).join(' ') : '').trim();

function ingest(st, line, mid) {
  if (!KEEP.test(line)) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const p = o.payload || {};
  if (o.type === 'session_meta') {
    st.id = p.id || '';
    if (p.parent_thread_id && p.parent_thread_id !== p.id) st.parent = p.parent_thread_id;
  } else if (o.type === 'turn_context') {
    if (p.model) st.model = p.model;
  } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
    const t = p.info.total_token_usage || {}, l = p.info.last_token_usage || {};
    st.ctx = l.input_tokens || 0;
    st.ctxMax = p.info.model_context_window || 0;
    // token_count repeats when nothing new happened; only count a turn when the running total moves
    if ((t.total_tokens || 0) > st.seen) {
      st.seen = t.total_tokens || 0;
      const cached = l.cached_input_tokens || 0;
      addUsage(st, Date.parse(o.timestamp) || 0, st.model, [l.output_tokens || 0, (l.input_tokens || 0) - cached, cached, 0], 1, mid);
    }
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

export default {
  id: 'codex',
  label: 'Codex',
  resume: 'codex resume {id}',
  sessions() {
    const out = [];
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      if (!st.id) continue;
      out.push(session({ id: st.id, parent: st.parent, source: 'codex', prompt: st.prompt, model: st.model, mtime: s.mtimeMs,
        activity: st.activity, tokOut: st.out, tokIn: st.freshIn, cacheRead: st.cr, ctx: st.ctx, ctxMax: st.ctxMax, today: st.today, hours: st.hours }));
    }
    return out;
  },
  async history(pause) {
    const out = [];
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s || Date.now() - s.mtimeMs > 30 * DAY) continue;
      out.push({ project: 'codex', hours: readIncremental(f, s.size, ingest, mk).hours });
      await pause?.();
    }
    return out;
  },
  archive() {
    const out = [], cutoff = Date.now() - 30 * DAY;
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s || s.mtimeMs > cutoff || s.size < 256 << 10) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      if (!st.id || st.parent) continue;
      out.push(session({ id: st.id, source: 'codex', prompt: st.prompt, model: st.model, mtime: s.mtimeMs, activity: st.activity,
        tokOut: st.out, tokIn: st.freshIn, status: 'abandoned', mass: s.size, hours: st.hours }));
    }
    return out;
  },
};

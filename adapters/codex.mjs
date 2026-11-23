import path from 'node:path';
import fs from 'node:fs';
import { HOME, DAY, stat, recent, walk, readIncremental, session, addUsage, watchState, onToolUse, onToolResult, watchFields, reportFields, timelineEvent, clip } from './_lib.mjs';

const DIR = path.join(HOME, '.codex', 'sessions');
const KEEP = /"(session_meta|turn_context|token_count|function_call|custom_tool_call|message)/;
const mk = () => ({ id: '', parent: null, prompt: '', activity: '', model: '', out: 0, freshIn: 0, cr: 0, cw: 0, today: 0, ctx: 0, ctxMax: 0, seen: 0, hours: {}, ...watchState() });
const json = s => { try { return JSON.parse(s); } catch { return null; } };
// apply_patch input lists the files it touches as "*** Update File: path" / "*** Add File: path"
const patchedFiles = s => [...String(s || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1].trim());
const partsOf = (c, type) => (Array.isArray(c) ? c.filter(b => b.type === type).map(b => b.text).join(' ') : '').trim();

function ingest(st, line, mid) {
  if (!KEEP.test(line)) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const p = o.payload || {};
  if (o.type === 'session_meta') {
    st.id = p.id || '';
    if (p.cwd) st.cwd = p.cwd;
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
      st.ctxHist.push(st.ctx); if (st.ctxHist.length > 12) st.ctxHist.shift();
      const cached = l.cached_input_tokens || 0;
      addUsage(st, Date.parse(o.timestamp) || 0, st.model, [l.output_tokens || 0, (l.input_tokens || 0) - cached, cached, 0], 1, mid);
    }
  } else if (o.type === 'response_item') {
    const ts = Date.parse(o.timestamp) || 0;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      st.activity = 'Tool: ' + p.name;
      const input = p.type === 'function_call' ? json(p.arguments) || p.arguments : p.input;
      onToolUse(st, p.call_id, p.name, input, ts, p.name === 'apply_patch' ? patchedFiles(typeof input === 'string' ? input : input?.input) : null);
      st.askedAt = 0;
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      const code = json(out)?.metadata?.exit_code;
      onToolResult(st, p.call_id, code != null ? code !== 0 : /^(error|failed)/i.test(out), out);
    } else if (p.type === 'message' && p.role === 'user') {
      const t = partsOf(p.content, 'input_text');
      if (t && !t.startsWith('<')) { if (!st.prompt) st.prompt = t; st.askedAt = 0; }
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = partsOf(p.content, 'output_text');
      if (t) { st.activity = t; st.askedAt = /\?\s*$/.test(t) ? ts : 0; st.lastText = clip(t, 600); }
    }
  }
}

export default {
  id: 'codex',
  label: 'Codex',
  detect: () => !!stat(DIR),
  resume: 'codex resume {id}',
  sessions() {
    const out = [];
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      if (!st.id) continue;
      out.push(session({ id: st.id, parent: st.parent, source: 'codex', prompt: st.prompt, model: st.model, mtime: s.mtimeMs,
        activity: st.activity, tokOut: st.out, tokIn: st.freshIn, cacheRead: st.cr, ctx: st.ctx, ctxMax: st.ctxMax, today: st.today, hours: st.hours, ...watchFields(st) }));
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
  async report(since, pause) {
    const out = [];
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s || s.mtimeMs < since) continue;
      const st = readIncremental(f, s.size, ingest, mk);
      if (st.id) out.push({ id: st.id, parent: st.parent, source: 'codex', project: '', name: st.prompt, mtime: s.mtimeMs, ...reportFields(st) });
      await pause?.();
    }
    return out;
  },
  timeline(id) {
    for (const f of walk(DIR, n => n.endsWith('.jsonl'))) {
      const s = stat(f);
      if (!s) continue;
      if (readIncremental(f, s.size, ingest, mk).id !== id) continue;
      const ev = [], names = {};
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!KEEP.test(line)) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const p = o.payload || {}, t = Date.parse(o.timestamp) || 0;
        if (o.type !== 'response_item') continue;
        if (p.type === 'function_call' || p.type === 'custom_tool_call') {
          names[p.call_id] = p.name;
          const input = p.type === 'function_call' ? json(p.arguments) || p.arguments : p.input;
          timelineEvent(ev, { t, kind: 'tool', name: p.name, hint: clip(String(input?.command ?? input?.cmd ?? (typeof input === 'string' ? input : JSON.stringify(input))).replace(/\s+/g, ' '), 140), text: clip(typeof input === 'string' ? input : JSON.stringify(input, null, 2), 1500) });
        } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
          const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
          const code = json(out)?.metadata?.exit_code;
          timelineEvent(ev, { t, kind: (code != null ? code !== 0 : /^(error|failed)/i.test(out)) ? 'error' : 'result', name: names[p.call_id] || 'result', text: clip(json(out)?.output ?? out, 1500) });
        } else if (p.type === 'message') {
          const txt = partsOf(p.content, p.role === 'user' ? 'input_text' : 'output_text');
          if (txt && !(p.role === 'user' && txt.startsWith('<'))) timelineEvent(ev, { t, kind: p.role === 'user' ? 'user' : 'text', name: p.role === 'user' ? 'You' : 'Agent', text: clip(txt, 1500) });
        }
      }
      return ev;
    }
    return null;
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

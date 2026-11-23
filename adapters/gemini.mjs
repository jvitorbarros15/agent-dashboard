import path from 'node:path';
import { HOME, stat, recent, walk, readJson, cachedByMtime, midnight, session } from './_lib.mjs';

// Gemini CLI records each chat as ~/.gemini/tmp/<project>/chats/session-*.json
const DIR = path.join(HOME, '.gemini', 'tmp');

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text || '').join(' ') : '';

function parse(file) {
  const j = readJson(file);
  if (!j || !Array.isArray(j.messages)) return null;
  const mid = midnight();
  let prompt = '', model = '', activity = '', out = 0, inn = 0, today = 0, ctx = 0;
  for (const m of j.messages) {
    if (m.type === 'user') { const t = textOf(m.content).trim(); if (t && !prompt && !t.startsWith('/')) prompt = t; }
    if (m.type !== 'gemini') continue;
    if (m.model) model = m.model;
    const t = m.tokens || {};
    out += (t.output || 0) + (t.thoughts || 0);
    inn += Math.max(0, (t.input || 0) - (t.cached || 0));
    if (t.input) ctx = t.input;
    if ((Date.parse(m.timestamp) || 0) >= mid) today += (t.output || 0) + (t.thoughts || 0);
    const tool = Array.isArray(m.toolCalls) && m.toolCalls.at(-1);
    activity = tool ? 'Tool: ' + (tool.displayName || tool.name) : textOf(m.content) || activity;
  }
  return { id: j.sessionId || path.basename(file, '.json'), prompt, model, activity, out, inn, today, ctx };
}

export default {
  id: 'gemini',
  label: 'Gemini CLI',
  detect: () => !!stat(DIR),
  sessions() {
    const out = [];
    for (const f of walk(DIR, (n, p) => n.endsWith('.json') && path.basename(path.dirname(p)) === 'chats', [], 3)) {
      const s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const r = cachedByMtime(f, s.mtimeMs, parse);
      if (!r) continue;
      const proj = path.basename(path.dirname(path.dirname(f)));
      out.push(session({ id: r.id, source: 'gemini', project: /^[0-9a-f]{32,}$/.test(proj) ? '' : proj, prompt: r.prompt,
        model: r.model || 'gemini', mtime: s.mtimeMs, activity: r.activity, tokOut: r.out, tokIn: r.inn, ctx: r.ctx, ctxMax: r.ctx ? 1e6 : 0, today: r.today }));
    }
    return out;
  },
};

import path from 'node:path';
import { appData, ls, stat, recent, readJson, cachedByMtime, midnight, session } from './_lib.mjs';

// Cline (and its fork Roo Code) keep one folder per task in the editor's globalStorage.
const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];
const EXTENSIONS = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline'];

function taskDirs() {
  const out = [];
  for (const ed of EDITORS) for (const ext of EXTENSIONS) {
    const root = path.join(appData(), ed, 'User', 'globalStorage', ext, 'tasks');
    for (const e of ls(root)) if (e.isDirectory()) out.push({ dir: path.join(root, e.name), id: e.name, editor: ed });
  }
  return out;
}

const json = s => { try { return JSON.parse(s); } catch { return null; } };

function parse(file) {
  const msgs = readJson(file);
  if (!Array.isArray(msgs)) return null;
  const mid = midnight();
  let prompt = '', activity = '', out = 0, inn = 0, today = 0, ctx = 0;
  for (const m of msgs) {
    if (m.say === 'task' && !prompt) prompt = m.text || '';
    else if (m.say === 'api_req_started') {
      const r = json(m.text) || {};
      out += r.tokensOut || 0; inn += r.tokensIn || 0;
      if ((m.ts || 0) >= mid) today += r.tokensOut || 0;
      const c = (r.tokensIn || 0) + (r.cacheWrites || 0) + (r.cacheReads || 0);
      if (c) ctx = c;
    } else if (m.say === 'tool' || m.ask === 'tool') { const t = json(m.text); activity = 'Tool: ' + (t?.tool || 'tool'); }
    else if (m.say === 'command' || m.ask === 'command') activity = 'Running: ' + (m.text || '');
    else if (m.say === 'text' && m.text) activity = m.text;
    else if (m.ask === 'completion_result' || m.say === 'completion_result') activity = 'Task complete';
  }
  return { prompt, activity, out, inn, today, ctx };
}

export default {
  id: 'cline',
  label: 'Cline',
  sessions() {
    const out = [];
    for (const t of taskDirs()) {
      const f = path.join(t.dir, 'ui_messages.json'), s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const r = cachedByMtime(f, s.mtimeMs, parse);
      if (!r) continue;
      const meta = readJson(path.join(t.dir, 'task_metadata.json'));
      const model = meta?.model_usage?.at?.(-1)?.model_id || 'cline';
      out.push(session({ id: t.id, source: 'cline', project: t.editor, prompt: r.prompt, model, mtime: s.mtimeMs,
        activity: r.activity, tokOut: r.out, tokIn: r.inn, ctx: r.ctx, ctxMax: r.ctx ? 2e5 : 0, today: r.today }));
    }
    return out;
  },
};

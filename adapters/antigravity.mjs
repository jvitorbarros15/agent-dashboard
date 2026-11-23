import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, DAY, sqlite, dropDb, stat, cachedByMtime, session } from './_lib.mjs';

// Antigravity (the IDE agent and the agy CLI) keeps a summary row per conversation, plus one SQLite file per conversation.
const ROOTS = ['antigravity', 'antigravity-cli'].map(d => path.join(HOME, '.gemini', d));
const summaries = root => path.join(root, 'conversation_summaries.db');
const at = v => { const t = Date.parse(String(v || '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')); return t > 0 ? t : 0; };
const cwdOf = uris => { try { const u = JSON.parse(uris)[0]; return u ? fileURLToPath(decodeURIComponent(u).replace(/^file:\/\/\/([a-z]):/i, (m, d) => `file:///${d.toUpperCase()}:`)) : ''; } catch { return ''; } };

// The model isn't in the summary. Generation metadata lists every offered model, but turns that name only one are the model in use.
async function modelOf(root, id) {
  const f = path.join(root, 'conversations', id + '.db'), s = stat(f);
  if (!s) return '';
  const { DatabaseSync } = await import('node:sqlite');
  return cachedByMtime(f, s.mtimeMs, () => {
    let db;
    try {
      db = new DatabaseSync(f, { readOnly: true });
      const count = new Map();
      let first = '';
      for (const r of db.prepare('select data from gen_metadata order by idx desc limit 8').all()) {
        const names = [...new Set(Buffer.from(r.data).toString('latin1').match(/gemini-[0-9][\w.-]*/g) || [])];
        if (!first && names.length) first = names.at(-1);
        if (names.length === 1) count.set(names[0], (count.get(names[0]) || 0) + 1);
      }
      return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || first;
    } catch { return ''; } finally { try { db?.close(); } catch {} }
  });
}

export default {
  id: 'antigravity',
  label: 'Antigravity',
  detect: () => ROOTS.some(r => !!stat(summaries(r))),
  async sessions() {
    const byId = new Map();
    for (const root of ROOTS) {
      const f = summaries(root);
      if (!stat(f)) continue;
      try {
        const db = await sqlite(f);
        for (const r of db.prepare('select conversation_id id,title,preview,step_count,last_modified_time,workspace_uris,status,parent_conversation_id parent from conversation_summaries').all()) {
          const mtime = at(r.last_modified_time);
          if (Date.now() - mtime > DAY) continue;
          const prev = byId.get(r.id);
          if (!prev || prev.mtime < mtime) byId.set(r.id, { ...r, mtime, root });
        }
      } catch (e) { dropDb(f); throw e; }
    }
    const out = [];
    for (const r of byId.values()) {
      const cwd = cwdOf(r.workspace_uris), running = /RUNNING/.test(r.status);
      out.push(session({
        id: 'agy:' + r.id, parent: r.parent ? 'agy:' + r.parent : null, source: 'antigravity', project: cwd ? path.basename(cwd) : '', cwd,
        name: r.title || r.preview, prompt: r.preview, model: await modelOf(r.root, r.id) || 'gemini', mtime: r.mtime,
        activity: running ? 'Working' : `${r.step_count} steps`, ...(running && { status: 'active' }),
      }));
    }
    return out;
  },
};

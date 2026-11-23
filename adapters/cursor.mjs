import fs from 'node:fs';
import path from 'node:path';
import { appData, DAY, sqlite, dropDb, session } from './_lib.mjs';

// Cursor's agent chats ("composers") live in a SQLite key-value table. Opened read-only.
const DB = path.join(appData(), 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const tokCache = new Map();
function tokens(db, id, updated) {
  const c = tokCache.get(id);
  if (c && c.u === updated) return c.v;
  const v = db.prepare(`select coalesce(sum(json_extract(value,'$.tokenCount.outputTokens')),0) o, coalesce(sum(json_extract(value,'$.tokenCount.inputTokens')),0) i
    from cursorDiskKV where key >= ? and key < ?`).get(`bubbleId:${id}:`, `bubbleId:${id};`);
  tokCache.set(id, { u: updated, v });
  return v;
}

function projectOf(c) {
  const uri = Object.keys(c.codeBlockData || c.originalFileStates || {})[0];
  if (!uri) return '';
  try { return path.dirname(decodeURIComponent(new URL(uri).pathname)).split('/').filter(Boolean).slice(-2).join('/'); } catch { return ''; }
}

async function composers(where, arg) {
  const db = await sqlite(DB);
  const rows = db.prepare(`select value from cursorDiskKV where key like 'composerData:%' and json_extract(value,'$.lastUpdatedAt') ${where} ?`).all(arg);
  return { db, all: rows.map(r => { try { return JSON.parse(r.value); } catch { return null; } }).filter(Boolean) };
}

export default {
  id: 'cursor',
  label: 'Cursor',
  detect: () => fs.existsSync(DB),
  async archive() {
    if (!fs.existsSync(DB)) return [];
    try {
      const { db, all } = await composers('<', Date.now() - 30 * DAY);
      return all.map(c => {
        const t = tokens(db, c.composerId, c.lastUpdatedAt);
        return session({ id: c.composerId, source: 'cursor', project: projectOf(c), name: c.name, prompt: c.name,
          model: c.modelConfig?.modelName || 'cursor', mtime: c.lastUpdatedAt, activity: c.subtitle || 'Abandoned',
          tokOut: t.o, tokIn: t.i, status: 'abandoned' });
      });
    } catch (e) { dropDb(DB); throw e; }
  },
  async sessions() {
    if (!fs.existsSync(DB)) return [];
    try {
      const { db, all: rows } = await composers('>', Date.now() - DAY);
      const all = rows.filter(c => !c.isArchived);
      const parentOf = new Map();
      for (const c of all) for (const sub of c.subComposerIds || []) parentOf.set(sub, c.composerId);
      return all.map(c => {
        const t = tokens(db, c.composerId, c.lastUpdatedAt);
        const pct = typeof c.contextUsagePercent === 'number' ? c.contextUsagePercent : 0;
        return session({
          id: c.composerId, parent: parentOf.get(c.composerId) || null, source: 'cursor', project: projectOf(c),
          name: c.name, prompt: c.name, model: c.modelConfig?.modelName || 'cursor', mtime: c.lastUpdatedAt,
          status: c.status === 'generating' ? 'active' : undefined,
          activity: c.status === 'generating' ? 'Generating...' : c.subtitle || (c.status === 'completed' ? 'Done' : 'Waiting'),
          tokOut: t.o, tokIn: t.i, ctx: pct, ctxMax: pct ? 100 : 0, ctxPctOnly: true,
        });
      });
    } catch (e) { dropDb(DB); throw e; }
  },
};

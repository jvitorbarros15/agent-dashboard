import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, DAY, sqlite, dropDb, stat, midnight, addUsage, session } from './_lib.mjs';

// Antigravity (the IDE agent and the agy CLI) keeps a summary row per conversation in conversation_summaries.db,
// and every step of a conversation in conversations/<id>.db. Step rows hold protobuf blobs; the field numbers
// below come from the descriptors embedded in agy.exe.
const ROOTS = ['antigravity', 'antigravity-cli'].map(d => path.join(HOME, '.gemini', d));
const summaries = root => path.join(root, 'conversation_summaries.db');
const at = v => { const t = Date.parse(String(v || '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')); return t > 0 ? t : 0; };
const cwdOf = uris => { try { const u = JSON.parse(uris)[0]; return u ? fileURLToPath(decodeURIComponent(u).replace(/^file:\/\/\/([a-z]):/i, (m, d) => `file:///${d.toUpperCase()}:`)) : ''; } catch { return ''; } };

const STEP = { USER_INPUT: 14, PLANNER_RESPONSE: 15, RUN_COMMAND: 21, ASK_QUESTION: 138 };
const STATUS = { DONE: 3, WAITING: 9 };
const CTX_MAX = 1048576;

// Minimal protobuf reader: field number -> list of values (numbers, or Buffers for length-delimited fields).
function pb(buf) {
  const out = {}; let i = 0;
  const varint = () => { let v = 0, s = 1, c; do { c = buf[i++]; v += (c & 127) * s; s *= 128; } while (c & 128 && i < buf.length); return v; };
  try {
    while (i < buf.length) {
      const k = varint(), f = Math.floor(k / 8), t = k & 7; let v;
      if (t === 0) v = varint();
      else if (t === 2) { const l = varint(); v = buf.subarray(i, i + l); i += l; }
      else if (t === 1) { i += 8; continue; }
      else if (t === 5) { i += 4; continue; }
      else break;
      (out[f] ||= []).push(v);
    }
  } catch {}
  return out;
}
const msg = (o, f) => o[f]?.[0] ? pb(Buffer.from(o[f][0])) : {};
const num = (o, f) => typeof o[f]?.[0] === 'number' ? o[f][0] : 0;
const str = (o, f) => o[f]?.[0] ? Buffer.from(o[f][0]).toString('utf8') : '';

// Re-read a conversation only when its files change. Usage lives on planner responses: metadata field 9 holds
// 2 = fresh input, 5 = cached input, 3 = output (thinking included). Field 1.1 is the step time in seconds.
const convCache = new Map();
async function readConversation(id) {
  const f = ROOTS.map(r => path.join(r, 'conversations', id + '.db')).find(x => stat(x)), a = f && stat(f);
  if (!a) return null;
  const key = a.mtimeMs + ':' + (stat(f + '-wal')?.mtimeMs || 0) + ':' + (stat(f + '-shm')?.mtimeMs || 0);
  const hit = convCache.get(f);
  if (hit && hit.key === key) return hit.v;
  try {
    const db = await sqlite(f);
    let model = '';
    const g = db.prepare('select data from gen_metadata order by idx desc limit 1').get();
    if (g) model = str(msg(pb(Buffer.from(g.data)), 3), 28);
    const st = { out: 0, freshIn: 0, cr: 0, cw: 0, today: 0, hours: {}, beats: [] }, mid = midnight();
    let ctx = 0;
    for (const r of db.prepare('select metadata from steps where step_type = ? order by idx').all(STEP.PLANNER_RESPONSE)) {
      const m = pb(Buffer.from(r.metadata)), u = msg(m, 9);
      const out = num(u, 3), fresh = num(u, 2), cached = num(u, 5);
      if (!out && !fresh && !cached) continue;
      addUsage(st, num(msg(m, 1), 1) * 1000, model, [out, fresh, cached, 0], 1, mid);
      ctx = fresh + cached + out;
    }
    let needs = null, activity = '';
    for (const r of db.prepare('select step_type, status, metadata from steps order by idx desc limit 20').all()) {
      const m = pb(Buffer.from(r.metadata)), since = num(msg(m, 1), 1) * 1000, tool = str(msg(m, 4), 2);
      if (!activity && tool) activity = 'Tool: ' + tool;
      if (r.step_type === STEP.USER_INPUT) break;
      if (!needs && r.status === STATUS.WAITING)
        needs = r.step_type === STEP.ASK_QUESTION ? { kind: 'question', detail: 'Asked you a question', since }
          : { kind: 'approval', detail: `${tool || (r.step_type === STEP.RUN_COMMAND ? 'run_command' : 'A step')} is waiting for your approval`, since };
    }
    const v = { model, st, ctx, needs, activity };
    convCache.set(f, { key, v });
    return v;
  } catch (e) { dropDb(f); return null; }
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
          if (!prev || prev.mtime < mtime) byId.set(r.id, { ...r, mtime });
        }
      } catch (e) { dropDb(f); throw e; }
    }
    const out = [];
    for (const r of byId.values()) {
      const cwd = cwdOf(r.workspace_uris), busy = /RUNNING|BUSY/.test(r.status), c = await readConversation(r.id);
      out.push(session({
        id: 'agy:' + r.id, parent: r.parent ? 'agy:' + r.parent : null, source: 'antigravity', project: cwd ? path.basename(cwd) : '', cwd,
        name: r.title || r.preview, prompt: r.preview, model: c?.model || 'gemini', mtime: r.mtime,
        activity: c?.needs ? c.needs.detail : busy ? c?.activity || 'Working' : `${r.step_count} steps`,
        ...(busy && { status: 'active' }),
        ...(c && { tokOut: c.st.out, tokIn: c.st.freshIn, cacheRead: c.st.cr, today: c.st.today, hours: c.st.hours, beats: c.st.beats, ctx: c.ctx, ctxMax: c.ctx ? CTX_MAX : 0 }),
        ...(c?.needs && { needsYou: c.needs }),
      }));
    }
    return out;
  },
};

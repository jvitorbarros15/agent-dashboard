import fs from 'node:fs';
import path from 'node:path';
import { HOME, DAY, sqlite, dropDb, session } from './_lib.mjs';

const DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

export default {
  id: 'opencode',
  label: 'OpenCode',
  async sessions() {
    if (!fs.existsSync(DB)) return [];
    try {
      const db = await sqlite(DB);
      const rows = db.prepare('select id,title,slug,model,tokens_input,tokens_output,tokens_cache_read,time_updated from session_v2 where time_updated > ? and parent_id is null order by time_updated desc limit 12').all(Date.now() - DAY);
      return rows.map(r => {
        let m = ''; try { m = JSON.parse(r.model).id; } catch {}
        return session({ id: r.id, source: 'opencode', name: r.title || r.slug, model: m || 'opencode', mtime: r.time_updated,
          activity: 'OpenCode session', tokOut: r.tokens_output, tokIn: r.tokens_input + r.tokens_cache_read });
      });
    } catch (e) { dropDb(DB); throw e; }
  },
};

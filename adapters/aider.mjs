import fs from 'node:fs';
import path from 'node:path';
import { HOME, stat, recent, ls, cachedByMtime, midnight, session } from './_lib.mjs';

// Aider writes .aider.chat.history.md into each repo it runs in, so there is no central folder.
// Repos are found by scanning a few likely roots two levels deep (override with AGENT_PARTY_AIDER_DIRS).
const FILE = '.aider.chat.history.md';
const ROOTS = (process.env.AGENT_PARTY_AIDER_DIRS || '').split(path.delimiter).filter(Boolean);
const DEFAULT_ROOTS = [HOME, ...['dev', 'code', 'projects', 'src', 'repos', 'work', 'Documents', 'Desktop'].map(d => path.join(HOME, d)),
  ...(process.platform === 'win32' ? ['C:\\dev', 'C:\\code', 'C:\\projects'] : [])];

let found = [], scannedAt = 0;
function discover() {
  if (Date.now() - scannedAt < 5 * 60e3) return found;
  scannedAt = Date.now();
  const roots = ROOTS.length ? ROOTS : DEFAULT_ROOTS, hits = new Set();
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, FILE))) hits.add(path.join(dir, FILE));
    if (depth === 0) return;
    for (const e of ls(dir)) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth - 1);
  };
  for (const r of roots) visit(r, 2);
  return (found = [...hits]);
}

const num = s => { const m = /([\d.]+)\s*([kKmM]?)/.exec(s || ''); return m ? +m[1] * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1) : 0; };

function parse(file) {
  const size = stat(file).size, fd = fs.openSync(file, 'r');
  const len = Math.min(size, 2 << 20), buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const text = buf.toString('utf8'), start = text.lastIndexOf('# aider chat started at ');
  const block = start >= 0 ? text.slice(start) : text, mid = midnight();
  const started = Date.parse((/# aider chat started at (.+)/.exec(block) || [])[1]) || 0;
  let prompt = '', activity = '', model = '', out = 0, inn = 0, ctx = 0;
  for (const line of block.split('\n')) {
    if (line.startsWith('#### ')) { const t = line.slice(5).trim(); if (!prompt && !t.startsWith('/')) prompt = t; activity = 'Asked: ' + t; }
    let m;
    if ((m = /^> (?:Main )?[Mm]odel: (\S+)/.exec(line))) model = m[1];
    if ((m = /^> Tokens: ([\d.]+\s*[kKmM]?) sent, ([\d.]+\s*[kKmM]?) received/.exec(line))) { inn += num(m[1]); out += num(m[2]); ctx = num(m[1]); }
    else if ((m = /^> Applied edit to (.+)/.exec(line))) activity = 'Edited ' + m[1];
    else if ((m = /^> Commit \w+ (.+)/.exec(line))) activity = 'Committed: ' + m[1];
  }
  return { prompt, activity, model, out, inn, ctx, today: started >= mid ? out : 0, started };
}

export default {
  id: 'aider',
  label: 'Aider',
  sessions() {
    const out = [];
    for (const f of discover()) {
      const s = stat(f);
      if (!s || !recent(s.mtimeMs)) continue;
      const r = cachedByMtime(f, s.mtimeMs, parse);
      const repo = path.dirname(f);
      out.push(session({ id: 'aider:' + repo + ':' + r.started, source: 'aider', project: path.basename(repo), prompt: r.prompt,
        model: r.model || 'aider', mtime: s.mtimeMs, activity: r.activity, tokOut: r.out, tokIn: r.inn, ctx: r.ctx, ctxMax: 0, today: r.today }));
    }
    return out;
  },
};

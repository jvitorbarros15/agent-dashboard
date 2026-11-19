import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// USD per million tokens, Anthropic first-party API rates (docs cached 2026-11-03).
// cacheWrite defaults to 1.25x input (5-minute cache), cacheRead to 0.1x input unless the docs list a rate.
// Add or override any model in ~/.agent-party/pricing.json, e.g. {"gpt-5.1-codex": {"input": 1.25, "output": 10}}
const DEFAULTS = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const USER_FILE = path.join(os.homedir(), '.agent-party', 'pricing.json');
let table = null, userMtime = -1;
function load() {
  let m = 0; try { m = fs.statSync(USER_FILE).mtimeMs; } catch {}
  if (table && m === userMtime) return table;
  let user = {};
  try { user = JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch {}
  const all = { ...DEFAULTS };
  for (const [k, v] of Object.entries(user)) if (v && typeof v.input === 'number' && typeof v.output === 'number') all[k.toLowerCase()] = v;
  table = Object.entries(all).map(([k, v]) => [k, { input: v.input, output: v.output, cacheWrite: v.cacheWrite ?? v.input * 1.25, cacheRead: v.cacheRead ?? v.input * 0.1 }])
    .sort((a, b) => b[0].length - a[0].length);
  userMtime = m;
  return table;
}

const priceCache = new Map();
export function priceOf(model) {
  const m = String(model || '').toLowerCase().replace(/\[.*?\]$/, '').replace(/^anthropic[/.]/, '');
  const t = load();
  if (priceCache.get(m)?.t === t) return priceCache.get(m).p;
  const hit = t.find(([k]) => m === k || m.startsWith(k + '-') || m.startsWith(k + '@'));
  const p = hit ? hit[1] : null;
  priceCache.set(m, { t, p });
  return p;
}

// v = [output, freshInput, cacheRead, cacheWrite]
export function usd(model, v) {
  const p = priceOf(model);
  if (!p) return null;
  return (v[0] * p.output + v[1] * p.input + v[2] * p.cacheRead + v[3] * p.cacheWrite) / 1e6;
}

// hours: {"<hourIndex>|<model>": [out, in, cacheRead, cacheWrite]}
export function costOfHours(hours, sinceHour = 0) {
  let total = 0, priced = false, unpriced = false;
  for (const [key, v] of Object.entries(hours || {})) {
    const i = key.indexOf('|');
    if (+key.slice(0, i) < sinceHour) continue;
    const c = usd(key.slice(i + 1), v);
    if (c == null) { if (v[0] || v[1]) unpriced = true; } else { total += c; priced = true; }
  }
  return { usd: priced ? total : null, unpriced };
}

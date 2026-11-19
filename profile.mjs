import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hall of Fame: lifetime XP per model and achievements. Kept in our own file because tools delete old transcripts.
const FILE = path.join(os.homedir(), '.agent-party', 'profile.json');
const load = () => { try { const p = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { days: p.days || {}, unlocked: p.unlocked || {} }; } catch { return { days: {}, unlocked: {} }; } };
const profile = load();
const save = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(profile)); } catch (e) { console.warn('profile:', e.message); } };

const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const skipModel = m => !m || m === '?' || m.startsWith('<');
export const xpOf = out => Math.floor(out / 1000);
export const levelOf = xp => Math.min(99, Math.floor(Math.sqrt(xp / 25)) + 1);
const xpFor = lvl => 25 * (lvl - 1) ** 2;

export const ACHIEVEMENTS = [
  { id: 'first', name: 'FIRST QUEST', desc: 'An agent did its first work', icon: 'sword' },
  { id: 'night', name: 'NIGHT OWL', desc: 'Agents working between midnight and 4 AM', icon: 'moon' },
  { id: 'dawn', name: 'EARLY BIRD', desc: 'Agents working between 5 and 7 AM', icon: 'sun' },
  { id: 'million', name: 'MILLION CLUB', desc: '1,000,000 output tokens in one day', icon: 'gem' },
  { id: 'hoard', name: "DRAGON'S HOARD", desc: '$100 of work in one day at API prices', icon: 'coin' },
  { id: 'polyglot', name: 'POLYGLOT', desc: 'Three different tools in one day', icon: 'scroll' },
  { id: 'streak', name: 'SEVEN DAYS', desc: 'Agents worked 7 days in a row', icon: 'flame' },
  { id: 'veteran', name: 'VETERAN', desc: '30 days with agent work', icon: 'shield' },
  { id: 'party', name: 'FULL PARTY', desc: '5 sessions active at the same time', icon: 'crown' },
  { id: 'swarm', name: 'SWARM', desc: '10 subagents under one session', icon: 'bee' },
  { id: 'marathon', name: 'MARATHON', desc: 'One session working across 6 different hours', icon: 'boot' },
  { id: 'legend', name: 'LEGEND', desc: 'A model reached level 50', icon: 'star' },
];

// Folds 30-day history rows into the lifetime ledger. Max per day and model, so a day whose
// transcripts were partly cleaned up never loses what was already counted.
export function absorbHistory(h, sources) {
  if (!h?.rows) return;
  const fresh = {};
  for (const [ms, mi, pi, out, , , , usd] of h.rows) {
    const k = dayKey(ms), d = fresh[k] ||= { models: {}, hours: Array(24).fill(0), usd: 0, sources: [] };
    const m = h.models[mi]; if (!skipModel(m)) d.models[m] = (d.models[m] || 0) + out;
    d.hours[new Date(ms).getHours()] += out; if (usd > 0) d.usd += usd;
    const src = h.projects[pi]?.source || sources?.[pi]; if (src && !d.sources.includes(src)) d.sources.push(src);
  }
  for (const [k, d] of Object.entries(fresh)) {
    const o = profile.days[k];
    if (!o) { profile.days[k] = d; continue; }
    for (const [m, v] of Object.entries(d.models)) o.models[m] = Math.max(o.models[m] || 0, v);
    o.hours = o.hours.map((v, i) => Math.max(v, d.hours[i])); o.usd = Math.max(o.usd, d.usd);
    for (const s of d.sources) if (!o.sources.includes(s)) o.sources.push(s);
  }
  save();
}

function levels() {
  const tot = {};
  for (const d of Object.values(profile.days)) for (const [m, v] of Object.entries(d.models)) tot[m] = (tot[m] || 0) + v;
  const out = {};
  for (const [m, t] of Object.entries(tot)) {
    const xp = xpOf(t), level = levelOf(xp);
    out[m] = { xp, level, cur: xp - xpFor(level), need: xpFor(level + 1) - xpFor(level), tokens: t };
  }
  return out;
}

// Checks every achievement against the ledger and the live sessions. Unlocks are permanent.
export function checkAchievements(sessions) {
  const days = Object.entries(profile.days).filter(([, d]) => Object.values(d.models).some(v => v > 0)).sort(([a], [b]) => a < b ? -1 : 1);
  const lv = levels(), got = {};
  const dayOut = d => Object.values(d.models).reduce((a, v) => a + v, 0);
  got.first = days.length > 0;
  got.night = days.some(([, d]) => d.hours.slice(0, 4).some(v => v > 0));
  got.dawn = days.some(([, d]) => d.hours.slice(5, 7).some(v => v > 0));
  got.million = days.some(([, d]) => dayOut(d) >= 1e6);
  got.hoard = days.some(([, d]) => d.usd >= 100);
  got.polyglot = days.some(([, d]) => d.sources.length >= 3);
  got.veteran = days.length >= 30;
  let run = 0, prev = null;
  for (const [k] of days) { const t = new Date(k + 'T12:00').getTime(); run = prev && t - prev < 1.5 * 864e5 ? run + 1 : 1; prev = t; if (run >= 7) got.streak = true; }
  got.party = sessions.filter(s => !s.parent && s.status === 'active').length >= 5;
  const kids = {}; for (const s of sessions) if (s.parent) kids[s.parent] = (kids[s.parent] || 0) + 1;
  got.swarm = Object.values(kids).some(n => n >= 10);
  got.marathon = sessions.some(s => (s.hourSpan || 0) >= 6);
  got.legend = Object.values(lv).some(l => l.level >= 50);
  let changed = false;
  for (const a of ACHIEVEMENTS) if (got[a.id] && !profile.unlocked[a.id]) { profile.unlocked[a.id] = Date.now(); changed = true; }
  if (changed) save();
  return lv;
}

export function profileState(sessions) {
  const lv = checkAchievements(sessions);
  return { levels: lv, achievements: achievementList() };
}
export const achievementList = () => ACHIEVEMENTS.map(a => ({ ...a, at: profile.unlocked[a.id] || 0 }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// --install-hooks / --uninstall-hooks: the only time Agent Party edits another tool's file,
// and only when asked, with a backup and a confirmation.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.join(os.homedir(), '.agent-party', 'hook.mjs');
const ours = h => /[\\/]\.agent-party[\\/]hook\.mjs/.test(String(h?.command || ''));

async function confirm(q) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q); rl.close();
  return /^y(es)?$/i.test(a.trim());
}
function write(settings) {
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.agent-party-backup-${Date.now()}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`Backup saved: ${backup}`);
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

export async function runHooks(install, { port, yes }) {
  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
    catch (e) { console.error(`Can't parse ${SETTINGS} (${e.message}). Nothing changed.`); return 1; }
  }
  const groups = settings.hooks?.PermissionRequest || [];
  const installed = groups.some(g => (g.hooks || []).some(ours));

  if (install) {
    fs.mkdirSync(path.dirname(HOOK), { recursive: true });
    fs.copyFileSync(path.join(HERE, 'hook.mjs'), HOOK);
    const command = `node "${HOOK.replace(/\\/g, '/')}" --port ${port}`;
    if (installed) {
      const h = groups.flatMap(g => g.hooks || []).find(ours);
      if (h.command === command) { console.log(`The approval hook is already in ${SETTINGS}. Updated ${HOOK}.`); return 0; }
      h.command = command; write(settings);
      console.log(`Updated the approval hook to use port ${port}.`); return 0;
    }
    const entry = { matcher: '*', hooks: [{ type: 'command', command, timeout: 120 }] };
    console.log(`This adds a PermissionRequest hook to ${SETTINGS}:\n\n${JSON.stringify({ hooks: { PermissionRequest: [entry] } }, null, 2)}\n
When Claude Code is about to ask for permission and the dashboard is open, the request appears there
with APPROVE and DENY. If the dashboard is closed or doesn't answer, Claude Code asks in the terminal
as usual. Remove it any time with --uninstall-hooks.\n`);
    if (!yes && !await confirm('Add it? [y/N] ')) { console.log('Nothing changed. (Pass --yes to skip this question.)'); return 0; }
    settings.hooks ||= {};
    settings.hooks.PermissionRequest = [...groups, entry];
    write(settings);
    console.log('Installed. Restart running Claude Code sessions to pick it up.');
    return 0;
  }

  if (!installed) { console.log(`No Agent Party hook found in ${SETTINGS}. Nothing changed.`); return 0; }
  const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !ours(h)) })).filter(g => g.hooks.length);
  if (kept.length) settings.hooks.PermissionRequest = kept; else delete settings.hooks.PermissionRequest;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  write(settings);
  try { fs.unlinkSync(HOOK); } catch {}
  console.log('Removed the approval hook.');
  return 0;
}

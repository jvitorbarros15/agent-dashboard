#!/usr/bin/env node
// Claude Code PermissionRequest hook, installed by `agent-party-dashboard --install-hooks`.
// Sends the request to the local dashboard and waits for APPROVE or DENY. Any failure or silence
// prints nothing, and Claude Code falls back to its normal prompt in the terminal.
import http from 'node:http';

const i = process.argv.indexOf('--port'), port = +(i > 0 && process.argv[i + 1]) || 4300;
const TERMINAL_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode']);

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let input; try { input = JSON.parse(raw); } catch { return; }
  if (TERMINAL_ONLY.has(input.tool_name)) return;
  const body = JSON.stringify({ session_id: input.session_id, cwd: input.cwd, tool_name: input.tool_name, tool_input: input.tool_input, suggestions: input.permission_suggestions || [] });
  const req = http.request({ host: '127.0.0.1', port, path: '/api/approvals', method: 'POST', timeout: 115e3,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    let out = '';
    res.on('data', c => { out += c; });
    res.on('end', () => {
      try {
        const d = JSON.parse(out).decision;
        if (d?.behavior === 'allow' || d?.behavior === 'deny') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } }));
      } catch {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
});

# AGENTS.md

Notes for coding agents working on Agent Party (`agent-party-dashboard` on npm).

## What this is

A pixel-art RPG dashboard that shows local AI coding agent sessions (Claude Code, Codex, Cursor, Gemini CLI, Cline, Aider, OpenCode), their subagents, context, tokens and machine load. Zero dependencies: plain Node and one HTML file.

| Where | What |
| :-- | :-- |
| GitHub | https://github.com/jvitorbarros15/agent-dashboard (public, branch `main`) |
| npm | https://www.npmjs.com/package/agent-party-dashboard (`npx agent-party-dashboard`) |
| Vercel | https://agent-dashboard-pi-seven.vercel.app (static UI, demo data only) |

## Layout

| Path | Role |
| :-- | :-- |
| `server.mjs` | CLI entry (`bin`), loads adapters, samples CPU/GPU/Ollama, serves `/` and `/api/state` on 127.0.0.1:4300 |
| `index.html` | The whole UI: rendering, demo data generator, customize dialog, keyboard shortcuts |
| `pricing.mjs` | USD per million tokens for Claude models (from Anthropic's published rates). Update it when prices change; users override in `~/.agent-party/pricing.json` |
| `watch.mjs` | Watchtower: turns per-session signals into needs-you, stuck, file-clash and context/plan forecasts |
| `notify.mjs` | Native desktop notifications (PowerShell toast, osascript, notify-send) for budget alerts |
| `profile.mjs` | Hall of Fame: lifetime XP per model (ledger in `~/.agent-party/profile.json`) and achievements |
| `hook.mjs` | Claude Code PermissionRequest hook. Copied to `~/.agent-party/hook.mjs` by `--install-hooks`; posts to `/api/approvals` and waits |
| `hooks.mjs` | `--install-hooks` / `--uninstall-hooks`: edits `~/.claude/settings.json` after confirmation, with a backup |
| `icons/`, `manifest.webmanifest` | Home screen icon and web app manifest. Served by the server and deployed to Vercel |
| `vizier.mjs` | The Vizier: daily Quest report (sessions + `git log` per repo) and per-project spend for budgets |
| `adapters/*.mjs` | One file per tool. Contract in `ADAPTERS.md`. `_lib.mjs` holds shared helpers |
| `assets/` | README images only. Not shipped to npm or Vercel |
| `.vercelignore` | Allowlist: only `index.html`, `vercel.json`, `manifest.webmanifest` and `icons/` get deployed |
| `package.json` `files` | Allowlist of what goes to npm |

## Run and check

```bash
node server.mjs --no-open            # real data on http://127.0.0.1:4300
# open http://127.0.0.1:4300/?demo   # simulated data, same as Vercel
node server.mjs --help
npm pack --dry-run                   # list exactly what npm would ship (25 files)
```

There is no test suite. Verify UI changes in a browser (Playwright is installed globally on the owner's machine). Test adapters for tools that aren't installed by writing sample files into a fake home: `HOME=/tmp/fake USERPROFILE=/tmp/fake APPDATA=/tmp/fake/AppData/Roaming node server.mjs --port 4311 --no-open`.

## Shipping a change

1. Edit, then commit and push to `main`.
2. **npm:** `npm version patch` (or `minor` / `major`). This bumps `package.json`, commits and tags. Then `git push --follow-tags` and `npm publish`.
   - Publishing requires 2FA. npm prints an auth URL and asks to press Enter to open the browser. **The owner must approve it in their browser**, so let them run `npm publish` themselves, or pass `--otp=<code>` only if they give you a fresh code.
   - New versions take about a minute to show up. Check with `npm view agent-party-dashboard version` before testing `npx agent-party-dashboard`.
3. **Vercel** (only if `index.html` or `vercel.json` changed): `vercel deploy --prod --yes` from the repo root. The project is already linked via `.vercel/` (git-ignored). Use plain `vercel deploy --yes` for a preview first when the change is risky.

## Rules

- **Commit messages**: imperative, sentence case, no period, no prefixes (`Add X`, `Fix X`, `Update X`, `Remove X`). No `Co-Authored-By` lines.
- **Never ship private data.** Real sessions contain the owner's prompts and project names. README images and anything on Vercel must come from demo mode (`?demo`). The root `screenshot.png` shows real sessions and is git-ignored on purpose.
- **Never widen CORS to `*`.** The local API is private. Hosted copies get access only through `DASHBOARD_ORIGINS`.
- **Adapters are read-only.** Never write to another tool's files, and open databases with `readOnly: true`. The only exception is `--install-hooks`, which the user runs and confirms.
- **Approvals and LAN stay locked down.** `/api/approvals` only accepts loopback requests without an `Origin`; `/api/approvals/decide` checks the origin; with `--lan` every non-loopback request needs a paired token. Test hook changes in a fake home, never on the owner's real `~/.claude/settings.json`.
- **Keep the pixel font sizes.** The 7–10px Press Start 2P labels are intentional (owner's decision). Design-lint warnings about them are suppressed in the git-ignored `.impeccable/` config.
- **Don't commit** `.impeccable/`, `.vercel/`, `screenshot.png` or `shot.cjs`. They're in `.gitignore`.
- Keep it dependency-free. If something needs a package, ask the owner first.

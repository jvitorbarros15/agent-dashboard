<div align="center">

<img src="assets/banner.svg" alt="Agent Party: monitor your AI coding agents like a party of adventurers" width="100%">

<br>

[![Live demo](https://img.shields.io/badge/LIVE_DEMO-agent--dashboard-ffcf40?style=for-the-badge&labelColor=14102a)](https://agent-dashboard-pi-seven.vercel.app)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-5be37d?style=for-the-badge&labelColor=14102a&logo=nodedotjs&logoColor=5be37d)](#quick-start)
[![Dependencies](https://img.shields.io/badge/dependencies-0-8b4fe0?style=for-the-badge&labelColor=14102a)](#how-it-works)
[![License](https://img.shields.io/badge/license-MIT-ff8a2a?style=for-the-badge&labelColor=14102a)](LICENSE)
[![Deploy](https://img.shields.io/badge/deployed_on-vercel-f2e6b8?style=for-the-badge&labelColor=14102a&logo=vercel&logoColor=f2e6b8)](https://agent-dashboard-pi-seven.vercel.app)

**A zero-dependency, pixel-art dashboard that shows every AI coding agent on your machine,<br>what it is doing right now, how much context it has left, and how hard your hardware is working.**

[Try the demo](https://agent-dashboard-pi-seven.vercel.app) · [Quick start](#quick-start) · [Features](#features) · [How it works](#how-it-works)

<br>

<img src="assets/demo.gif" alt="Agent Party in action: searching, filtering, and opening an agent's details" width="92%">

</div>

<br>

## Why

Running several Claude Code sessions, a handful of subagents and a Codex job at the same time gets hard to follow from terminal tabs. Agent Party reads the session logs those tools already write and turns them into one live screen: who is working, who is waiting for you, who is about to run out of context, and what each one is doing right now.

Each agent is a party member. Its **HP** is the context window it has left, its **MP** is the tokens it has produced, and its class comes from the model behind it.

| Class | Model | | Class | Model |
| :-- | :-- | :-: | :-- | :-- |
| 🟣 **Mage** | Claude Opus | | 🟡 **Sage** | Claude Fable |
| 🔵 **Knight** | Claude Sonnet | | 🩵 **Artificer** | GPT / Codex |
| 🟢 **Rogue** | Claude Haiku | | 🟠 **Beast** | Anything else (local models, OpenCode) |

## Features

<table>
<tr>
<td width="50%" valign="top">

**🗡️ Party view**
- Claude Code, Codex CLI and OpenCode sessions from the last 24 hours
- Subagents nested under the session that spawned them, collapsible per project
- Live activity bubble: the current tool call or the latest line of output
- Floating `+1.2k` token gains and a spawn animation when a subagent joins

**🔎 Find things fast**
- Search across titles, prompts, projects, models and session IDs
- Status filters with live counts: active, idle, sleeping
- Sort by status, recency, tokens or context pressure
- Filters and collapsed groups persist between visits

</td>
<td width="50%" valign="top">

**📜 Quest log and alerts**
- Running feed of agents joining, finishing a turn, waking up and going idle
- On-screen toasts, plus optional desktop notifications when an agent finishes while the tab is in the background
- Active agent count in the browser tab title

**🧭 Agent details**
- Click any card for the original prompt, model, context, tokens and last-seen time
- One-click copy of the session ID or the exact `claude --resume` / `codex resume` command

**🏰 Base panel**
- Claude plan usage for the 5-hour and weekly windows, with reset countdowns
- CPU, RAM, GPU and VRAM load, and the models Ollama has loaded

</td>
</tr>
</table>

<div align="center">
<img src="assets/screenshot.png" alt="Full dashboard with the party, base and quest log panels" width="49%">
<img src="assets/drawer.png" alt="Agent detail panel with prompt, stats and resume command" width="49%">
</div>

## Quick start

```bash
git clone https://github.com/jvitorbarros15/agent-dashboard.git
cd agent-dashboard
node server.mjs
```

Open **http://127.0.0.1:4300**. That's it: no `npm install`, no build step, no config.

> [!NOTE]
> Node 22.13 or newer is needed for OpenCode support (it uses the built-in `node:sqlite`). On older versions everything else still works and OpenCode is skipped.

### Connect the hosted dashboard to your machine

The [hosted copy](https://agent-dashboard-pi-seven.vercel.app) runs on simulated data, since a website can't read files on your computer. To point it at your real agents, allow its origin when you start the local server:

```bash
DASHBOARD_ORIGINS=https://agent-dashboard-pi-seven.vercel.app node server.mjs
```

Then click the **DEMO DATA** badge and choose **Connect**, or open `https://agent-dashboard-pi-seven.vercel.app/?api=http://127.0.0.1:4300`. Chrome asks once for permission to reach your local network.

> [!IMPORTANT]
> The local API only answers cross-origin requests from origins listed in `DASHBOARD_ORIGINS`. Other websites you visit can't read your session data.

## Keyboard shortcuts

| Key | Action | | Key | Action |
| :-: | :-- | :-: | :-: | :-- |
| <kbd>/</kbd> | Search | | <kbd>J</kbd> <kbd>K</kbd> | Select next / previous agent |
| <kbd>1</kbd>–<kbd>4</kbd> | All / active / idle / sleeping | | <kbd>Enter</kbd> | Open selected agent |
| <kbd>S</kbd> | Cycle sort order | | <kbd>Esc</kbd> | Close panel, clear search |
| <kbd>P</kbd> | Pause live updates | | <kbd>?</kbd> | Show all shortcuts |
| <kbd>N</kbd> | Toggle "agent finished" alerts | | | |

## How it works

```mermaid
flowchart LR
    subgraph disk["Your machine"]
        A["~/.claude/projects/**/*.jsonl<br/>Claude Code sessions + subagents"]
        B["~/.codex/sessions/**/*.jsonl<br/>Codex CLI rollouts"]
        C["opencode.db<br/>OpenCode (read-only SQLite)"]
        D["statusline-last.json<br/>Claude plan limits"]
        E["nvidia-smi · os · Ollama API<br/>machine load"]
    end
    A & B & C & D & E --> S["server.mjs<br/>incremental reader, port 4300"]
    S -- "/api/state every 2s" --> UI["index.html<br/>single-file UI"]
    V["Vercel"] -. "static UI + demo data" .-> UI
```

- **Incremental reads.** Log files are read from the last byte offset seen, so a 200 MB session costs nothing after the first pass.
- **Streaming-safe token counts.** Repeated chunks of the same streamed message replace each other instead of being added twice.
- **Read-only, local-only.** The server binds to `127.0.0.1`, never writes to any agent's files and opens the OpenCode database read-only.
- **Two files.** `server.mjs` and `index.html`, with no dependencies, no bundler and no framework.

<details>
<summary><b>Status rules</b></summary>

<br>

| Status | Meaning |
| :-- | :-- |
| `ACTIVE` | Session file written in the last 2 minutes |
| `IDLE` | Last write between 2 and 30 minutes ago, usually waiting for you |
| `SLEEPING` | Quiet for more than 30 minutes |

</details>

<details>
<summary><b>Claude plan limits</b></summary>

<br>

The 5-hour and weekly usage bars come from `~/.claude/statusline-last.json`. Have your Claude Code status line script save the JSON it receives on stdin to that file, and the panel fills in on the next refresh.

</details>

<details>
<summary><b>Deploy your own copy</b></summary>

<br>

The hosted version is just `index.html` served as a static file. With the Vercel CLI:

```bash
vercel deploy --prod
```

`.vercelignore` allowlists `index.html` and `vercel.json` only, so the server, local caches and screenshots never get uploaded. When the page can't find `/api/state` it switches to demo data. Add `?demo` to any URL to force demo mode.

</details>

<br>

<div align="center">
<sub>Built for people who run more agents than they have terminal tabs.</sub>
</div>

## License

[MIT](LICENSE). Use it, fork it, make your own party.

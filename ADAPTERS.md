# Writing an adapter

An adapter teaches Agent Party to read one more tool. It is a single `.mjs` file that returns the sessions it finds. The server calls it every 5 seconds and merges the results with every other adapter.

## Where adapters live

| Folder | Use it for |
| :-- | :-- |
| `adapters/` in this repo | Built-in adapters. Open a pull request to add one here. |
| `~/.agent-party/adapters/` | Your own adapters. Loaded on every start, survives `npx` updates. |

Files starting with `_` are skipped, so helpers like `_lib.mjs` can sit next to adapters. An adapter in your home folder with the same `id` as a built-in one replaces it. Turn any adapter off with `--disable <id>`.

## The contract

```js
// ~/.agent-party/adapters/mytool.mjs
export default {
  id: 'mytool',              // unique, lowercase; used for filters and --disable
  label: 'My Tool',          // shown in the UI
  resume: 'mytool resume {id}', // optional; {id} is the session, {lead} its parent or itself
  async sessions() {         // may be sync or async; throw to show a "not tracked" note
    return [ /* session objects */ ];
  },
};
```

Each session is a plain object:

| Field | Type | Meaning |
| :-- | :-- | :-- |
| `id` | string | Stable and unique across refreshes. **Required.** |
| `source` | string | Your adapter's `id`. **Required.** |
| `mtime` | ms epoch | Last activity. Drives active / idle / sleeping. **Required.** |
| `name` | string | Card title. Falls back to `prompt`. |
| `prompt` | string | The first user message, shown in the detail panel. |
| `model` | string | Model id, used to pick the class sprite. |
| `activity` | string | What it is doing now, e.g. `Tool: Edit`. |
| `parent` | string | Parent session `id`, which nests this one as a subagent. |
| `project` | string | Shown next to the group header. |
| `tokOut` / `tokIn` | number | Tokens produced / fresh tokens read. |
| `ctx` / `ctxMax` | number | Context used and window size. Leave `ctxMax` at 0 if unknown. |
| `ctxPctOnly` | boolean | Set when `ctx` / `ctxMax` are a percentage, not tokens. |
| `today` | number | Output tokens since local midnight, added to the header total. |
| `status` | string | Optional override: `active`, `idle` or `sleeping`. |

| `hours` | object | Optional usage per hour and model, `{"<hourIndex>\|<model>": [out, freshIn, cacheRead, cacheWrite]}` where `hourIndex = Math.floor(ms / 3600000)`. Enables cost estimates. `addUsage()` in `_lib.mjs` fills it. |
| `cacheRead` / `cacheWrite` | number | Cached input tokens read and written, shown in the detail panel. |

| `pending`, `calls`, `files`, `errStreak`, `askedAt`, `ctxHist` | various | Optional Watchtower signals: tool calls without a result, recent calls, edited files, failures in a row, when the agent ended on a question, and context size per turn. Use `watchState()`, `onToolUse()`, `onToolResult()` and `watchFields()` from `_lib.mjs`; `watch.mjs` turns them into "needs you", "stuck", file clashes and context forecasts. |

Return only sessions touched in the last 24 hours.

### Optional extras

| Method | Powers | Returns |
| :-- | :-- | :-- |
| `history(pause)` | The Chronicle (usage charts) | `[{ project, hours }]` for every session in the last 30 days. Call `await pause?.()` between files so the first scan doesn't block the server. |
| `archive()` | Black holes in Cosmos view | Sessions untouched for 30+ days, with `status: 'abandoned'`. The server keeps the 12 biggest. |

Costs come from `pricing.mjs`, matched on the model id. Users add prices for other models in `~/.agent-party/pricing.json`.

## Helpers

`adapters/_lib.mjs` has what the built-in adapters use. Import it with a relative path from inside `adapters/`, or copy what you need into your own file.

| Helper | Does |
| :-- | :-- |
| `session(o)` | Fills defaults, truncates text and computes `status` from `mtime`. |
| `readIncremental(file, size, ingest, mk)` | Reads only new lines of a growing log (JSONL). |
| `cachedByMtime(file, mtime, parse)` | Re-parses a file only when it changes. |
| `sqlite(file)` | Opens a SQLite database read-only (`node:sqlite`). |
| `walk(dir, pred)` / `ls(dir)` / `stat(f)` / `readJson(f)` | File helpers that never throw. |
| `HOME`, `appData()`, `recent(ms)`, `midnight()`, `DAY` | Paths and time. |

## A complete example

A tool that writes one JSON file per chat to `~/.mytool/chats/`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.mytool', 'chats');

export default {
  id: 'mytool',
  label: 'My Tool',
  sessions() {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return []; }
    return files.flatMap(f => {
      const file = path.join(DIR, f), st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > 864e5) return [];
      const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
      return [{
        id: chat.id, source: 'mytool', mtime: st.mtimeMs,
        name: chat.title, model: chat.model, activity: chat.messages.at(-1)?.text,
        tokOut: chat.usage?.output ?? 0, ctx: chat.usage?.context ?? 0, ctxMax: 200000,
      }];
    });
  },
};
```

## Ground rules for built-in adapters

- **Read-only.** Never write to another tool's files. Open databases with `readOnly: true`.
- **Cheap.** It runs every 5 seconds. Cache by mtime or byte offset, and don't rescan big folders every call.
- **Quiet when absent.** If the tool isn't installed, return `[]`. Throw only for real errors.
- **No network.** Everything stays on the user's machine.
- Test it with a small sample file in a fake home folder: `HOME=/tmp/fake USERPROFILE=/tmp/fake node server.mjs --no-open`.

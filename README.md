# TinyCode

[![CI](https://github.com/lxw822/tinycode_test/actions/workflows/ci.yml/badge.svg)](https://github.com/lxw822/tinycode_test/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A minimal but complete **coding agent harness** — learn how coding agents work by reading one.

TinyCode is a clean-room reproduction built on the [Pi](https://github.com/earendil-works) agent
framework (`pi-agent-core` / `pi-ai`). It implements the parts that make an agent _a harness_ —
tools, permissions, context management, sessions, model routing, and a scripted offline mock —
while keeping the whole thing small enough to read in an afternoon.

- **Zero-network by default in tests**: a scripted faux model drives the _real_ agent loop.
- **Safe by default**: headless runs have no permission dialog, so state-changing operations are
  denied unless you explicitly opt in.
- **Strategy/机制分离**: the core loop (mechanism) is policy-free; five injected hooks carry all
  the policy.

## Quick start

```bash
npm install
npm test              # 231 tests, offline, no API key needed
```

Run the CLI (offline mock model):

```bash
npx tsx src/cli/index.ts -p "hello" --model mock
```

Drop `-p "<prompt>"` to open the interactive full-screen TUI (needs a real terminal):

```bash
npx tsx src/cli/index.ts --model mock
```

> **Note on `npm run dev`**: npm 11 consumes `-p`/`--model` as its own flags. Either call `tsx`
> directly (above), or pass flags through a double separator:
> `npm run dev -- -- -p "hello" --model mock`.

With a real model, set a provider key and drop `--model mock`:

```bash
$env:DEEPSEEK_API_KEY = "..."        # PowerShell
npx tsx src/cli/index.ts -p "what does this project do?"
```

Build and run the compiled output:

```bash
npm run build
node dist/cli/index.js -p "hello" --model mock
```

## Commands

| Command                                         | Description                                             |
| ----------------------------------------------- | ------------------------------------------------------- |
| `tinycode`                                      | Interactive full-screen TUI (needs a TTY)               |
| `tinycode -p "<prompt>"`                        | Headless one-shot run (ASK-level operations **denied**) |
| `tinycode -p "<prompt>" --permission-mode auto` | Allow state-changing operations unattended              |
| `tinycode --model provider/id \| mock`          | Model reference (`--model mock` = offline)              |
| `tinycode --session <id>` / `-c`                | Resume a session (interactive)                          |
| `tinycode --project-root <path>`                | Operate on a different directory                        |
| `tinycode --help` / `--version`                 | Help / version                                          |

Environment variables: `TINYCODE_MODEL`, `TINYCODE_PERMISSION_MODE`, `TINYCODE_HOME`,
`TINYCODE_MOCK_SCRIPT`.

## The safety model

There is no dialog in headless (`-p`) mode, so **ASK-level operations default to deny**:

```
write to a file  →  denied (exit 0, model is told WHY it was blocked)
```

To let an unattended run change state, opt in explicitly:

```bash
tinycode -p "fix the failing tests" --permission-mode auto
```

Permission verdicts are decided in three layers:

1. **Hard deny** — destructive/blocked commands are never overridable.
2. **Rules** — reads inside the project are always allowed.
3. **Ask path** — dialog if available, otherwise _default-deny_ (headless).

## Architecture

The core loop is mechanism; all policy is injected through **five hooks**:

```
┌─────────────────────────── TinyCodeRuntime ───────────────────────────┐
│  Agent (pi-agent-core)                                                │
│                                                                       │
│  1. transformContext   → auto-compaction before each request          │
│  2. beforeToolCall     → permission gate (deny → error tool result)   │
│  3. afterToolCall      → truncate oversized tool output               │
│  4. summarize          → compaction summarizer (one LLM call)         │
│  5. message_end        → append to the JSONL session log              │
└───────────────────────────────────────────────────────────────────────┘
```

```
src/
├── agent/       runtime (5 hooks), system prompt
├── bootstrap.ts assembles the harness from config
├── cli/         argument parsing + headless/interactive entry
├── config/      layered config (flags > env > file)
├── context/     truncation, artifacts, compaction
├── mcp/         stdio MCP clients, tool adaptation, status
├── model/       registry (resolution order), offline mock scripts
├── permissions/ classifier, rules, manager (3-layer verdicts)
├── session/     JSONL storage, attach/resume, TINYCODE_HOME
├── skills/      discovery + frontmatter index (progressive disclosure)
├── subagents/   read-only workers: manager + coordination tools
├── tools/       read, write, edit, bash, grep, find, ls, load_skill
└── tui/         full-screen session: transcript, editor, status bar, dialog
```

### Tools

| Tool                                                         | Notes                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `read` / `write` / `edit`                                    | Path-guarded: `realpath` checked on both sides, `/` out  |
| `bash`                                                       | Timeout + abort handled by process-tree kill (Win-aware) |
| `grep` / `find` / `ls`                                       | Read-only project inspection                             |
| `load_skill`                                                 | Loads a skill by name (never a path) — see below         |
| `spawn_agent` / `list_agents` / `wait_agent` / `close_agent` | Sub-agent coordination — see below                       |

Every tool resolves paths against the project root and rejects escapes (symlinks included).

### Skills

Drop a `SKILL.md` into `.tinycode/skills/<name>/` (project) or `~/.tinycode/skills/<name>/`
(user-level; a project skill with the same name wins):

```markdown
---
name: code-review
description: Review code changes for correctness and maintainability.
---

# instructions…
```

Only the `name: description` line reaches the system prompt. When the model judges a skill
relevant it calls `load_skill(name)` and the full body arrives as a tool result — unused skills
cost zero context tokens. Discovery never lets a malformed file break boot, and the tool resolves
names against the discovery-time map, so there is no path to traverse.

### MCP

Add stdio servers to `.tinycode/config.json`:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

Servers are connected **in parallel** at startup behind a 10s initialize timeout. A server that
is missing, crashes, or hangs records a failed status instead of taking the app down — the other
servers keep running. Each server's tools join the one tool registry with their JSON Schema passed
through unchanged; a name that collides with a built-in is qualified as `<server>_<tool>`.
`tinycode --mcp-status` prints the listing headless (`/mcp` inside the TUI), and shutdown closes
every transport so no child processes leak.

MCP tools are new, unvetted tools: they get the same default as any unrecognized tool — **ask**
(and therefore deny in headless `auto`-less runs).

### Sub-agents

`spawn_agent` starts a **read-only worker**: an independent Pi `Agent` with its own transcript,
its own abort, a fixed worker prompt, and a tool registry built from just `read`/`grep`/`find`/
`ls` — no `write`/`edit`/`bash`, and never the coordination tools, so a worker can look but never
touch and can never spawn its own children. Hard limits prevent swarms: **max 3 concurrent**;
`spawn_agent` refuses beyond the cap with instructions to `wait_agent` or `close_agent` first.
The root collects results with `wait_agent` (the worker's final assistant message, verbatim as a
report) and can abort with `close_agent`. Workers never touch the session log — the root owns it.
Harness shutdown aborts every worker so no agent outlives the process.

Coordination tools follow the same permission rule as MCP: unknown tools are **ask**, never
auto-allow. A worker's own `read`/`grep`/`find`/`ls` calls are normal read-only calls and get the
usual in-project allow.

### TUI

`tinycode` with no `-p` opens the full-screen session (alternate screen, `Ctrl+D` to leave):

```
┌─ transcript — follows the end, arrows scroll ──────────┐
│ ❯ fix the tests                                        │
│   ● bash npm test                                      │
│     ✓ exit 0 · 2.4s                                    │
│     + const add = (a, b) => a + b                      │
├─ ◐ 2 tools running ────────────────────────────────────┤
│ ▌                                                     │
├─ ● ready · provider/model · ~/proj · ctx ~12.3k ───────┤
└────────────────────────────────────────────────────────┘
```

- **Enter** submits · **Esc** aborts a running turn · **Ctrl+C** aborts (a second press while
  idle quits) · **Ctrl+D** quits · arrows scroll the transcript. While a turn runs, Enter is
  disabled but the editor keeps accepting text so you can queue your next thought.
- Slash commands — `/help`, `/mcp`, `/model`, `/clear`, `/compact`, `/exit` — autocomplete from
  the prompt.
- ASK-level tools open a centred dialog with **Deny / Allow once / Always allow**. The default
  selection is **deny** (a stray Enter must not open the write path) and **Esc** cancels to deny.
  It is reached through a `PermissionBridge` installed at bootstrap — before any TUI object
  exists — so an ask with no dialog attached still fails closed, exactly like headless `-p`.
- No TTY (CI, a pipe, a shell without one)? The CLI prints a headless hint and exits 0 instead
  of hanging.

## Offline testing

Tests never touch the network. `ModelRegistry.enableMock()` registers Pi's scripted **faux**
provider, and the test replays a script through the real loop:

```ts
const registry = new ModelRegistry();
const faux = registry.enableMock();

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("edit", { path: "math.js", ... })]),
  fauxAssistantMessage([fauxText("Fixed add() and verified: tests pass.")]),
]);

await harness.runtime.prompt("the tests fail, fix it");
```

For CLI runs, point `TINYCODE_MOCK_SCRIPT` at a JSON file:

```json
[
  { "toolCalls": [{ "name": "read", "arguments": { "path": "a.ts" } }] },
  { "text": "Here's what the file contains." }
]
```

## Development

```bash
npm run check            # format:check + lint + typecheck + test
npm run test:coverage    # coverage report (currently ~88% lines)
npm run lint:fix         # ESLint autofix
npm run format           # Prettier
```

## Status

Complete: tools, permissions, context, sessions, model routing, headless CLI, skills
(progressive disclosure), MCP servers, read-only sub-agents, and the interactive full-screen
TUI — every milestone is driven by offline tests that run a scripted model through the real
loop, on Windows and Linux.

## Acknowledgements

This is an independent, clean-room reimplementation inspired by
[helsome/tinycode](https://github.com/helsome/tinycode). The architecture follows that project's
`ARCHITECTURE.md`; no source code or tests from the original were used. It is not affiliated with
or endorsed by the original author.

The agent loop itself is built on the [Pi](https://github.com/earendil-works/pi) framework
(`pi-agent-core`, `pi-ai`) — TinyCode contributes the harness around it: tools, permissions,
context, sessions, and model routing.

## License

MIT

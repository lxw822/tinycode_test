# TinyCode

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
npm test              # 141 tests, offline, no API key needed
```

Run the CLI (offline mock model):

```bash
npx tsx src/cli/index.ts -p "hello" --model mock
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
├── model/       registry (resolution order), offline mock scripts
├── permissions/ classifier, rules, manager (3-layer verdicts)
├── session/     JSONL storage, attach/resume, TINYCODE_HOME
└── tools/       read, write, edit, bash, grep, find, ls
```

### Tools

| Tool                      | Notes                                                           |
| ------------------------- | --------------------------------------------------------------- |
| `read` / `write` / `edit` | Path-guarded: `realpath` checked on both sides, outputs use `/` |
| `bash`                    | Timeout + abort handled by process-tree kill (Windows-aware)    |
| `grep` / `find` / `ls`    | Read-only project inspection                                    |

Every tool resolves paths against the project root and rejects escapes (symlinks included).

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

Core slice complete: tools, permissions, context, sessions, model routing, headless CLI, and an
end-to-end test that drives a scripted model through the real loop to fix a broken fixture project.

Planned: interactive TUI, skills, MCP, sub-agents.

## License

MIT

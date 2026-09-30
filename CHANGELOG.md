# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Sub-agents** (`src/subagents/manager.ts`): read-only workers as independent Pi `Agent`
  instances with their own transcripts and aborts, a fixed worker prompt, and a tool registry of
  only `read`/`grep`/`find`/`ls` — never `write`/`edit`/`bash` and never the coordination tools
  (no nesting, no swarm). Hard cap of 3 concurrent with a recovery hint on refusal; root
  coordinates via `spawn_agent` / `list_agents` / `wait_agent` (final assistant message as report,
  with timeout) / `close_agent`; `shutdown()` aborts every worker so none outlives the process.
  Coordination tools stay under the unknown-tool **ask** rule, like MCP.
- **MCP** (`src/mcp/client.ts`): parallel stdio connections with a 10s initialize timeout,
  failure isolation (a dead server records a status entry instead of crashing), JSON Schema
  passed through to the tool registry with `<server>_<tool>` collision qualification, child
  stderr captured into the status entry, idempotent shutdown with no leaked processes, and a
  `--mcp-status` CLI listing. MCP tools default to ASK like any unrecognized tool.
- **Skills** (`.tinycode/skills/<name>/SKILL.md`, user-level mirror in the data home): discovery
  with frontmatter parsing, one-line-per-skill system-prompt index, and a `load_skill` tool that
  resolves names against the discovery map (no path input, auto-allowed as read-only). Malformed
  skills never break boot; project skills shadow user-level ones.
- Interactive TUI (planned)
- MCP, sub-agents (planned)

## [1.0.0] - 2026-09-29

### Added

- **Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` with project-root path guards
  (dual `realpath` symlink escape check, forward-slash output paths).
- **Permissions**: three-layer verdicts — hard deny → rules → ask path; headless runs default to
  deny when no dialog is available; `--permission-mode auto` as the explicit unattended opt-in.
- **Context management**: tool-output truncation, artifact offload, auto-compaction with a
  summarizer injected via hook.
- **Sessions**: JSONL transcript storage with torn-line self-healing on append, `--session`/`-c`
  resume, `TINYCODE_HOME` data-directory override.
- **Model registry**: resolution order `--model` > `TINYCODE_MODEL` > config > first
  auth-configured provider; explicit `enableMock()` registers Pi's offline faux provider so an
  ambient API key can never shadow it.
- **Bootstrap**: five injected hooks separate policy from the core loop.
- **CLI**: headless `-p` one-shot mode, `--help`/`--version`, argument validation with exit code 2.
- **Offline mock scripting**: `TINYCODE_MOCK_SCRIPT` JSON files drive the real agent loop with no
  network.

### Engineering

- ESLint 9 (flat config) + Prettier, `npm run check` aggregate gate.
- 141 tests across 9 files; coverage ~88% lines (`npm run test:coverage`).
- GitHub Actions CI (Windows/Ubuntu × Node 22/24).
- `npm pack` limited to `dist/` (60 files); `prepublishOnly` runs the full check + build.

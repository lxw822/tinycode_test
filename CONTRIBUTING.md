# Contributing to TinyCode

Thanks for helping improve TinyCode. This project is a clean-room, educational reproduction —
changes should keep it readable first and feature-rich second.

## Ground rules

1. **Readability over cleverness.** If a change needs a paragraph of comments to explain a type,
   simplify the type instead.
2. **Mechanism / policy split.** The core loop (`src/agent/runtime.ts`) must stay policy-free.
   All policy arrives through the five injected hooks in `src/bootstrap.ts`. If you find yourself
   adding an `if (permissionMode ...)` inside the runtime, it belongs in a hook.
3. **Offline tests only.** Tests must never reach the network or require an API key. Drive the
   real loop with the faux provider (`ModelRegistry.enableMock()`).

## Getting set up

```bash
npm install
npm run check     # format + lint + typecheck + test — must pass before you push
```

## Making changes

| Task            | Command                              |
| --------------- | ------------------------------------ |
| Run everything  | `npm run check`                      |
| Watch tests     | `npm run test:watch`                 |
| Coverage report | `npm run test:coverage`              |
| Fix lint/format | `npm run lint:fix && npm run format` |
| Typecheck only  | `npm run typecheck`                  |

### Adding a tool

1. Create `src/tools/<name>.ts` exporting `create<Name>Tool(projectRoot)` returning an `AgentTool`.
2. Resolve every path through `resolveWorkspacePath(projectRoot, path)` — never trust raw paths.
3. Register it in the factory list in `src/bootstrap.ts`.
4. Add tests in `tests/tools.test.ts`, including at least one path-escape case.

### Adding a permission rule

Rules live in `src/permissions/rules.ts` (path/verb based) and
`src/permissions/classifier.ts` (shell command risk). Remember the design rule: **unknown verbs
are `write`, never `safe`.** Cover new rules in `tests/permissions.test.ts`.

## Commit / PR checklist

- [ ] `npm run check` passes
- [ ] New behavior has tests (offline, deterministic)
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] No policy leaked into `src/agent/runtime.ts`
- [ ] No secrets, absolute machine paths, or generated files committed (`dist/`, `coverage/` are ignored)

## Reporting issues

Include the command you ran, your model (`--model ...` or `TINYCODE_MODEL`), OS/Node version, and
whether the run was mock or real. For session bugs, the relevant JSONL excerpt helps a lot (redact
content as needed).

# Adding an extension to pi-kit

This repository is a collection: one install, N independent pi extensions. Each extension has its own entry point, implementation namespace, docs folder, and tests; repository-wide guards keep the collection consistent.

## Steps

1. **Create the pi entry point**: `extensions/<name>.ts`.
2. **Register it in `package.json`** under `pi.extensions`:
   ```json
   {
     "pi": { "extensions": ["./extensions/vigil-todo.ts", "./extensions/<name>.ts"] }
   }
   ```
3. **Create the docs folder**: `docs/<name>/README.md` (overview, tools, commands, quickstart) and any extra docs such as `configuration.md`. Design archives (specs/plans) go under `docs/<name>/design/`, never at the repository top level.
4. **Create tests** under `tests/<name>/`.
5. **Run the full gate**: `npm run verify`.

## Source layout

- `vigil-todo` lives under `src/vigil-todo/{board,jobs,bind,wake,ui,tool,lib}`.
- **New extensions use `src/<name>/`** and must not add modules to the repository root or to another extension's namespace.
- **Do not create `src/shared/` yet.** With only one consumer, a shared layer is speculative generality. Extract shared modules (atomic writes, tail reads, sanitization, and so on) only when a second real extension needs them and both call sites exist.

## Test layout

- `vigil-todo` tests live under `tests/vigil-todo/{board,jobs,bind,wake,ui,tool,lib,integration,perf,security}`.
- **New extensions use `tests/<name>/`**; repository-wide `tests/arch/` and `tests/selfcheck/` guards apply to every extension and stay at the root.
- Assertion strength is part of the contract: do not weaken `toBe`/`toEqual`/`toContain` to `toBeDefined`/`not.toThrow`, and do not delete or skip cases to make a suite green.
- Performance tests live under the extension's `perf/` folder and are serialized by `fileParallelism: false`.

## Naming and copy

- Tool names should be short and unprefixed unless they are likely to collide with ecosystem tools. Registering a tool means checking the name at startup (see below).
- All code, comments, test text, and runtime messages are **English-only**. `tests/arch/language.test.ts` rejects CJK characters in `src/`, `extensions/`, and `tests/`.
- Refusal and warning messages must end with an **actionable next step** (a concrete tool call, command, or config action).
- Runtime truth must come from durable state (for example job-side records), never from evictable display data such as the evidence ring. When a durable record is gone, fall back explicitly and flag that fallback.

## Tool conflict self-check

Before registering tools, call `pi.getAllTools()` and verify that no other extension already provides a tool with the same name. `vigil-todo` registers nothing when it detects an old package occupying `todo`; copy that pattern. Tool registration is first-registrant-wins and silent, so a missing check produces a half-working install.

## Commit workflow

- Work on the single build branch.
- Every round ends with a commit and push.
- The final pull request is reviewed by a human; the model does not merge.

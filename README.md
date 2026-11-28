[English](./README.md) | [中文](./README.zh-CN.md)

# pi-kit

A pi extension collection: one repository, one install, N extensions.

## Extensions

| Extension | What it does | Docs |
|---|---|---|
| `vigil-todo` | Task board plus background jobs: evidence-based completion, retries/backoff, wake delivery, a one-key halt, and proactive first-run onboarding that tells the model when to reach for the board. | [docs/vigil-todo/README.md](docs/vigil-todo/README.md) |

Sub-agent dispatch guidance for `vigil-todo` lives at [docs/vigil-todo/dispatching-agents.md](docs/vigil-todo/dispatching-agents.md).

## Install

Three installation modes, depending on your situation:

**git — works today, tracks `main`:**

```bash
pi install git:github.com/Spoon94/pi-kit
```

**npm — recommended for users:**

```bash
pi install npm:pi-kit
```

**local checkout — for development; code changes take effect with `/reload`:**

```bash
pi install ./
```

Pin a ref if you want a fixed snapshot: `pi install git:github.com/Spoon94/pi-kit@<tag-or-sha>`.

Adjust the remote/fork as needed, then restart pi. Each extension's docs describe any additional setup (for example, `vigil-todo` requires removing the old `rpiv-todo` / `pi-bg-run` packages first).

## First use

On the first real user run of a session, `vigil-todo` gives the model one short, conditional instruction: if the request spans 3+ steps, multiple files, or long-running commands, capture the work with `todo create` before acting; run long commands with `bg_run`; skip trivial questions (no tasks for them). Later runs in the same session get no repeat message, and wake/custom runs never trigger it. The system prompt also carries a one-line onboarding sentence plus a light board digest (current WIP and the next task) that is replaced whenever the board changes.

Configure it with `onboardingPrompt`: `live` (default, message + board digest), `once` (base sentence and the first-run message only) or `off` (nothing). Tool details live in [docs/vigil-todo/README.md](docs/vigil-todo/README.md).

## Adding an extension

Step-by-step guide: [docs/adding-an-extension.md](docs/adding-an-extension.md).

## Development

```bash
npm install
npm test                 # vitest
npm run typecheck
npm run coverage:check   # lines >=95% / branches >=90% / functions >=95%
npm run verify           # test + typecheck + coverage in one shot
```

Repository conventions:

- **English-only**: `src/`, `extensions/`, and `tests/` are guarded against CJK characters by `tests/arch/language.test.ts`; new docs are written in English.
- **Single build branch**: work happens on one build branch; every round commits and pushes; the final PR is reviewed by a human.
- **Truth from durable state**: runtime decisions should read authoritative, persistent state, not evictable display data.

## Layout

| Path | Responsibility |
|---|---|
| `extensions/` | pi extension entry points (one thin `.ts` file per extension) |
| `src/` | implementation namespaces; `src/<name>/` per extension (`src/vigil-todo/` today) |
| `tests/` | Vitest suites; `tests/<name>/` per extension plus repo-wide `arch/` and `selfcheck/` guards |
| `docs/` | collection docs plus one folder per extension; each extension's design archive lives under its own `docs/<name>/design/` (vigil-todo: `docs/vigil-todo/design/`) |

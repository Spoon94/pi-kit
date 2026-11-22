# pi-kit

A personal pi extension collection: one repository, one install, N extensions.

## Extensions

| Extension | What it does | Docs |
|---|---|---|
| `vigil-todo` | Task board plus background jobs: evidence-based completion, retries/backoff, wake delivery, and a one-key halt. | [docs/vigil-todo/README.md](docs/vigil-todo/README.md) |

Sub-agent dispatch guidance for `vigil-todo` lives at [docs/vigil-todo/dispatching-agents.md](docs/vigil-todo/dispatching-agents.md).

## Install

From a local checkout:

```bash
pi install ./
```

From a git source, name the branch explicitly — `main` currently contains only docs, while extension code lives on the build branch:

```bash
pi install git:github.com/Spoon94/pi-kit@feat/vigil-todo
# or: pi install https://github.com/Spoon94/pi-kit#feat/vigil-todo
```

Adjust the remote/fork as needed, then restart pi. Each extension's docs describe any additional setup (for example, `vigil-todo` requires removing the old `rpiv-todo` / `pi-bg-run` packages first).

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
| `docs/` | collection docs plus one folder per extension; the internal design archive stays under `docs/superpowers/` |

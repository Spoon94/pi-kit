# pi-kit · vigil-todo

**North star: leave with confidence.** Queue a batch of work overnight, go to sleep, and come back to a board where finished work is finished, stopped work sits where it should, and progress is trustworthy.

`vigil-todo` closes the loop between task planning and background jobs: a job exit refills task state, evidence decides completion, failures back off and retry, and the single next step is delivered back to the model. It replaces `@juicesharp/rpiv-todo` + `pi-bg-run`.

## Install

1. **Remove the old packages first** (hard prerequisite; see [docs/migration.md](docs/migration.md)):
   ```bash
   pi remove @juicesharp/rpiv-todo
   pi remove pi-bg-run
   ```
   Tool names are first-registrant-wins and silent; having both packages installed produces a half-working state.
2. Add this package to `packages` in `~/.pi/agent/settings.json` (or point a project `.pi/extensions/` entry at `extensions/vigil-todo.ts`).
3. Restart pi. `/vigil-todo doctor` should show `✓ No issues found`.

## Tools

| Tool | Purpose |
|---|---|
| `todo` | `create` / `update` / `list` / `get` / `delete` / `clear` / `verify` |
| `bg_run` | Start a background job bound to `task_id` (optional only when exactly one `in_progress` task exists) |
| `bg_list` | List job status and exit codes |
| `bg_kill` | Cancel an entire retry chain (accepts rootId or any id in the chain) |

`todo` adds only `verify` to its action enum; all other intents use `update` + fields:

```
start    todo({action:"update", id, status:"in_progress"})
finish   todo({action:"update", id, status:"completed"})
accept stale todo({action:"update", id, status:"completed", accept:"stale"})
park     todo({action:"update", id, status:"parked", reason:"…"})
reverify todo({action:"verify", id})
```

## Commands

| Command | Effect |
|---|---|
| `/vigil-todo` or `/vt` | Board + one-line quick help (no need to memorize halt/resume/doctor) |
| `/vigil-todo halt` | Forced halt: stop autonomous progress, kill this session's jobs, park affected tasks |
| `/vigil-todo resume` | Resume after a halt (does not reset turnsUsed) |
| `/vigil-todo doctor` | Conflict / sidecar degraded / halted / purged / overdue / in_progress without a job |
| `/vt clear` | Clear history: default `settled` (completed+deleted); also `clear completed` / `deleted` / `settled`. pending/in_progress/parked are never cleared |
| `/todos` | Every task with exit code + fingerprint drill-down |
| `/bg` | Job list; `/bg k <id>` confirms a two-step chain cancel; `/bg tail <id>` shows the log tail |

The status bar always shows `vigil ● N jobs` / `vigil ⚠ N parked` / `vigil ⏸ halted` / `vigil ✓ done/total`, and clears when idle.

Tab completion: `/vigil-todo` and `/vt` complete `halt`/`resume`/`doctor`/`clear` (`clear ` then completes the three scopes completed/deleted/settled); `/bg` completes `k`/`tail`, then current job ids after a space (cancellable jobs first, max 50); `/todos` has no candidates.

Collapse shortcut defaults to `ctrl+shift+t`; the one-key halt defaults to `alt+h` (both accept `off`; `/reload` required).

Model-side trigger: when the user says “run it in the background / I'm going to sleep / batch / long task / run overnight”, the guidance tells the model to create a todo and start `bg_run` without being asked for the tool name. `/vt halt` is always the brake.

## Configuration

Priority: `~/.config/pi-kit/config.json` → `pi.getSettings().vigilTodo` → `pi.getSettings().bgRun` (legacy keys) → defaults.

| Key | Default |
|---|---|
| `wipLimit` | 1 (the model focuses on one todo at a time) |
| `retries` | 5 (6 total attempts) |
| `retryDelaysMs` | `[0, 30000, 120000, 300000, 600000]` (5 tiers; worst-case cumulative wait ≈17.5 min) |
| `staleReverify` | 1 |
| `maxTurns` | 50 |
| `maxConcurrentJobs` | 10 |
| `completedTtlMs` | 7 days (plus a hard cap of 2000 terminal records to keep the sidecar bounded) |
| `taskRetentionMs` | 0 (automatic cleanup off) |
| `tailLines` / `maxTailBytes` | 20 / 8192 |
| `maxWidgetLines` | 12 |
| `wakeMergeMs` | 250 |
| `notifyRetryMs` | 10min |
| `collapseKey` / `haltKey` | collapse key / one-key halt key (default `alt+h`, `off` disables) |

## Dispatching sub-agents

When wrapping “dispatch + wait for report” in `bg_run`, write it as an idempotent poller: see [docs/dispatching-agents.md](docs/dispatching-agents.md) for the two-step atomic flow, the halt-only-kills-the-watcher gap, and residual risk/recovery.

## Development

```bash
npm install
npm test        # vitest
npm run typecheck
npm run coverage:check   # lines ≥95% / branches ≥90% / functions ≥95%
npm run verify           # all three gates: test + typecheck + coverage:check
```

Architecture: `src/board` is a pure state machine (never imports pi) → `src/jobs` is the process subsystem → `src/bind` is the only cross-boundary writer → `src/wake` delivers → `src/ui` is a read-only panel. Job facts come only from the sidecar (`/tmp/bg-run/<hash(cwd)>/jobs.json`); task visibility comes only from session snapshots.

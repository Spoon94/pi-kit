# vigil-todo configuration

## Priority chain

```
~/.config/pi-kit/config.json          (highest)
  → pi.getSettings().vigilTodo
  → pi.getSettings().bgRun            (legacy keys)
  → DEFAULTS                           (lowest)
```

Each key is resolved independently: if the key appears at the highest layer with a valid value, that value wins. Invalid values (wrong type, below minimum, above maximum) **fall back to the default per key**, without affecting other keys and without throwing. A missing or corrupt file simply means that layer has no configuration.

## Contract

- **Types and ranges**: every key declares a type and minimum (see table); `CONFIG_KEYS` is the single source of metadata and `default` references `DEFAULTS`, so docs, validation, and defaults cannot drift.
- **Hot-reload matrix**: all keys apply immediately except `collapseKey` and `haltKey` (each key decision reads the mtime cache); the two shortcuts are registered once, so they require `/reload`.
- **Failure direction**: a configuration problem never crashes or disables the extension; the worst case is that a key falls back to its default.

## All keys

| Key | Type | Min | Max | Default | When it applies |
|---|---|---|---|---|---|
| `wipLimit` | int | 1 | 100 | 1 | Immediate (every WIP decision) |
| `retries` | int | 0 | 20 | 5 | Immediate (next retry decision; total attempts = 1 + retries = 6) |
| `retryDelaysMs` | int[] | 0 (per item) | 3600000 (per item) | `[0, 30000, 120000, 300000, 600000]` | Immediate (next backoff schedule; five tiers) |
| `staleReverify` | int | 0 | 10 | 1 | Immediate (next stale decision) |
| `maxTurns` | int | 1 | 10000 | 50 | Immediate (first-line gate in `tryDeliver`) |
| `maxConcurrentJobs` | int | 1 | 200 | 10 | Immediate (next spawn admission) |
| `completedTtlMs` | int | 1 | 31536000000 (365 days) | 604800000 (7 days) | Immediate (next GC) |
| `taskRetentionMs` | int | 0 | 31536000000 (365 days) | **0 (off)** | Immediate (next sweep) |
| `tailLines` | int | 1 | 500 | 20 | Immediate (next tail read) |
| `maxTailBytes` | int | 1 | 1048576 (1MB) | 8192 | Immediate (next tail read) |
| `maxWidgetLines` | int | 3 | 200 | 12 | Immediate (next render) |
| `collapseKey` | string | — | — | `ctrl+shift+t` / `off` | **`/reload` required** (shortcut is registered once) |
| `haltKey` | string | — | — | `alt+h` / `off` | **`/reload` required** (one-key forced halt) |
| `notifyRetryMs` | int | 1 | 86400000 (24h) | 600000 (10 min) | Immediate (next catch-up scan) |
| `wakeMergeMs` | int | 0 | 60000 (1 min) | 250 | Immediate (next wake merge window) |

Values outside min/max **fall back to the default per key** without affecting other keys; the maxima prevent settings such as `maxTailBytes` from causing TB-scale buffers or disk reads.

`jobs.json` also has a non-configurable hard cap of **2000 terminal records** (≈1.4 MB): in addition to the TTL, sweep GC reclaims only complete chains that are “finalized + projected + acked/self”. Running, backoff, unprojected, and unacked records are never removed by the cap.

## Tool guidance overrides (§19.2)

The configuration layers (file / `settings.vigilTodo` / `settings.bgRun`) may contain:

```json
{
  "guidance": {
    "snippets": {
      "todo": "one-line todo summary",
      "bg_run": "one-line bg_run summary",
      "bg_list": "one-line bg_list summary",
      "bg_kill": "one-line bg_kill summary"
    },
    "promptSnippet": "global fallback snippet (optional)",
    "promptGuidelines": ["point 1", "point 2"]
  }
}
```

`snippets.<tool>` overrides per tool (the four should differ; the Available tools section shows one line per tool); `promptSnippet` is kept for backward compatibility and acts as the fallback for tools without a per-tool override. The priority chain is the same as the main configuration (file > settings.vigilTodo > legacy.bgRun > defaults), with per-key fallback for both global and per-tool values. `promptGuidelines` is shared (pi's buildRules deduplicates, so it does not grow 4×). Tools are registered or re-registered with the effective values at `session_start`: a guidance change takes effect on the **next session_start (or `/reload`)**; no pi restart is needed. The default guidance covers bg_run-vs-bash choice, WIP=1, park reason, evidence-based completion, clear scope, and acting immediately after a wake.

## Why `taskRetentionMs` defaults to 0

Automatically deleting tasks is **irreversible data loss**. It is off by default and enabled only when a person explicitly sets a positive integer; sweep clears `completed` / `deleted` tasks whose `statusSince` is older than `now - taskRetentionMs`, using the same path as manual `clear` (including the sidecar `purged` marker).

**`parked` is never auto-cleared**: parked tasks are decisions waiting for a person; deleting them would throw away the north star's handoff object.

## Example

```json
{
  "wipLimit": 1,
  "retries": 2,
  "maxTurns": 30,
  "taskRetentionMs": 604800000,
  "collapseKey": "off",
  "haltKey": "alt+h"
}
```

`collapseKey: "off"` disables the collapse shortcut; `haltKey: "off"` likewise disables the one-key halt (both need `/reload`).

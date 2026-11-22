# Changelog

## [0.1.0] - 2026-11-22

### Added

- `vigil-todo`: task board + background jobs as one closed loop — evidence-based completion, failure backoff/retry, single-next wake delivery, park semantics, halt/resume, selective clear, and Tab completion.
- Multi-extension repo layout: `extensions/<name>.ts` + `src/<name>/` + `tests/<name>/` + `docs/<name>/`.
- Repository guards: module boundaries, retired-mechanism scope, CJK-free source, spec↔test coverage, and config-consumed checks.

### Notes

- Remove `@juicesharp/rpiv-todo` and `pi-bg-run` first: tool-name registration is first-registrant-wins, and leaving the old packages installed produces a half-working state.

# Changelog

## [0.1.0] - Unreleased

### Added

- `vigil-todo`: task board + background jobs as one closed loop — evidence-based completion, failure backoff/retry, single-next wake delivery, park semantics, halt/resume, selective clear, and Tab completion.
- Multi-extension repo layout: `extensions/<name>.ts` + `src/<name>/` + `tests/<name>/` + `docs/<name>/`.
- Repository guards: module boundaries, retired-mechanism scope, CJK-free source, spec↔test coverage, and config-consumed checks.

### Notes

- Remove `@juicesharp/rpiv-todo` and `pi-bg-run` first: pi fails to load the later-registered extension with an explicit tool-conflict error (observed on pi 1.5.2). Coexistence is broken either way — uninstall both before installing this package.

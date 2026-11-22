# Changelog

## [0.1.0] - Unreleased

### Added

- `vigil-todo`: task board + background jobs as one closed loop — evidence-based completion, failure backoff/retry, single-next wake delivery, park semantics, halt/resume, selective clear, and Tab completion.
- Multi-extension repo layout: `extensions/<name>.ts` + `src/<name>/` + `tests/<name>/` + `docs/<name>/`.
- Repository guards: module boundaries, retired-mechanism scope, CJK-free source, spec↔test coverage, and config-consumed checks.

### Notes

- Remove `@juicesharp/rpiv-todo` and `pi-bg-run` first: with both packages present, pi 1.5.2 prints `Error: Failed to load extension "<path>": Tool "todo" conflicts with <path>` and refuses to start (exit 1). The prefix is misleading — the extension is loaded; the conflict is a startup diagnostic. At the loader level both extensions stay loaded and the first registrant owns the tool, so a half-effective state is possible only where such diagnostics are non-fatal (embedded/SDK use); the `session_start` self-check (F13) guards exactly that. Uninstall both before installing this package.

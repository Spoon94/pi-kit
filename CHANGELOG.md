# Changelog

## [0.1.0] - Unreleased

### Added

- `vigil-todo`: task board + background jobs as one closed loop — evidence-based completion, failure backoff/retry, single-next wake delivery, park semantics, halt/resume, selective clear, and Tab completion.
- `vigil-todo` onboarding: a conditional user-role nudge on the first real user run (3+ steps / multiple files / long-running commands → `todo create`, long commands via `bg_run`, trivial questions skipped), a live WIP/next board digest in its own prompt section, and the `onboardingPrompt` setting (`live` / `once` / `off`) with an optional `guidance.onboardingPromptText` override.
- Multi-extension repo layout: `extensions/<name>.ts` + `src/<name>/` + `tests/<name>/` + `docs/<name>/`.
- Repository guards: module boundaries, retired-mechanism scope, CJK-free source, spec↔test coverage, and config-consumed checks.

### Notes

- Remove `@juicesharp/rpiv-todo` and `pi-bg-run` first: with both packages present, pi 1.5.2 prints `Error: Failed to load extension "<path>": Tool "todo" conflicts with <path>` and refuses to start (exit 1). The prefix is misleading — the extension is loaded; the conflict is a startup diagnostic. At the loader level both extensions stay loaded and the first registrant owns the tool, so a half-effective state is possible only where such diagnostics are non-fatal (embedded/SDK use); the `session_start` self-check (F13) guards exactly that. Uninstall both before installing this package.

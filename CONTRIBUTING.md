# Contributing to pi-kit

pi-kit is a collection of pi extensions. One repo, one install, N extensions.

## One build branch per major build

A major build (a new extension, or a large cross-cutting change) runs on a **single build branch**, e.g. `feat/<name>`. Do not open a branch per small task.

- Implementation, tests, docs, and defect fixes all commit to that build branch as they land.
- Ordinary small tasks do not get their own branch or their own PR.
- Pushing the build branch for backup and diffing is fine; **do not open the final PR early**.
- Only when the whole build is finished and its exit criteria pass, open one PR from the build branch to `main`.
- **The final PR is reviewed and merged by a human. Agents must not approve, merge, or bypass repository rules.**

The `feat/vigil-todo` build branch followed this process and is merged; future builds use the same convention with their own name.

## Definition of done

Before the final PR, confirm at least:

1. The relevant stage exits in the spec are met.
2. **The pre-delivery triple** passes: `npm test`, `npm run typecheck`, `npm run coverage:check` — or `npm run verify` for all three (non-zero exit on any failure).
3. Automated tests and a real-pi smoke load pass.
4. Docs, configuration reference, and acceptance cases are in sync with behavior.
5. The working tree has no uncommitted changes.
6. Hand the human the diff, the test evidence, and the remaining risks; wait for review.

## Repository conventions

- **English** for `src/`, `extensions/`, `tests/`, and all user-facing docs (enforced for code by `tests/arch/language.test.ts`). The internal design archive under `docs/<name>/design/` stays in its original language by decision.
- **Guards are proven, not assumed**: every repo-level guard (module boundaries, retired-mechanism scope, CJK-free source, spec↔test coverage, config-consumed) has a test that injects a violation and must fail.
- **Truth from durable state**: runtime decisions read authoritative, persistent state (the job sidecar), never evictable display data.
- Rejections and warnings always carry an executable next step.

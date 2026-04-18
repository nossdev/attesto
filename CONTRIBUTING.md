# Contributing to Attesto

Thanks for your interest. Attesto is pre-release — the API and schema may still shift.

## Scope

Attesto is deliberately thin. Before opening a PR that adds a feature, check it against the **non-goals** list in `PLAN.md` §14. In short:

- Entitlement management, subscription state machines, analytics, paywalls, offer codes — all **out of scope**. Those belong in your backend, not here.
- Anything that verifies a token and returns the result, or strengthens security / reliability / observability — **welcome**.

If you're unsure, open an issue first.

## Dev setup

See `README.md` Quickstart. Use mise to install the pinned toolchain; don't rely on globally-installed Deno.

## Code style

- `mise run fmt` before committing
- `mise run lint` must pass (lint + format-check + typecheck)
- `mise run test` must pass; new code needs tests (aim 80%+ coverage)
- Follow existing patterns — small files, immutable data, explicit error handling

## Commits

Conventional Commits:

- `feat:` new feature
- `fix:` bug fix
- `refactor:` no behavior change
- `docs:`, `test:`, `chore:`, `perf:`, `ci:`

One logical change per commit. Reference issue numbers when relevant.

## Security

Do not file security issues as public issues. See `SECURITY.md`.

## License

By contributing you agree your contribution will be licensed under the MIT License.

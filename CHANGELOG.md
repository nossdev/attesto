# Changelog

All notable changes to Attesto will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository scaffolding: `mise.toml` toolchain pins (Deno 2.7.12, flyctl), task runner
  wrapping `deno task`, `.mise.local.toml.example` template for local secrets
- Project metadata: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`
- `.gitignore`, `.dockerignore`, `.editorconfig`, `.env.example`
- Deno + Hono skeleton with `GET /health` (liveness) and `GET /ready` (readiness,
  fails closed when no checks wired)
- Zod-validated config loader (`src/config.ts`); `ATTESTO_ENCRYPTION_KEY` must
  decode to exactly 32 bytes of base64
- `AppError` class with plan §4.7 error-code vocabulary and response envelope
- ULID-based prefixed ID generator (`tenant_`, `key_`, `evt_`, `del_`, `req_`)
- Request-ID middleware (charset-restricted pass-through or mint-new), structured
  JSON access logger, Hono error handler that redacts stack traces in production
- Drizzle + postgres-js client wrapper (`src/db/client.ts`) and migration runner
  (`src/db/migrate.ts`) shared between `scripts/migrate.ts` (dev) and compiled
  `attesto migrate` subcommand (prod)
- `src/main.ts` subcommand dispatcher (`serve` default, `migrate`), idempotent
  shutdown handler drains DB pool on SIGINT/SIGTERM
- Multi-stage `Dockerfile` — Deno 2.7.12 builder compiles binary + embedded
  migrations, debian-slim runtime with tini + non-root user + working HTTP
  healthcheck
- `docker-compose.yml` — app + migrate sidecar + postgres-16 with healthchecks,
  no source bind-mount leaks (migrate uses the built image, not a source volume)
- GitHub Actions CI (`lint-and-typecheck` + `test` with Postgres service)
- Unit tests: config, errors, health endpoints, request-id handling (18 tests)

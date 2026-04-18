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
- Tests: 46 unit + 3 integration covering config, errors, health, `/ready` fail-closed
  behavior, ULID-prefixed IDs, request-id charset policy (regex-level + middleware-level),
  error handler (AppError envelope, 500 path, NODE_ENV-gated stack redaction), structured
  access logger, `createDb` + `/ready` against real Postgres (auto-skip when DATABASE_URL unset)

### Phase 2 — Tenants, API keys, encryption, auth
- Drizzle schema and migrations for `tenants` (id, name, isActive, timestamps) and
  `api_keys` (keyHash, keyPrefix, name, lastUsedAt, revokedAt) with a partial unique
  index on active key_hash and cascade-delete from tenants
- `src/services/crypto/encryption.ts` — AES-256-GCM with HKDF-SHA-256 per-context
  subkeys; `nonce||ciphertext||tag` layout; tamper/nonce/tag-alteration rejection;
  separate keys per column so plaintext compromise of one column doesn't weaken others
- `src/services/tenants/api-keys.ts` — async `generateApiKey("live"|"test")` producing
  `attesto_<env>_<43-char base64url>` (32 bytes of entropy); SHA-256 `hashApiKey`
- `src/db/queries/{tenants,api-keys}.ts` — typed query helpers with `{limit, offset}`
  pagination on key listing; `touchLastUsed` scoped with `revokedAt IS NULL`
- `src/middleware/auth.ts` — Bearer → SHA-256 → active-key lookup → tenant attach;
  awaited `last_used_at` update with warn-log on failure (no fire-and-forget leaks)
- `src/hono-env.ts` — shared `HonoEnv` type for strongly-typed `c.get/set`
- `src/cli/admin.ts` + `src/main.ts` dispatcher — `tenant:create/list`,
  `key:create/revoke/list` subcommands with Zod-validated args (tenant_id and
  key_id formats checked before DB calls; malformed input produces usage errors,
  not Postgres driver exceptions)
- Production error logging hardened: non-AppError errors log only `errorClass`;
  message and stack redacted in prod to prevent driver/SQL/connection-string
  leaks to third-party log aggregators
- CI/tests: `tests/integration/_helpers.ts` provides `ensureMigrated()` (idempotent
  one-shot migration runner) and `freshDb()` (clean slate per test)
- Tests: 95 total (46 unit + 49 integration covering encryption, api-keys,
  tenants/api-keys queries, auth middleware happy/sad paths, CLI subcommands,
  Zod boundary validation, `last_used_at` race-safety)

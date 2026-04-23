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

### Phase 3 — Apple verification
- `apple_credentials` table (bundle_id, key_id, issuer_id, private_key_enc BYTEA,
  environment 'production'|'sandbox'|'auto') with cascade-delete from tenants;
  first use of the new Drizzle `bytea` customType for encrypted-at-rest columns
- `src/services/apple/jwt-signer.ts` — ES256 JWT signing via Web Crypto (no npm
  dep): PKCS#8 PEM parser, 20-min TTL (Apple max), random per-request nonce,
  deterministic `now`/`nonce` injection for tests; scrubbed error messages so
  implementation-defined Web Crypto text can't leak key-derived bytes
- `src/services/apple/client.ts` — pluggable AppleClient interface; HTTP adapter
  signs JWT per request, calls api.storekit[-sandbox].itunes.apple.com, decodes
  JWS payload (signature verification deferred); returns
  `{signedTransactionInfo, decoded}` with unified request-lifecycle timeout
- `src/services/apple/credentials-loader.ts` — in-memory TTL cache with
  in-flight dedup (`loadOrFetch`) and tombstone entries for missing creds, so
  N concurrent verifies share one DB fetch + decryption
- `src/services/apple/verify.ts` — orchestrates credential load, environment
  resolution (tenant-configured or hinted; `auto` tries prod then sandbox),
  bundle-ID check, payload normalization. Discards `AppError.cause` on upstream
  failures to prevent driver messages leaking through error middleware logs
- `src/lib/ttl-cache.ts` — generic TTL cache moved out of services/crypto/
- `POST /v1/apple/verify` — auth-middleware-gated, Zod-validated body, 16KB
  size limit
- Admin CLI refactored to `AdminContext {db, encryption}`; new
  `apple:set-credentials` subcommand (10-char uppercase Key ID regex,
  UUID issuer, reads .p8 from path, encrypts via existing service)
- Tests: 126 total (+31 over Phase 2) — 7 TTL-cache, 7 JWT signer, 13 apple
  verify route (valid, unknown, bundle mismatch, credentials missing, env
  hint, 4 auto-detect branches, oversized body, malformed body, upstream
  5xx, missing auth), 3 apple CLI (encrypted storage, malformed key id,
  missing file), 1 apple DB migration table presence

### Phase 4 — Google Play verification
- `google_credentials` table (tenant_id PK, package_name, service_account_enc
  BYTEA) with cascade-delete from tenants
- `src/services/google/jwt-signer.ts` — RS256 JWT signing (parallel to
  Apple's ES256): PKCS#8 PEM parse, 1-hour exp, scrubbed import errors
- `src/services/google/oauth.ts` — service-account JWT → access-token
  exchange; per-tenant in-memory cache with 60s refresh skew before
  Google-reported expiry; in-flight dedup via `TtlCache.loadOrFetch` so
  concurrent cold-cache verifies share a single OAuth exchange
- `src/services/google/client.ts` — pluggable GoogleClient; HTTP adapter
  hits `androidpublisher/v3` endpoints (`subscriptionsv2/tokens` for
  subscriptions, `products/tokens` for one-shots); distinguishes 404
  (never existed) from 410 (consumed + gone) via
  `PurchaseNotFoundReason`; 429 maps to new `GoogleRateLimitError` with
  `Retry-After` parsing
- `src/services/google/credentials-loader.ts` — decrypt SA JSON + cache
  with the loadOrFetch + tombstone pattern from the Apple loader
- `src/services/google/verify.ts` — orchestrates load → package-name
  match → client → normalize. Subscription normalization unpacks
  `lineItems[0]` envelope (price via Google Money → micros:
  `units*1_000_000 + nanos/1000`); rate-limit errors surface as
  `AppError(RATE_LIMITED)`
- `POST /v1/google/verify` — auth-middleware-gated, Zod-validated body
  (packageName / productId / purchaseToken / type=subscription|product),
  16KB size limit
- `google:set-credentials` CLI — reads and validates SA JSON shape
  (`type=service_account` + required fields) before encrypting; response
  output deliberately omits raw JSON and `client_email` to avoid
  accidental paste-into-chat leakage
- Shared helpers — `src/lib/crypto-utils.ts` (toBase64Url / parsePkcs8Pem)
  and `src/lib/http-utils.ts` (FetchLike + safeReadJson) lifted from
  apple/google to eliminate duplication
- `docs/tenant-setup.md` — new operator's guide; Apple + Google sections
  complete with prerequisites, CLI commands, response shapes, error
  tables, and troubleshooting. Becomes the single "how do I set this up"
  reference.
- Tests: 166 total (+40 over Phase 3)

### Phase 5 — Webhook ingestion & delivery
- Schema: `webhook_configs` (tenant_id PK, callback_url, secret_enc BYTEA,
  is_active), `webhook_events` (id, tenant_id, source, external_id,
  event_type, raw/decoded payloads, received_at) with **idempotency unique
  index on (tenant_id, source, external_id)** turning Apple/Google's
  at-least-once into exactly-once, `webhook_deliveries` (attempt_count,
  status, next_attempt_at, callback_url snapshot, response tracking) with
  partial index for pending-by-next-attempt
- `src/services/webhooks/signature.ts` — HMAC-SHA256 sign + verify,
  `X-Attesto-Signature: t=<ts>,v1=<hex>` format, 5-minute skew guard,
  timing-safe hex compare
- Apple receiver: decodes JWS payload, dedupes on `notificationUUID`,
  normalizes `notificationType` + optional `subtype` to
  `apple.<type>.<subtype>` stable event strings
- Google receiver: decodes Pub/Sub `message.data` (base64 JSON),
  dedupes on `messageId`, normalizes to `google.subscription.<n>` /
  `google.product.<n>` / `google.voided` / `google.test`. Stores only
  the necessary envelope fields in `raw_payload` — the Pub/Sub
  `subscription` reference is stripped to avoid leaking Attesto's GCP
  project / subscription name to tenant callbacks
- Outbound delivery: HMAC-signed POST with PLAN §4.5 headers
  (`X-Attesto-Event`, `-Event-Id`, `-Timestamp`, `-Signature`) + JSON
  envelope `{event, eventId, externalId, timestamp, tenantId, source,
  data, raw}`. `callback_url` is snapshotted on the delivery row at
  enqueue time so retries always hit the URL configured at receive time,
  not a later edit
- Dispatcher: single-instance setTimeout loop with **serialized ticks**
  (next tick never starts until the previous resolves, via a
  `currentTick` handle) so a slow tick can't cause double-delivery.
  Re-fetches event + config per attempt, so a mid-retry secret rotation
  uses the current secret. Bounded concurrency 10 per tick
- Retry schedule matching PLAN §4.5: `[30s, 2m, 10m, 1h, 6h]` then
  terminal `failed` status
- `POST /v1/webhooks/{apple,google}/:tenantId` — NOT auth-middleware-gated
  (inbound "auth" is JWS / OIDC verification on the payload, tracked as
  Phase 5.5 hardening). 1MB size cap enforced against the **actual body
  bytes** (not just advertised Content-Length, which is spoofable)
- CLI `webhook:set-config` — Zod validation with **SSRF guard** rejecting
  callbacks pointing at localhost / private / cloud-metadata hosts, and
  **32-char minimum secret** (rejects memorable passphrases)
- Response body captured from callback HTTP responses tightly capped to
  256 chars so tenants can't accidentally leak PII from their error
  responses into Attesto's DB
- `docs/tenant-setup.md` Webhooks section complete: inbound URL registration
  for Apple + Google, outbound header + body format, signature verification
  pseudocode, retry schedule, idempotency notes, known gaps
- `PLAN.md §4.5` header example reconciled — previously contradicted
  itself (`sha256=<hmac>` at line 302 vs `v1` format at line 319); updated
  to the `t=<ts>,v1=<hex>` form that §6 + the implementation use
- Tests: 201 total (+35 over Phase 4) — 14 HMAC sign/verify, 14 receivers
  (apple happy/dup/missing/malformed/no-config/bad-tenant-id; google
  happy/dup/bad-envelope/bad-data), 7 dispatcher (deliver/retry/fail/
  abandon-on-deactivated-config/payload shape/start-stop lifecycle),
  3 CLI (encrypted storage / SSRF rejection / short-secret rejection) — 5 Google JWT signer, 7 OAuth
  (cache hits, skew-boundary refresh, per-tenant separation, concurrent
  dedup, 4xx fail, assertion body shape), 7 Google HTTP client unit
  (subscription URL, product URL, 404/410/429/5xx mapping, path
  encoding), 5 Google credentials loader unit (decrypt, not-found,
  corrupt JSON, cache hit, invalidate), 11 Google verify route
  integration (valid sub / valid product / multi-line-item / package
  mismatch / not-found / 410 gone / 429 rate limit / 5xx / missing
  creds / invalid body / invalid type / missing auth), 4 Google CLI
  integration (encrypted storage, malformed JSON, missing SA fields,
  missing file)

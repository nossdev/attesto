# Attesto — Receipt Validation Service

> **Handoff document for Claude Code.** This is the complete plan for building Attesto from scratch. Read this file in full before starting implementation.

---

## 1. Project Summary

**Attesto** is a thin, open-source receipt validation service for mobile in-app purchases (Apple App Store + Google Play). It acts as a trusted proxy that verifies purchase tokens with Apple and Google on behalf of client applications, returning verified transaction data without interpreting business logic.

- **GitHub org:** `nossdev` (Night Owl Software Studios)
- **Package name:** `@nossdev/attesto`
- **Deployment target:** Fly.io (primary), portable Docker container (self-hosting)
- **License:** MIT (TBD — confirm with Yev before publishing)
- **Repo name:** `attesto`

### Why it exists

Every app that sells anything via the App Store or Google Play needs server-side receipt validation. The actual implementation involves JWT signing with `.p8` keys, JWS chain verification, Google service account OAuth, and keeping up with constant API changes from Apple/Google. Most small-to-medium app developers reinvent this badly or don't do it at all. Attesto removes that burden.

### Design philosophy: **Thin, not thick**

Attesto is explicitly **NOT** a RevenueCat or iaptic competitor. It does **one thing**: verify that a transaction token is real and return the verified payload.

**Attesto DOES:**
- Verify Apple `transactionId` via App Store Server API + local JWS verification
- Verify Google `purchaseToken` via Google Play Developer API
- Auto-detect sandbox vs production for Apple
- Receive Apple App Store Server Notifications V2 webhooks
- Receive Google Real-Time Developer Notifications (RTDN) via Pub/Sub
- Forward verified webhook events to client callback URLs with HMAC signatures
- Manage per-tenant credentials (bundle IDs, `.p8` keys, service account JSONs)
- Provide a simple API key auth model for tenants

**Attesto does NOT:**
- Manage entitlements ("is user X premium right now?")
- Track subscription state machines (grace periods, billing retry, etc.)
- Store user data or purchase history as source of truth
- Do analytics, revenue tracking, or dashboards
- Handle offer codes, promotional logic, or trials
- Make business decisions — it returns verified data, the client decides what it means

**This boundary is non-negotiable.** If a feature request starts encroaching on entitlement logic or subscription lifecycle management, it belongs in the client's backend, not Attesto.

---

## 2. Tech Stack (Finalized)

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Deno 2.x** | Standards-based, TypeScript native, secure by default, great for open source |
| Web framework | **Hono** | Tiny, fast, runs on Deno/Node/Bun/CF Workers — maximum portability |
| Database | **PostgreSQL 16+** | Standard, portable, fits tenant config + audit logs |
| ORM / Query | **Drizzle ORM** | Type-safe, minimal, plays well with Deno, good migrations story |
| Validation | **Zod** | Industry standard for runtime schema validation |
| Logging | **pino** or **Deno.log** | Structured JSON logs to stdout |
| Testing | **Deno's built-in test runner** | `deno test`, no extra deps |
| Container | **Docker** (Dockerfile + docker-compose) | Universal deployment target |
| Deployment | **Fly.io** | Scale-to-zero, cheap, portable (just Docker) |
| CI/CD | **GitHub Actions** | Build, test, Docker build, Fly deploy |

### Deno-specific notes

- Use **JSR** (`jsr:@hono/hono`) over npm where possible for first-class Deno support
- Use `deno.json` (not `package.json`) for deps and tasks
- Respect permission model: `--allow-net`, `--allow-env`, `--allow-read` explicitly
- Lock with `deno.lock`

### Key npm/jsr packages

```
jsr:@hono/hono                       # Web framework
jsr:@hono/hono/jwt                   # JWT helpers
npm:@apple/app-store-server-library  # Apple's official SDK (has Node.js port)
npm:googleapis                       # Google's official SDK
npm:drizzle-orm                      # ORM
npm:postgres                         # Postgres client (for Drizzle)
npm:zod                              # Validation
jsr:@std/crypto                      # Deno standard crypto
```

Verify the exact Apple SDK package name — Apple publishes an official **App Store Server Library** for Node.js. Prefer this over community libraries like `app-store-server-api` unless there's a compelling reason otherwise.

---

## 3. Architecture

### Request flow

```
Client app (iOS/Android)
    │
    │  1. User completes purchase, gets transactionId/purchaseToken
    │
    ├──► Client's own backend  (optional passthrough)
    │         │
    │         │  2. POST /v1/apple/verify  { transactionId }
    │         │     Authorization: Bearer <tenant_api_key>
    │         ▼
    │    ┌─────────────────────────────────────┐
    │    │  Attesto                            │
    │    │  ────────                           │
    │    │  a. Auth: look up tenant by API key │
    │    │  b. Load Apple/Google credentials   │
    │    │  c. Verify with Apple/Google        │
    │    │  d. Return verified payload         │
    │    └─────────────────────────────────────┘
    │         │
    │         │  3. { valid: true, transaction: {...} }
    │         ▼
    │    Client's backend decides entitlements
```

### Webhook flow

```
Apple App Store (S2S Notifications V2)
Google Play (Pub/Sub RTDN)
    │
    │  1. Event fires (renewal, refund, etc.)
    │     POST /v1/webhooks/apple/:tenantId
    │     POST /v1/webhooks/google/:tenantId
    │     (Pub/Sub push subscription for Google)
    ▼
┌─────────────────────────────────────────┐
│  Attesto                                │
│  ────────                               │
│  a. Verify webhook signature            │
│  b. Decode signed payload               │
│  c. Store raw event (audit log)         │
│  d. POST to client's callback URL       │
│     with HMAC-signed payload            │
│  e. Retry with exponential backoff      │
│     on client failure                   │
└─────────────────────────────────────────┘
    │
    │  2. Client's callback URL receives event
    ▼
Client's backend updates subscription state
```

### Key architectural decisions

1. **Stateless validation path.** Validation endpoints do not write to the DB. They only read tenant credentials (cached in-memory with TTL).
2. **Stateful webhook path.** Webhooks are persisted for audit + retry purposes, with at-least-once delivery to the client callback.
3. **Per-tenant credential isolation.** Each tenant has their own Apple `.p8` key, Google service account, bundle IDs, etc. Stored encrypted at rest.
4. **HMAC-signed outbound webhooks.** Clients verify that webhooks to their callback URL came from Attesto using a shared secret.
5. **Idempotency for webhook delivery.** Use deterministic event IDs (Apple's `notificationUUID`, Google's `messageId`) to dedupe.

---

## 4. API Surface

All endpoints under `/v1/`. Authenticate with `Authorization: Bearer <api_key>`.

### 4.1 Apple verification

```http
POST /v1/apple/verify
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "transactionId": "2000000123456789",
  "environment": "production"   // optional; omit to auto-detect
}
```

**Response 200:**
```json
{
  "valid": true,
  "environment": "production",
  "transaction": {
    "transactionId": "2000000123456789",
    "originalTransactionId": "2000000000123456",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "purchaseDate": "2026-04-10T14:22:10.000Z",
    "originalPurchaseDate": "2026-01-10T14:22:10.000Z",
    "expiresDate": "2026-05-10T14:22:10.000Z",
    "type": "Auto-Renewable Subscription",
    "inAppOwnershipType": "PURCHASED",
    "quantity": 1,
    "webOrderLineItemId": "...",
    "revocationDate": null,
    "revocationReason": null,
    "offerType": null,
    "offerIdentifier": null,
    "appAccountToken": null,
    "storefront": "USA",
    "storefrontId": "143441",
    "transactionReason": "PURCHASE",
    "currency": "USD",
    "price": 9990,
    "signedTransactionInfo": "<original JWS>",
    "rawDecodedPayload": { /* full decoded JWS for advanced consumers */ }
  }
}
```

**Response 200 (invalid):**
```json
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Transaction ID not found in production or sandbox"
}
```

### 4.2 Google verification

```http
POST /v1/google/verify
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "packageName": "com.example.app",
  "productId": "premium_monthly",
  "purchaseToken": "...",
  "type": "subscription"   // or "product"
}
```

**Response 200:**
```json
{
  "valid": true,
  "purchase": {
    "kind": "androidpublisher#subscriptionPurchaseV2",
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "...",
    "startTime": "2026-04-10T14:22:10.000Z",
    "expiryTime": "2026-05-10T14:22:10.000Z",
    "autoRenewing": true,
    "priceCurrencyCode": "USD",
    "priceAmountMicros": "9990000",
    "countryCode": "US",
    "paymentState": 1,
    "acknowledgementState": 1,
    "orderId": "GPA.1234-5678-9012-34567",
    "rawResponse": { /* full Google Play Developer API response */ }
  }
}
```

### 4.3 Apple webhook receiver

```http
POST /v1/webhooks/apple/:tenantId
Content-Type: application/json

{
  "signedPayload": "<JWS>"
}
```

Attesto will:
1. Look up tenant by `:tenantId`
2. Verify JWS signature using Apple's certificate chain
3. Decode notification payload
4. Persist event to `webhook_events` table
5. Enqueue delivery to tenant's `webhook_callback_url`
6. Return `200 OK` to Apple

### 4.4 Google webhook receiver (Pub/Sub push)

```http
POST /v1/webhooks/google/:tenantId
Content-Type: application/json

{
  "message": {
    "data": "<base64-encoded DeveloperNotification>",
    "messageId": "...",
    "publishTime": "..."
  },
  "subscription": "..."
}
```

Attesto will:
1. Decode base64 data
2. Parse `DeveloperNotification`
3. Persist event
4. For subscription events: optionally re-fetch current state from Google Play API
5. Enqueue delivery to tenant callback
6. Return `200 OK` to Pub/Sub

### 4.5 Outbound webhook delivery (to client)

Attesto delivers events to the tenant's registered `webhook_callback_url`:

```http
POST <tenant_webhook_callback_url>
Content-Type: application/json
X-Attesto-Event: apple.subscription.renewed
X-Attesto-Event-Id: <notificationUUID>
X-Attesto-Timestamp: 1744464130
X-Attesto-Signature: t=<unix_ts>,v1=<hex_hmac>

{
  "event": "apple.subscription.renewed",
  "eventId": "abc-123-def",
  "timestamp": "2026-04-18T14:22:10.000Z",
  "tenantId": "tenant_xyz",
  "source": "apple",
  "data": {
    /* normalized event payload */
  },
  "raw": {
    /* original decoded Apple/Google payload */
  }
}
```

- HMAC is `HMAC-SHA256(webhook_secret, timestamp + "." + body)` in `v1` format
- Retry policy: exponential backoff (30s, 2m, 10m, 1h, 6h) up to 24h total
- Mark event `delivered` on 2xx response, `failed` after max retries

### 4.6 Health endpoints

```http
GET /health       # → 200 OK {"status":"ok"}
GET /ready        # → 200 OK if DB reachable and credentials decryptable
```

### 4.7 Error response format

```json
{
  "valid": false,
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": { /* optional context */ }
}
```

Standard error codes:
- `UNAUTHENTICATED` — missing or invalid API key
- `TENANT_NOT_FOUND`
- `CREDENTIALS_MISSING` — tenant hasn't configured Apple/Google creds
- `INVALID_REQUEST` — malformed body
- `TRANSACTION_NOT_FOUND`
- `SIGNATURE_INVALID`
- `APPLE_API_ERROR` / `GOOGLE_API_ERROR` — pass-through with details
- `RATE_LIMITED`
- `INTERNAL_ERROR`

---

## 5. Data Model

### Tables

#### `tenants`
```sql
CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,              -- e.g., "tenant_01HXYZ..."
  name            TEXT NOT NULL,                  -- display name
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active       BOOLEAN NOT NULL DEFAULT true
);
```

#### `api_keys`
```sql
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,              -- "key_..."
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash        TEXT NOT NULL,                  -- SHA-256 of actual key
  key_prefix      TEXT NOT NULL,                  -- First 8 chars, for identification
  name            TEXT,                           -- "production", "staging", etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX api_keys_key_hash_idx ON api_keys(key_hash) WHERE revoked_at IS NULL;
```

#### `apple_credentials`
```sql
CREATE TABLE apple_credentials (
  tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id         TEXT NOT NULL,
  key_id            TEXT NOT NULL,                -- Apple Key ID
  issuer_id         TEXT NOT NULL,                -- App Store Connect issuer ID
  private_key_enc   BYTEA NOT NULL,               -- encrypted .p8 contents
  environment       TEXT NOT NULL DEFAULT 'production',  -- 'production' | 'sandbox' | 'auto'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `google_credentials`
```sql
CREATE TABLE google_credentials (
  tenant_id            TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  package_name         TEXT NOT NULL,
  service_account_enc  BYTEA NOT NULL,             -- encrypted service account JSON
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `webhook_configs`
```sql
CREATE TABLE webhook_configs (
  tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  callback_url      TEXT NOT NULL,
  secret_enc        BYTEA NOT NULL,               -- HMAC secret for outbound signing
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `webhook_events`
```sql
CREATE TABLE webhook_events (
  id                TEXT PRIMARY KEY,              -- "evt_..." (internal ID)
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  source            TEXT NOT NULL,                 -- 'apple' | 'google'
  external_id       TEXT NOT NULL,                 -- Apple notificationUUID or Google messageId
  event_type        TEXT NOT NULL,                 -- normalized event name
  raw_payload       JSONB NOT NULL,
  decoded_payload   JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)          -- idempotency
);
CREATE INDEX webhook_events_tenant_received_idx
  ON webhook_events(tenant_id, received_at DESC);
```

#### `webhook_deliveries`
```sql
CREATE TABLE webhook_deliveries (
  id                TEXT PRIMARY KEY,              -- "del_..."
  event_id          TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  callback_url      TEXT NOT NULL,
  attempt_count     INT NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed'
  last_attempt_at   TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ,
  last_response_code INT,
  last_response_body TEXT,
  delivered_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_pending_idx
  ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
```

#### `validation_audit` (optional, feature-flagged)
Audit log of every validation request. Off by default because of volume.
```sql
CREATE TABLE validation_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  source        TEXT NOT NULL,                   -- 'apple' | 'google'
  identifier    TEXT NOT NULL,                   -- transactionId or purchaseToken hash
  valid         BOOLEAN NOT NULL,
  error_code    TEXT,
  latency_ms    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX validation_audit_tenant_created_idx
  ON validation_audit(tenant_id, created_at DESC);
```

### Encryption

- All `_enc` columns are encrypted at the application layer using **AES-256-GCM**
- Master key comes from env var `ATTESTO_ENCRYPTION_KEY` (32-byte base64)
- Use a KDF-derived per-column subkey (scrypt or HKDF) so the same key isn't reused for all ciphertexts
- Store `nonce || ciphertext || tag` in the BYTEA column
- **Never log plaintext credentials.** Redact on error.

---

## 6. Security Considerations

### API authentication
- API keys are `attesto_live_<random_32_bytes_base64url>` or `attesto_test_...`
- Stored as SHA-256 hash; raw key shown only on creation
- Constant-time comparison when looking up hashes
- Per-tenant rate limiting (default 100 req/s, configurable)

### Apple `.p8` key handling
- Accepted via admin endpoint (or CLI tool) as raw PEM text
- Encrypted immediately with AES-256-GCM, plaintext never logged
- Decrypted in-memory only when needed for JWT signing
- **Never return the key in API responses, even to authenticated admin**

### Google service account JSON
- Same treatment as `.p8` keys
- Contains `private_key` field that must be protected
- Minimum required scope: `https://www.googleapis.com/auth/androidpublisher`

### Apple JWS verification
- Verify JWS signature against Apple's certificate chain
- Pin Apple Root CA (G3 fingerprint) — use Apple's official SDK which does this
- Validate bundle ID matches tenant's configured bundle ID
- Validate environment (production vs sandbox)

### Webhook signature verification (inbound)
- **Apple:** verify JWS signature on `signedPayload`
- **Google:** verify the request is from Google Pub/Sub (check bearer JWT in `Authorization` header if push authentication configured)

### Outbound webhook signing
- HMAC-SHA256 with per-tenant secret
- Include timestamp to prevent replay; clients should reject events older than 5 minutes
- Header format: `X-Attesto-Signature: t=<unix_ts>,v1=<hex_hmac>`
- Signed value: `timestamp + "." + body`

### Rate limiting
- Token bucket per tenant, default 100 req/s burst, 50 req/s sustained
- Return `429` with `Retry-After` header when exceeded

### Logging hygiene
- Structured JSON logs only
- Never log: `.p8` contents, service account JSON, API keys, webhook secrets, full `signedPayload` contents
- Log: tenant ID, request ID, endpoint, status, latency, error code

### Secrets in production
- On Fly.io: use `fly secrets set`
- Local dev: `.env` file (gitignored), loaded via Deno's `--env-file` flag
- Never commit secrets to the repo

---

## 7. Project Structure

```
attesto/
├── README.md                      # Project overview, quickstart, deploy guide
├── LICENSE                        # MIT (confirm with Yev)
├── CONTRIBUTING.md                # How to contribute
├── SECURITY.md                    # Responsible disclosure, security model
├── CHANGELOG.md                   # Keep a changelog
├── Dockerfile                     # Multi-stage Deno build
├── docker-compose.yml             # Local dev + self-hosting (app + postgres)
├── fly.toml                       # Fly.io deployment config
├── deno.json                      # Deno config, tasks, import map
├── deno.lock                      # Lockfile
├── .env.example                   # Documents all env vars
├── .gitignore
├── .dockerignore
├── .github/
│   └── workflows/
│       ├── ci.yml                 # Test + lint on PR
│       ├── docker.yml             # Build + push Docker image
│       └── deploy.yml             # Deploy to Fly on main
├── migrations/                    # Drizzle SQL migrations
│   └── 0000_initial.sql
├── drizzle.config.ts              # Drizzle config
├── src/
│   ├── main.ts                    # Entry point; boots Hono app
│   ├── app.ts                     # Hono app factory (export for tests)
│   ├── config.ts                  # Env var loading + validation (Zod)
│   │
│   ├── routes/
│   │   ├── health.ts              # /health, /ready
│   │   ├── apple.ts               # /v1/apple/verify
│   │   ├── google.ts              # /v1/google/verify
│   │   └── webhooks.ts            # /v1/webhooks/apple/*, /v1/webhooks/google/*
│   │
│   ├── middleware/
│   │   ├── auth.ts                # API key auth
│   │   ├── rate-limit.ts          # Per-tenant rate limiting
│   │   ├── request-id.ts          # Attach request ID
│   │   ├── error.ts               # Error handler; maps exceptions to API errors
│   │   └── logger.ts              # Structured access logs
│   │
│   ├── services/
│   │   ├── apple/
│   │   │   ├── verify.ts          # Main verification logic
│   │   │   ├── client.ts          # App Store Server API client wrapper
│   │   │   ├── jws.ts             # JWS decode + verify helpers
│   │   │   ├── jwt-signer.ts      # JWT signing with .p8 keys
│   │   │   └── types.ts
│   │   ├── google/
│   │   │   ├── verify.ts
│   │   │   ├── client.ts          # Google Play Developer API client
│   │   │   ├── auth.ts            # Service account → OAuth token
│   │   │   └── types.ts
│   │   ├── webhooks/
│   │   │   ├── apple-receiver.ts  # Ingest, verify, persist Apple S2S
│   │   │   ├── google-receiver.ts # Ingest, verify, persist Google RTDN
│   │   │   ├── delivery.ts        # Outbound delivery + HMAC signing
│   │   │   ├── dispatcher.ts      # Background worker that drains pending deliveries
│   │   │   └── signature.ts       # HMAC helpers
│   │   ├── tenants/
│   │   │   ├── api-keys.ts        # Generate, hash, verify API keys
│   │   │   └── credentials.ts     # Load + decrypt tenant creds (with caching)
│   │   └── crypto/
│   │       └── encryption.ts      # AES-256-GCM wrap for credential storage
│   │
│   ├── db/
│   │   ├── client.ts              # Postgres client + Drizzle instance
│   │   ├── schema.ts              # Drizzle schema definitions
│   │   └── queries/               # Typed query functions (tenants.ts, events.ts, etc.)
│   │
│   ├── lib/
│   │   ├── id.ts                  # ID generation (ULID or prefixed random)
│   │   ├── time.ts                # Time utilities
│   │   └── errors.ts              # AppError class + error codes
│   │
│   └── types/
│       └── api.ts                 # Public API request/response types (exported)
│
├── tests/
│   ├── integration/
│   │   ├── apple-verify.test.ts
│   │   ├── google-verify.test.ts
│   │   └── webhooks.test.ts
│   ├── unit/
│   │   ├── crypto.test.ts
│   │   ├── jws.test.ts
│   │   └── signature.test.ts
│   └── fixtures/
│       ├── apple-signed-payload.json
│       └── google-developer-notification.json
│
├── cli/
│   └── attesto-admin.ts           # CLI for tenant/key management (for self-hosters)
│
└── docs/
    ├── deployment.md              # Fly.io + self-hosting guide
    ├── api.md                     # Full API reference
    ├── webhooks.md                # Webhook integration guide
    ├── tenant-setup.md            # How to configure Apple/Google credentials
    └── architecture.md            # Deep-dive on design decisions
```

### `deno.json` starter

```jsonc
{
  "tasks": {
    "dev":        "deno run --watch --allow-net --allow-env --allow-read --env-file src/main.ts",
    "start":      "deno run --allow-net --allow-env --allow-read src/main.ts",
    "test":       "deno test --allow-net --allow-env --allow-read",
    "test:watch": "deno test --watch --allow-net --allow-env --allow-read",
    "lint":       "deno lint",
    "fmt":        "deno fmt",
    "check":      "deno check src/main.ts",
    "db:generate":"drizzle-kit generate",
    "db:migrate": "deno run --allow-net --allow-env --allow-read scripts/migrate.ts",
    "cli":        "deno run --allow-net --allow-env --allow-read cli/attesto-admin.ts"
  },
  "imports": {
    "@hono/hono": "jsr:@hono/hono@^4",
    "@std/crypto": "jsr:@std/crypto@^1",
    "drizzle-orm": "npm:drizzle-orm@^0.36",
    "postgres": "npm:postgres@^3",
    "zod": "npm:zod@^3"
  },
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true
  }
}
```

---

## 8. Environment Variables

Document all in `.env.example`. Load via Deno's `--env-file`.

```bash
# Server
PORT=8080
LOG_LEVEL=info                          # trace | debug | info | warn | error
NODE_ENV=production                     # development | production

# Database
DATABASE_URL=postgres://user:pass@host:5432/attesto

# Encryption
ATTESTO_ENCRYPTION_KEY=<base64 32 bytes>   # Generate: openssl rand -base64 32

# Rate limiting
RATE_LIMIT_PER_SECOND=100
RATE_LIMIT_BURST=200

# Webhook delivery
WEBHOOK_MAX_RETRIES=5
WEBHOOK_DISPATCH_INTERVAL_SECONDS=10
WEBHOOK_TIMEOUT_SECONDS=10

# Feature flags
ENABLE_VALIDATION_AUDIT_LOG=false       # Log every validation request (volume!)
ENABLE_ADMIN_API=false                  # Expose /admin endpoints (self-hosters only)
ADMIN_API_TOKEN=                        # Required if ENABLE_ADMIN_API=true
```

---

## 9. Deployment

### Fly.io (primary managed deployment)

**`fly.toml`:**
```toml
app = "attesto"
primary_region = "sin"   # Singapore, close to Manila

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  LOG_LEVEL = "info"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "suspend"      # Scale to zero on idle
  auto_start_machines = true
  min_machines_running = 1            # Keep 1 warm for webhook reliability
  processes = ["app"]

  [http_service.concurrency]
    type = "requests"
    soft_limit = 100
    hard_limit = 250

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  path = "/health"
  protocol = "http"
  timeout = "5s"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

**Deploy steps:**
```bash
fly launch --no-deploy          # create app
fly postgres create             # managed Postgres
fly postgres attach <pg_app>    # sets DATABASE_URL
fly secrets set ATTESTO_ENCRYPTION_KEY=$(openssl rand -base64 32)
fly deploy
```

### Self-hosting (open source users)

**`docker-compose.yml`:**
```yaml
services:
  attesto:
    image: ghcr.io/nossdev/attesto:latest
    ports:
      - "8080:8080"
    env_file: .env
    environment:
      DATABASE_URL: postgres://attesto:attesto@db:5432/attesto
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - attesto_data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: attesto
      POSTGRES_PASSWORD: attesto
      POSTGRES_DB: attesto
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U attesto"]
      interval: 5s
    restart: unless-stopped

volumes:
  attesto_data:
```

**Dockerfile (multi-stage):**
```dockerfile
FROM denoland/deno:2.0.0 AS builder
WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache src/main.ts
RUN deno compile --allow-net --allow-env --allow-read --output attesto src/main.ts

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/attesto /usr/local/bin/attesto
EXPOSE 8080
CMD ["/usr/local/bin/attesto"]
```

### Portability checklist

- ✅ Standard Dockerfile (no Fly-specific base image)
- ✅ All config via env vars (no `fly.toml` reads in app code)
- ✅ Standard Postgres (no Fly-specific extensions)
- ✅ Standard HTTP health check at `/health`
- ✅ Logs to stdout (works with any log aggregator)
- ✅ `docker-compose.yml` runs identically locally and on any VPS

---

## 10. Implementation Phases

Ship in thin slices. Each phase should be shippable on its own.

### Phase 1 — Project skeleton (est. 0.5 day)
- [ ] Initialize Deno project with `deno.json`, `deno.lock`
- [ ] Set up Hono app with `/health` endpoint
- [ ] Set up Dockerfile + docker-compose.yml (app + postgres)
- [ ] Verify local dev works: `docker compose up` → `curl /health` returns 200
- [ ] Set up Drizzle with initial migration (empty schema stub)
- [ ] GitHub Actions: lint + test on PR
- [ ] Push to `nossdev/attesto` repo

**Exit criteria:** Empty app runs locally and in Docker, CI is green.

### Phase 2 — Tenants + API keys (est. 1 day)
- [ ] Implement `tenants` and `api_keys` tables + migrations
- [ ] Implement API key generation, hashing, verification
- [ ] Implement auth middleware (Bearer token → tenant context)
- [ ] Implement encryption wrapper for credentials (AES-256-GCM)
- [ ] Write CLI: `attesto-admin tenant:create`, `tenant:list`, `key:create`, `key:revoke`
- [ ] Unit tests for crypto, API key lifecycle
- [ ] Integration test: authenticated request with valid/invalid keys

**Exit criteria:** Can create a tenant + API key via CLI, and the auth middleware correctly allows/rejects requests.

### Phase 3 — Apple verification (est. 2-3 days)
- [ ] Implement `apple_credentials` table
- [ ] Admin CLI/endpoint to upload Apple credentials
- [ ] Implement Apple JWT signer (RS256 with `.p8` key)
- [ ] Integrate Apple App Store Server Library for Node.js
- [ ] Implement `POST /v1/apple/verify`
  - [ ] Auto-detect sandbox vs production (try prod first, fall back to sandbox)
  - [ ] Decode + verify signed transaction info
  - [ ] Return normalized + raw payload
- [ ] Test with real Apple sandbox transaction
- [ ] Handle edge cases: expired subscription, revoked, family shared, etc.
- [ ] Document tenant setup for Apple

**Exit criteria:** A real sandbox transaction ID verifies end-to-end and returns correct data.

### Phase 4 — Google verification (est. 2-3 days)
- [ ] Implement `google_credentials` table
- [ ] Admin CLI/endpoint to upload Google service account JSON
- [ ] Implement Google OAuth flow (service account → access token)
  - [ ] Cache access tokens until expiry
- [ ] Implement `POST /v1/google/verify`
  - [ ] Support both subscription and product purchases
  - [ ] Call `purchases.subscriptionsv2.get` or `purchases.products.get`
  - [ ] Return normalized + raw payload
- [ ] Test with real Google Play test purchase
- [ ] Document tenant setup for Google

**Exit criteria:** A real Google Play test purchase token verifies end-to-end.

### Phase 5 — Webhook ingestion (est. 3 days)
- [ ] Implement `webhook_events`, `webhook_deliveries`, `webhook_configs` tables
- [ ] Implement `POST /v1/webhooks/apple/:tenantId`
  - [ ] Verify JWS
  - [ ] Persist event (with idempotency on `notificationUUID`)
  - [ ] Enqueue delivery
- [ ] Implement `POST /v1/webhooks/google/:tenantId`
  - [ ] Decode Pub/Sub envelope
  - [ ] Persist event (with idempotency on `messageId`)
  - [ ] Enqueue delivery
- [ ] Implement outbound delivery worker
  - [ ] HMAC signing
  - [ ] Exponential backoff retry
  - [ ] Mark delivered/failed based on response
- [ ] Use Apple's test notification endpoint to validate the full flow
- [ ] Document webhook setup for tenants (Apple + Google)

**Exit criteria:** Apple's test notification endpoint produces a webhook that's verified, stored, and delivered to a test callback URL with a valid HMAC.

### Phase 6 — Productionization (est. 2 days)
- [ ] Rate limiting middleware (token bucket per tenant)
- [ ] Request ID + structured logging
- [ ] Error handling middleware with consistent response format
- [ ] `/ready` endpoint (DB reachable, creds decryptable)
- [ ] Graceful shutdown (drain in-flight requests)
- [ ] Deploy to Fly.io (staging)
- [ ] Load test with realistic traffic

**Exit criteria:** Service runs on Fly.io with scale-to-zero + 1 warm machine, passes load test, error rates < 0.1%.

### Phase 7 — Documentation + release (est. 1 day)
- [ ] Complete README with quickstart
- [ ] API reference (docs/api.md)
- [ ] Tenant setup guide (Apple + Google)
- [ ] Self-hosting guide
- [ ] Architecture deep-dive
- [ ] Tag v0.1.0 release
- [ ] Publish Docker image to GHCR

**Exit criteria:** A developer with no prior knowledge can read the README and get a working Attesto instance with a test validation in under 30 minutes.

---

## 11. Known Edge Cases & Gotchas

### Apple

- **Sandbox vs production detection:** transactions from sandbox fail in production API and vice versa. Apple's recommendation: try production first, fall back to sandbox on `environment_mismatch` error. Handle this transparently.
- **StoreKit Testing (Xcode):** local testing uses a local CA, not Apple's. Developers may want to pass a custom root fingerprint for StoreKit Testing. Consider a `testRootFingerprint` tenant-level config option.
- **JWS certificate chain:** Apple rotates certs. Use the official SDK which handles this; don't hardcode.
- **`signedTransactionInfo` vs `signedRenewalInfo`:** some notifications contain both. Decode both when present.
- **Family sharing:** `inAppOwnershipType` can be `FAMILY_SHARED`. Pass through; clients decide how to handle.
- **Offer codes / promotional offers:** present in `offerType` and `offerIdentifier`. Pass through raw.
- **Retries in notifications:** Apple retries failed notifications up to 5 times over 3 days. Rely on idempotency keys.

### Google

- **`purchases.subscriptions` vs `purchases.subscriptionsv2`:** use v2. The v1 API is deprecated for new integrations.
- **Pub/Sub setup:** Google RTDN requires the tenant to set up a Pub/Sub topic, grant Google permission to publish, and configure a push subscription to your webhook URL. Document this clearly — it's the most error-prone part of Google setup.
- **Pub/Sub authentication:** push subscriptions can be configured with OIDC auth. Verify the JWT in the `Authorization` header is signed by Google and matches the configured service account.
- **Access token caching:** Google access tokens last ~1 hour. Cache in memory, refresh proactively before expiry. Don't refresh on every request.
- **Purchase state interpretation:** `paymentState` is 0=pending, 1=received, 2=free trial, 3=pending deferred upgrade/downgrade. Pass through; don't interpret.

### General

- **Clock skew:** for HMAC timestamp validation, allow 5 minutes of skew.
- **Large webhook payloads:** Apple/Google payloads are small (<10KB typically), but set reasonable body size limits (e.g., 1MB max).
- **Concurrent webhook deliveries:** don't spawn unbounded promises. Use a worker with bounded concurrency (e.g., process 10 deliveries in parallel max).
- **Database connection pool:** tune for Fly's scale-to-zero. Start with pool size 5, adjust based on load.
- **Cold start and webhooks:** when scaled to zero, a webhook will cold-start the machine (~500ms). Apple/Google retry on timeout. Keep `min_machines_running = 1` to avoid this for paying clients.

---

## 12. Open Source Strategy

### Repository setup
- **License:** MIT (confirm with Yev)
- **Org:** `nossdev` on GitHub
- **Visibility:** Public from day one
- **README:** Clear positioning — "thin validation proxy, not RevenueCat"
- **Contributing:** Accept PRs, but be clear about scope (no entitlement management)

### Managed offering positioning
- Self-hosted: free forever, fully functional
- Managed (hosted by Night Owl Software Studios): ~₱3,500-7,500/month per app, depending on scale
- The value of managed: no credential rotation, no Apple/Google API change monitoring, responsive support

### Branding in the code
- Don't include "Night Owl" branding in the open source code itself
- `nossdev` org attribution is fine
- Docker image: `ghcr.io/nossdev/attesto`

---

## 13. Testing Strategy

### Unit tests
- Crypto primitives (encryption roundtrip, HMAC signing)
- JWT signing (Apple)
- JWS decoding
- API key generation + verification
- Webhook signature generation + verification

### Integration tests
- Full Hono app with mocked Apple/Google clients
- Real Postgres via docker-compose (spin up in CI)
- Auth middleware: valid key, invalid key, revoked key, missing key
- Webhook ingestion: idempotency, signature failures, delivery retry logic

### End-to-end tests (manual, at least initially)
- Real Apple sandbox purchase → verify via Attesto
- Real Google Play test purchase → verify via Attesto
- Apple test notification → delivered to a request bin
- Google test notification → delivered to a request bin

### Load testing
- Use `oha` or `k6` to simulate 1000 req/s validation traffic
- Ensure p99 latency < 500ms (validation calls go out to Apple/Google, so latency is bounded by their APIs)

---

## 14. Non-Goals (Explicit)

These will be asked for. Say no. If they're important enough, they go in a separate product.

- ❌ Subscription entitlement state ("is user X premium?")
- ❌ Webhook event replay UI
- ❌ Revenue analytics / dashboards
- ❌ Paywall management
- ❌ A/B testing for IAPs
- ❌ Customer support tooling
- ❌ Offer code / promo code management
- ❌ Fraud detection beyond basic signature verification
- ❌ Multi-platform normalization (one unified "Subscription" model across Apple/Google) — return raw per-platform data and let clients normalize
- ❌ Web SDK — this is a server-to-server service only

---

## 15. Quick Reference for Claude Code

### When starting a new session
1. Read this PLAN.md in full first
2. Check `CHANGELOG.md` for what's been done
3. Check GitHub Issues / project board for current priorities
4. Run `deno task test` to make sure baseline is green before changes

### Commit style
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- One logical change per commit
- Link to issue numbers when relevant

### Before opening a PR
- `deno task fmt` — auto-format
- `deno task lint` — lint clean
- `deno task check` — typecheck
- `deno task test` — all tests pass
- Update CHANGELOG.md under `## [Unreleased]`

### Decisions already made (do not re-litigate)
- **Name:** Attesto (Latin-derived, means "to attest/certify")
- **Stack:** Deno + Hono + PostgreSQL + Drizzle
- **Scope:** Thin validation proxy, NOT entitlement management
- **Deploy:** Fly.io primary, Docker-portable for self-hosters
- **License:** MIT (pending final confirmation)
- **Org:** `nossdev` on GitHub

### When in doubt
- Prefer Apple's official App Store Server Library over community libraries
- Prefer Google's official `googleapis` package
- Return raw platform payloads alongside normalized data — let clients access everything
- Fail closed on any signature/auth failure
- Never log credentials or full webhook payloads at info level (use debug/trace if needed)

---

*End of plan. Happy shipping.*

# Architecture

Attesto is intentionally small. The design rules — _stateless validation path,
stateful webhook path, per-tenant credential isolation, signed everything_ —
drove every implementation choice. This page walks the actual code paths so
future-you (or a contributor) can map any incoming request to the few files
responsible for it.

## High-level flow

There are two distinct request paths through Attesto:

```
Validation path (stateless)           Webhook path (stateful)
─────────────────────────             ─────────────────────────

Your backend                          Apple / Google
    │                                     │  signed event
    │  POST /v1/apple/verify              ▼
    │  Authorization: Bearer …            POST /v1/webhooks/apple/:tenantId
    ▼                                     │  POST /v1/webhooks/google/:tenantId
auth middleware                           │
    │  Bearer → tenant lookup             ▼
rate-limit middleware                 origin verification
    │  per-tenant token bucket             │  Apple: JWS sig
    ▼                                     │  Google: OIDC JWT
tenant credentials loader              ▼
    │  in-memory cache + decrypt      idempotent insert into webhook_events
    ▼                                     │  dedup on notificationUUID / messageId
upstream call                             ▼
    │  Apple: signed JWT + JWS verify  enqueue webhook_deliveries
    │  Google: OAuth + REST                │
    ▼                                     ▼
return verified payload               background dispatcher
                                          │  HMAC-sign → POST callback
                                          │  retry/backoff on non-2xx
                                          ▼
                                      your callback URL
```

Both paths share the same web server, auth model, and database — but they have
very different latency, persistence, and failure-mode characteristics.

## Validation path: stateless

`POST /v1/apple/verify` and `POST /v1/google/verify` are read-only from the
service's perspective. This section walks through the request lifecycle and
mentions a handful of cryptography terms — [JWT](/reference/glossary#jwt),
[JWS](/reference/glossary#jws), [x5c](/reference/glossary#x5c),
[OCSP](/reference/glossary#ocsp). If any are unfamiliar, the
[Glossary](/reference/glossary) has plain-language definitions before you go
deeper.

The flow:

1. **Auth middleware** — `app/middleware/auth.ts`. The `Authorization: Bearer`
   header is parsed, hashed (SHA-256), and looked up against
   `api_keys.key_hash`. The active tenant is attached to the Hono context.
2. **Rate-limit middleware** — `app/middleware/rate-limit.ts`. A per-tenant
   token bucket runs in-memory (per-process). On depletion, throws
   `AppError(RATE_LIMITED)` with `retryAfterSeconds`.
3. **Credential loader** — `app/services/{apple,google}/credentials-loader.ts`.
   In-memory TTL cache with in-flight dedup so N concurrent verifies share one
   DB read + decryption. The decrypted private key / service-account JSON exists
   only in process memory.
4. **Upstream call** — `app/services/apple/client.ts` (App Store Server API) or
   `app/services/google/client.ts` (`androidpublisher` REST). Apple gets an
   ES256-signed [JWT](/reference/glossary#jwt) per request; Google gets a
   service-account-signed JWT exchanged for an OAuth access token (cached until
   expiry).
5. **JWS verification (Apple only)** — `app/services/apple/jws-verifier.ts`.
   Apple's response includes a [JWS](/reference/glossary#jws)
   (`signedTransactionInfo`); Attesto walks the
   [x5c chain](/reference/glossary#x5c) in the JWS header against pinned Apple
   roots (G1 / G2 / G3, bundled with the binary). In production,
   [OCSP](/reference/glossary#ocsp) revocation checks run against Apple's
   responder.
6. **Return** — normalized envelope + raw response.

**The DB is not written on this path.** Optionally (when
`ENABLE_VALIDATION_AUDIT_LOG=true`) a fire-and-forget row is appended to
`validation_audit` after the response — but it never blocks the response, and
any DB error is swallowed so an audit-log failure never fails the verification
call.

## Webhook path: stateful

Inbound webhooks have very different requirements: at-least-once from
Apple/Google, exactly-once delivery to your callback, durable storage for
audit + retry. The flow:

1. **Origin verification** — Apple's JWS signature
   (`app/services/apple/jws-verifier.ts`) or Google's OIDC JWT
   (`app/services/google/oidc-verifier.ts`). Both reject before parsing the body
   so a forged payload can't even reach storage.
2. **Idempotent insert** — `app/services/webhooks/{apple,google}-receiver.ts`.
   The decoded payload's stable identifier (Apple's `notificationUUID` or
   Google's Pub/Sub `messageId`) is the dedup key. The DB has a unique index on
   `(tenant_id, source, external_id)` — so a retry from the store inserts no new
   row.
3. **Enqueue delivery** — `app/services/webhooks/enqueue.ts` writes a row to
   `webhook_deliveries` with `status='pending'` and `next_attempt_at=now()`. The
   callback URL is **snapshotted at enqueue time** — so a mid-retry secret
   rotation uses the current secret, but a callback-URL change takes effect only
   for new events.
4. **Background dispatcher** — `app/services/webhooks/dispatcher.ts`. Runs in a
   single setTimeout loop with **serialized ticks** — the next tick never starts
   until the previous one resolves. Bounded concurrency of 10 per tick.
5. **HMAC-sign + POST** — `app/services/webhooks/delivery.ts`. Signs over
   `<unix_ts>.<body>` using the tenant's webhook secret (decrypted in memory).
   Captures up to 256 chars of the response body and stores it on the
   `webhook_deliveries` row for audit.
6. **Retry on non-2xx** — exponential backoff schedule:
   `[30s, 2m, 10m, 1h, 6h]`. After 6 failed attempts (~7h12m total), the
   delivery is marked `failed` and stops retrying.

The single-instance dispatcher is a limit: horizontal scaling needs a
multi-instance dispatcher with `FOR UPDATE SKIP LOCKED` to prevent
double-delivery. That's tracked as a v0.2 hardening item.

## Data model

Eight tables, all created via Drizzle migrations. Schemas live at
`app/db/schema.ts`.

```
tenants               id PK, name, isActive
api_keys              tenant_id FK, key_hash (SHA-256), key_prefix, revoked_at
                      partial unique index on key_hash WHERE revoked_at IS NULL
apple_credentials     tenant_id PK FK, bundle_id, key_id, issuer_id,
                      private_key_enc BYTEA, environment
google_credentials    tenant_id PK FK, package_name,
                      service_account_enc BYTEA, pubsub_audience
webhook_configs       tenant_id PK FK, callback_url, secret_enc BYTEA, is_active
webhook_events        id PK, tenant_id FK, source, external_id, event_type,
                      raw_payload, decoded_payload
                      UNIQUE(tenant_id, source, external_id)   ← idempotency
webhook_deliveries    id PK, event_id FK, tenant_id FK, callback_url,
                      attempt_count, status, next_attempt_at, response info
                      partial index on next_attempt_at WHERE status='pending'
validation_audit      id PK, tenant_id, source, identifier_hash (HMAC),
                      valid, error_code, latency_ms, occurred_at
                      (feature-flagged via ENABLE_VALIDATION_AUDIT_LOG)
```

## Encryption model

Three columns hold encrypted secrets: `apple_credentials.private_key_enc`,
`google_credentials.service_account_enc`, `webhook_configs.secret_enc`.

All use **AES-256-GCM** with **HKDF-SHA-256-derived per-context subkeys**. The
single master key (`ATTESTO_ENCRYPTION_KEY`) never directly encrypts a column —
instead, HKDF derives a distinct subkey using the column's _context string_ as
the `info` parameter:

```
master key (32 bytes)
    │
    ├── HKDF(info="apple_credentials.private_key")     → AES-256 subkey A
    ├── HKDF(info="google_credentials.service_account") → AES-256 subkey B
    └── HKDF(info="webhook_configs.secret")             → AES-256 subkey C
```

Plaintext compromise of one column does **not** weaken any other column — the
subkeys are cryptographically independent. Storage layout per encrypted value:
`nonce (12B) || ciphertext || tag (16B)`.

The same master key is also used for the **HMAC-keyed audit identifier hash**
via a separate HKDF info namespace (`hmac/<context>`), keeping the HMAC subkey
distinct from the AES subkeys for the same context. This means an operator with
read access to `validation_audit` cannot rebuild a dictionary of transactionId →
hash without also having the master key.

Code: `app/services/crypto/encryption.ts`.

## Threat model

What Attesto's defenses are designed to stop:

- **Forged Apple webhook payloads** — JWS signature against pinned Apple roots.
  A network-level MITM with a valid TLS cert can't inject events.
- **Forged Google webhooks** — OIDC JWT verification against Google's JWKS, with
  audience binding to your specific webhook URL when configured. A stolen Google
  service-account elsewhere can't reach your tenant's webhook endpoint if
  `pubsub_audience` is set.
- **Replay of outbound deliveries** — clients verify `X-Attesto-Signature` with
  a 5-minute timestamp skew window. A captured webhook delivery can't be
  replayed against your endpoint after that window.
- **Cross-tenant credential leakage** — per-tenant FK isolation in the DB,
  per-context encryption subkeys, per-tenant rate-limit buckets.
- **Cross-tenant audit correlation** — `validation_audit.identifier_hash` is
  HMAC-keyed and salted with `tenantId:source:`, so even an operator with full
  DB read can't correlate "tenant A and tenant B both queried this
  transactionId."
- **Exposure via API key leak** — only the SHA-256 hash is stored. A database
  leak doesn't expose live keys; the leaked hash can't be reversed except by
  exhaustive brute-force against a 32-byte random preimage.
- **Apple `.p8` / Google service-account leak via DB read** — encrypted at rest.
  Compromise requires both the DB and the master key.

What Attesto does **not** defend against:

- **Compromise of `ATTESTO_ENCRYPTION_KEY`** — losing the master key means every
  encrypted column is decryptable. Treat it like a TLS private key.
- **Hostile tenant** — a tenant with valid creds can spam verify requests
  (mitigated by rate limits, not eliminated).
- **Compromised callback URL** — Attesto signs deliveries; if your endpoint
  trusts the signature without checking the timestamp, a captured delivery can
  be replayed. Always check both.
- **Network-level DOS** — Attesto runs behind Fly's edge. DDoS protection is the
  platform's job.

## Code map

If you're new to the codebase, the high-leverage entry points:

| Concern                                 | File                                               |
| --------------------------------------- | -------------------------------------------------- |
| HTTP server bootstrap                   | `app/main.ts`                                      |
| Hono app composition (middleware order) | `app/app.ts`                                       |
| Routes — Apple / Google verify          | `app/routes/{apple,google}.ts`                     |
| Routes — inbound webhooks               | `app/routes/webhooks.ts`                           |
| Auth middleware                         | `app/middleware/auth.ts`                           |
| Rate-limit middleware                   | `app/middleware/rate-limit.ts`                     |
| Error envelope + codes                  | `app/lib/errors.ts`                                |
| Encryption + HMAC                       | `app/services/crypto/encryption.ts`                |
| Apple verify orchestration              | `app/services/apple/verify.ts`                     |
| Apple JWS signature verification        | `app/services/apple/jws-verifier.ts`               |
| Google verify orchestration             | `app/services/google/verify.ts`                    |
| Google OIDC JWT verification            | `app/services/google/oidc-verifier.ts`             |
| Webhook receivers                       | `app/services/webhooks/{apple,google}-receiver.ts` |
| Webhook outbound + dispatcher           | `app/services/webhooks/{delivery,dispatcher}.ts`   |
| DB schema                               | `app/db/schema.ts`                                 |
| Admin CLI                               | `app/cli/admin.ts`                                 |

## Next steps

- [API reference](/reference/api) — every endpoint, every response shape
- [Operations](/self-host/operations) — what to monitor, how to scale
- [Maintenance](/self-host/maintenance) — key rotation, retention, upgrades

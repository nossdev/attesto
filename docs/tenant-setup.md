# Tenant setup guide

Operator-facing walkthrough: create a tenant, mint an API key, configure
per-store credentials, and run a verification end-to-end.

> This document is the **single collection point** for setup instructions
> across Attesto. As each phase lands, sections get filled in. The final
> polished version is Phase 7 (`docs/`).

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Tenants and API keys](#2-tenants-and-api-keys)
3. [Apple verification setup](#3-apple-verification-setup)
4. [Google verification setup](#4-google-verification-setup)
5. [Webhooks](#5-webhooks) _(Phase 5 — TBD)_
6. [Deployment](#6-deployment) _(Phase 6 — TBD)_
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

- **[mise](https://mise.jdx.dev)** — toolchain manager (installs Deno + flyctl at pinned versions)
- **Docker** — for local Postgres via `docker compose`
- **`gh` CLI** _(optional)_ — for the GitHub Actions cleanup path in CI

### First-time local setup

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
mise install                             # installs Deno 2.7.12 + flyctl
cp .mise.local.toml.example .mise.local.toml
# → edit .mise.local.toml and set at minimum:
#     DATABASE_URL = "postgres://attesto:attesto@localhost:5432/attesto"
#     ATTESTO_ENCRYPTION_KEY = "$(openssl rand -base64 32)"

mise run db:up                            # starts Postgres in Docker
mise run db:migrate                       # applies all Drizzle migrations
mise run dev                              # starts Attesto on :8080
```

Verify the server is alive:

```bash
curl http://localhost:8080/health
# → {"status":"ok"}
curl http://localhost:8080/ready
# → {"status":"ok","checks":{"db":"ok","encryption":"ok"}}
```

---

## 2. Tenants and API keys

Every request to `/v1/*` is authenticated with a tenant-scoped API key.
A tenant represents one "customer" of an Attesto deployment; in a
self-hosted install, that's probably one app per tenant.

### Create a tenant

```bash
mise run cli -- tenant:create --name "My App"
```

Output (JSON line):

```json
{ "id": "tenant_01HXY...", "name": "My App", "createdAt": "2026-04-18T..." }
```

Save `tenant.id` — you'll use it for subsequent commands.

### Mint an API key

```bash
mise run cli -- key:create tenant_01HXY... --env test --name "dev machine"
```

Options:

- First positional: `tenant_<ULID>` (required)
- `--env`: `live` or `test` (default `live`) — changes the prefix
  (`attesto_live_` vs `attesto_test_`). Use `test` for sandbox traffic.
- `--name`: optional human label for the key, shown in `key:list`

Output (JSON line):

```json
{
  "id": "key_01HXY...",
  "tenantId": "tenant_01HXY...",
  "keyPrefix": "a8Fz3Q1c",
  "name": "dev machine",
  "rawKey": "attesto_test_8xYz...",
  "warning": "Save the rawKey — it cannot be recovered after this line."
}
```

**The `rawKey` is the _only_ time you see the full secret.** Save it
immediately into your client's secret store. Attesto only stores the
SHA-256 hash; there is no recovery path.

### List keys for a tenant

```bash
mise run cli -- key:list tenant_01HXY... [--limit 100] [--offset 0]
```

Each key prints one JSON line with `keyPrefix` (first 8 chars of the
random suffix — safe to display in UIs), `createdAt`, `lastUsedAt`, and
`revokedAt`.

### Revoke a key

```bash
mise run cli -- key:revoke key_01HXY...
```

Revocation is immediate: the partial unique index on the `api_keys`
table makes the key unauthenticable on the next request. Re-running
`key:revoke` on an already-revoked key exits `1` with a clear message.

---

## 3. Apple verification setup

### What you need from Apple

1. **An App Store Connect API key (`.p8` file)** with the
   "App Manager" or "Developer" role.
   - Generate at: App Store Connect → Users and Access → Keys → In-App Purchase
   - Download the `.p8` file **once** (Apple does not allow re-download)
   - Note the **Key ID** (10-char uppercase alphanumeric, shown next to the key)
   - Note the **Issuer ID** (UUID, shown at the top of the Keys page)
2. **Bundle ID** — the app's bundle identifier (e.g., `com.example.app`).
   Must match the bundle the transaction was made against.
3. **A sandbox transaction ID** to verify against (optional until you're
   ready to smoke-test).
   - Obtained by completing a sandbox purchase in a TestFlight build or a
     StoreKit Testing configuration in Xcode.

### Install the credentials

```bash
mise run cli -- apple:set-credentials tenant_01HXY... \
  --bundle-id com.example.app \
  --key-id ABC1234567 \
  --issuer-id 57246542-96fe-1a63-e053-0824d011072a \
  --key-path ~/Downloads/AuthKey_ABC1234567.p8 \
  --environment auto
```

Options:

- `--environment`: `auto` (default — tries production, falls back to sandbox on not-found),
  `production`, or `sandbox`. Hard-pin for StoreKit Testing in Xcode (`sandbox`).

The `.p8` contents are encrypted with AES-256-GCM using a per-column
HKDF-derived subkey before being stored. Plaintext never hits disk
outside the transient `--key-path` read.

Output (JSON line):

```json
{
  "tenantId": "tenant_01HXY...",
  "bundleId": "com.example.app",
  "keyId": "ABC1234567",
  "environment": "auto",
  "updatedAt": "2026-04-18T..."
}
```

### Verify a transaction

```bash
curl -X POST http://localhost:8080/v1/apple/verify \
  -H "Authorization: Bearer attesto_test_..." \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

Optional body fields:

- `environment`: `production` or `sandbox` — overrides the tenant-configured
  environment for this call only

Successful response (`200 OK`):

```json
{
  "valid": true,
  "environment": "sandbox",
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
    "signedTransactionInfo": "<original JWS from Apple>",
    "rawDecodedPayload": {/* full decoded JWS for power users */}
  }
}
```

Negative outcomes (still `200 OK` — invalid transactions are domain
results, not transport errors):

| `error`                 | Cause                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `TRANSACTION_NOT_FOUND` | Apple reports the transactionId doesn't exist in any environment we tried   |
| `BUNDLE_ID_MISMATCH`    | Transaction belongs to a different bundle than the tenant is configured for |

Transport errors (`4xx`/`5xx`):

| Status | `error`               | Cause                                        |
| ------ | --------------------- | -------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing `transactionId` or body >16KB        |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Apple credentials   |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key       |
| 502    | `APPLE_API_ERROR`     | Upstream Apple returned an unexpected status |

### Known limitation (Phase 3)

The server **decodes** Apple's signed transaction JWS but does **not
yet verify Apple's signature** against their certificate chain. Trust
currently rests on TLS to `api.storekit.itunes.apple.com`. A follow-up
hardening pass swaps in
[`@apple/app-store-server-library`'s `SignedDataVerifier`](https://github.com/apple/app-store-server-library-node)
for full cryptographic verification of Apple responses (required before
production use if you don't fully trust your network path to Apple).

---

## 4. Google verification setup

### What you need from Google

1. **A Google Cloud service account** with the **Play Android Developer** role
   on the Play Console account owning your app.
   - Google Cloud Console → IAM & Admin → Service Accounts → Create
   - Add the JSON key: click the service account → Keys → Add Key → JSON.
     Download it **once** and save securely — the private key can't be
     re-downloaded (only reissued).
   - Grant the service account permission in Play Console:
     Users and permissions → Invite new user → paste the service account
     email → grant app-level permissions for the apps you want to verify.
   - The scope Attesto requests on your behalf is
     `https://www.googleapis.com/auth/androidpublisher` — you don't need
     to configure this anywhere; it's baked into every OAuth exchange.
2. **The app's package name** (`com.example.app`). Must match the app the
   purchase was made against.
3. **A test purchase token** (optional until smoke-testing). Obtained by
   using a licensed tester account to make a purchase in an internal /
   closed-track release.

### Install the credentials

```bash
mise run cli -- google:set-credentials tenant_01HXY... \
  --package-name com.example.app \
  --service-account-path ~/Downloads/service-account-12345.json
```

The CLI validates the JSON is a real Google service-account file (checks
`type=service_account` + required fields) **before** encrypting. The
service-account private key is encrypted with AES-256-GCM under its own
HKDF-derived subkey (context `google_credentials.service_account`) —
distinct from the Apple `.p8` subkey, so compromise of one plaintext
does not weaken the other.

Output (JSON line) deliberately omits the raw JSON and the
`client_email` to reduce accidental paste-into-chat risk:

```json
{
  "tenantId": "tenant_01HXY...",
  "packageName": "com.example.app",
  "updatedAt": "2026-04-18T..."
}
```

### Verify a purchase

```bash
curl -X POST http://localhost:8080/v1/google/verify \
  -H "Authorization: Bearer attesto_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "<long-opaque-string-from-the-client>",
    "type": "subscription"
  }'
```

Body fields (all required):

- `packageName`: must match the tenant's configured package
- `productId`: the product / base plan the user bought
- `purchaseToken`: the opaque token your mobile client received from
  Google Play Billing Library
- `type`: `"subscription"` for auto-renewing subs, `"product"` for
  one-shot purchases

Successful subscription response:

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
    "paymentState": null,
    "acknowledgementState": 1,
    "orderId": "GPA.1234-5678-9012-34567",
    "rawResponse": {/* full SubscriptionPurchaseV2 from Google */}
  }
}
```

Note on subscriptions with multiple line items (e.g. base plan + add-on):
the envelope fields (`expiryTime`, `autoRenewing`, `priceAmountMicros`)
reflect **only the first line item**. Clients needing full fidelity
must consume `rawResponse.lineItems` directly.

Successful product response:

```json
{
  "valid": true,
  "purchase": {
    "kind": "androidpublisher#productPurchase",
    "packageName": "com.example.app",
    "productId": "gems_100",
    "purchaseToken": "...",
    "purchaseTimeMillis": "1744464130000",
    "purchaseState": 0,
    "consumptionState": 1,
    "acknowledgementState": 1,
    "orderId": "GPA.5678",
    "rawResponse": {/* full ProductPurchase from Google */}
  }
}
```

Negative outcomes (still `200 OK`):

| `error`                 | Cause                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `PURCHASE_NOT_FOUND`    | Google returned 404 (never existed) or 410 (consumed + gone). The `message` field distinguishes them. |
| `PACKAGE_NAME_MISMATCH` | Request's `packageName` doesn't match the tenant's configured package                                 |

Transport errors:

| Status | `error`               | Cause                                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing required field, `type` not in `subscription\|product`, body >16KB             |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Google credentials                                           |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key                                                |
| 429    | `RATE_LIMITED`        | Google Play quota exceeded. `details.retryAfterSeconds` if Google sent `Retry-After`. |
| 502    | `GOOGLE_API_ERROR`    | Upstream Google returned an unexpected status (500/503/etc.)                          |

### Troubleshooting Google specifically

- **`GOOGLE_API_ERROR` with `details.status: 401`** — the service account
  isn't granted on the Play Console app. Revisit "Users and permissions."
- **`GOOGLE_API_ERROR` with `details.status: 403`** — the service account
  has Play Console access but is missing `androidpublisher` scope in
  Google Cloud. Re-check IAM role.
- **`PURCHASE_NOT_FOUND` for a purchase you KNOW exists** — propagation
  delay. Google can take up to 30s post-purchase to make the token
  queryable.
- **`RATE_LIMITED`** — the free quota is ~200k queries/day per package.
  You're almost certainly not hitting it from verification calls; check
  Google Cloud Console quota page if you see this consistently.

---

## 5. Webhooks

_TBD — lands in Phase 5._

Covers: Apple App Store Server Notifications V2 receiver, Google Play
Real-Time Developer Notifications (Pub/Sub push), HMAC-signed outbound
delivery, retry policy, tenant callback URL configuration.

---

## 6. Deployment

_TBD — lands in Phase 6._ For now, see:

- `Dockerfile` + `docker-compose.yml` for self-hosting
- `PLAN.md` §9 for the Fly.io target

---

## 7. Troubleshooting

### `/ready` returns `{"checks":{}}` with `status: "degraded"`

The app is wired without any readiness checks — `mise run dev` always
supplies DB + encryption checks, so if you see empty `checks` you're
hitting a build that didn't wire `CreateAppOptions.authenticated`. Not
a real failure in production; treat as a config bug.

### `mise run db:migrate` fails with `ECONNREFUSED`

Postgres isn't running. Do `mise run db:up` first, or check `docker
compose ps`.

### `apple:set-credentials` fails with "EC PRIVATE KEY format not supported"

Apple gives you a PKCS#8 `.p8` — that error means the file starts with
`-----BEGIN EC PRIVATE KEY-----` (an OpenSSL-converted form). Re-download
the original from App Store Connect.

### `ATTESTO_ENCRYPTION_KEY must decode to exactly 32 bytes`

Generate with `openssl rand -base64 32`. Common mistake:
`openssl rand -hex 32` gives hex, not base64 — decodes to 64 bytes.

### I lost the raw API key

Mint a new one (`key:create`) and revoke the old one (`key:revoke`).
Raw keys are not recoverable; only the SHA-256 hash is stored.

### `GET /v1/apple/verify` returns 401 even with a valid key

- Check the tenant is active: `mise run cli -- tenant:list` (not revoked)
- Check the key is active: `mise run cli -- key:list <tenant_id>` (no `revokedAt`)
- Check you're using the raw key (starts with `attesto_live_` or `attesto_test_`),
  not the key's `id` or `keyPrefix`

### Apple returns a transaction for a different bundle

`BUNDLE_ID_MISMATCH`. The tenant's configured `bundleId` must match the
app the transaction was made against. Use `apple:set-credentials` to
update with the correct bundle.

### Google service account validation fails despite the file looking correct

`google:set-credentials` requires `type`, `client_email`, `private_key`,
and `token_uri` all present. If you see "not a Google service-account
JSON", re-download the key file — exporting an OAuth client (mistakenly)
produces superficially similar JSON that's missing `type=service_account`.

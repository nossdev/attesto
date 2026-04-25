# API reference

Attesto exposes a small HTTP surface — six endpoints, all under `/v1/` or
the unversioned health namespace. This page is the canonical specification
for every request and response shape.

## Conventions

- All paths are absolute — Attesto does not prefix with anything beyond `/`.
- Authenticated endpoints require `Authorization: Bearer attesto_<env>_<random>`.
- Request bodies are JSON; `Content-Type: application/json` is required.
- Responses are JSON; `Content-Type: application/json; charset=utf-8`.
- Every response includes `X-Request-Id: req_<ULID>` for correlation with
  server logs.
- Domain-level "this transaction doesn't exist" results return `200 OK`
  with `valid: false`. Transport / auth / upstream failures return non-2xx.

## Authentication

```http
Authorization: Bearer attesto_live_8xYzKj2pNm4QrVtA9bC1dF6gH8jL0mN3pQ4rS6tU
```

The Bearer token format is `attesto_<env>_<43-char-base64url>` where `env`
is `live` or `test`. Both environments grant the same access; the prefix
is informational. Mint keys via
[`tenants` guide](/guide/tenants#mint-a-key).

Auth failures return `401 UNAUTHENTICATED`.

## Rate limiting

Per-tenant token bucket: `RATE_LIMIT_PER_SECOND=100` refill, `RATE_LIMIT_BURST=200`
(defaults; configurable via env). Exceeding the bucket returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3
Content-Type: application/json

{
  "valid": false,
  "error": "RATE_LIMITED",
  "message": "Rate limit exceeded",
  "details": { "retryAfterSeconds": 3 }
}
```

The `Retry-After` header is set per RFC 7231; honor it.

---

## `POST /v1/apple/verify`

Verifies an Apple App Store transaction.

### Request

```http
POST /v1/apple/verify
Authorization: Bearer attesto_live_…
Content-Type: application/json

{
  "transactionId": "2000000123456789",
  "environment": "production"
}
```

| Field           | Type                          | Required | Notes                                                                                    |
| --------------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `transactionId` | string (1-128)                | yes      | Apple's `transactionId` from the StoreKit receipt                                        |
| `environment`   | `"production"` \| `"sandbox"` | no       | Override per-call. If omitted, uses tenant config (`auto` tries production then sandbox) |

Body must be ≤16KB.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

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
    "webOrderLineItemId": "210000123456789",
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
    "rawDecodedPayload": { /* full decoded JWS */ }
  }
}
```

`price` is in the smallest currency unit (cents for USD, etc.) per Apple's
convention. `signedTransactionInfo` is the original JWS — pass it through
to a client that wants to re-verify independently. `rawDecodedPayload`
includes every field Apple returned, including ones not in the
normalized envelope.

### Domain-failure response (still 200)

```json
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Transaction ID not found in production or sandbox"
}
```

| `error`                 | Meaning                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `TRANSACTION_NOT_FOUND` | Apple has no record of this `transactionId` in any tried environment |
| `BUNDLE_ID_MISMATCH`    | Transaction's bundle differs from the tenant's configured bundle     |

### Error responses

| Status | `error`               | When                                        |
| ------ | --------------------- | ------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing/invalid body, body >16KB            |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Apple credentials  |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key      |
| 429    | `RATE_LIMITED`        | Tenant exceeded rate limit                  |
| 502    | `APPLE_API_ERROR`     | Upstream Apple returned unexpected status   |
| 500    | `INTERNAL_ERROR`      | Anything else; check `X-Request-Id` in logs |

---

## `POST /v1/google/verify`

Verifies a Google Play purchase token.

### Request

```http
POST /v1/google/verify
Authorization: Bearer attesto_live_…
Content-Type: application/json

{
  "packageName": "com.example.app",
  "productId": "premium_monthly",
  "purchaseToken": "<long-opaque-string>",
  "type": "subscription"
}
```

| Field           | Type                            | Required | Notes                                      |
| --------------- | ------------------------------- | -------- | ------------------------------------------ |
| `packageName`   | string (1-200)                  | yes      | Must match the tenant's configured package |
| `productId`     | string (1-200)                  | yes      | The product / base plan ID                 |
| `purchaseToken` | string (1-4096)                 | yes      | Token from Google Play Billing Library     |
| `type`          | `"subscription"` \| `"product"` | yes      | Subscription or one-shot product           |

Body must be ≤16KB.

### Subscription success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

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
    "rawResponse": { /* full SubscriptionPurchaseV2 from Google */ }
  }
}
```

`priceAmountMicros` is Google's convention: amount × 1,000,000. `9990000`
= $9.99 USD.

::: warning Multi-line-item subscriptions
The envelope fields (`expiryTime`, `autoRenewing`, `priceAmountMicros`)
reflect **only line item 0**. Subscriptions with multiple line items need
to consume `rawResponse.lineItems` for full fidelity.
:::

### Product success response

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

### Domain-failure response (still 200)

| `error`                 | Meaning                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `PURCHASE_NOT_FOUND`    | Google returned 404 (never existed) or 410 (consumed + gone). Distinguish via `message`. |
| `PACKAGE_NAME_MISMATCH` | Request's `packageName` doesn't match the tenant's configured package                    |

### Error responses

| Status | `error`               | When                                                                                                                     |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 400    | `INVALID_REQUEST`     | Missing/invalid body, `type` not `subscription`/`product`, body >16KB                                                    |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Google credentials                                                                              |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key                                                                                   |
| 429    | `RATE_LIMITED`        | Tenant exceeded rate limit, OR Google Play API quota exceeded (`details.retryAfterSeconds` if Google sent `Retry-After`) |
| 502    | `GOOGLE_API_ERROR`    | Upstream Google returned unexpected status                                                                               |
| 500    | `INTERNAL_ERROR`      | Anything else                                                                                                            |

---

## `POST /v1/webhooks/apple/:tenantId`

Inbound webhook receiver for Apple App Store Server Notifications V2.
This endpoint is **NOT API-key authenticated** — origin authentication is
cryptographic via JWS verification.

### Request

Apple sends:

```http
POST /v1/webhooks/apple/tenant_01HXY...
Content-Type: application/json

{
  "signedPayload": "<JWS string>"
}
```

Body must be ≤1MB. Apple's notifications are typically <10KB; the cap is
for safety.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "eventId": "evt_01HXY...",
  "externalId": "<notificationUUID>",
  "isNew": true,
  "enqueuedDelivery": true
}
```

`isNew: false` means Attesto saw this `notificationUUID` before
(idempotency dedup); the first delivery already fired.

### Error responses

| Status | `error`               | When                                                                      |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing/empty `signedPayload`, body >1MB, malformed body                  |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Apple credentials (required for bundle-ID match) |
| 401    | `SIGNATURE_INVALID`   | JWS signature doesn't verify against Apple roots                          |
| 404    | `TENANT_NOT_FOUND`    | Path tenant ID doesn't exist or is inactive                               |
| 500    | `INTERNAL_ERROR`      | Anything else                                                             |

Apple retries on non-2xx for up to 3 days, so even a transient `INTERNAL_ERROR`
will get retried — your callback eventually receives the event.

---

## `POST /v1/webhooks/google/:tenantId`

Inbound webhook receiver for Google Play Real-Time Developer Notifications
via Pub/Sub push subscription. Like Apple, **NOT API-key authenticated** —
origin auth is the OIDC JWT in the `Authorization` header.

### Request

Pub/Sub push sends:

```http
POST /v1/webhooks/google/tenant_01HXY...
Authorization: Bearer <Google-OIDC-JWT>
Content-Type: application/json

{
  "message": {
    "data": "<base64-encoded-DeveloperNotification-JSON>",
    "messageId": "...",
    "publishTime": "..."
  },
  "subscription": "..."
}
```

Body must be ≤1MB.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "eventId": "evt_01HXY...",
  "externalId": "<messageId>",
  "isNew": true,
  "enqueuedDelivery": true
}
```

### Error responses

| Status | `error`             | When                                                                       |
| ------ | ------------------- | -------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`   | Missing/empty body, malformed Pub/Sub envelope, body >1MB                  |
| 401    | `UNAUTHENTICATED`   | Missing or invalid OIDC JWT                                                |
| 401    | `SIGNATURE_INVALID` | OIDC JWT signature didn't verify against Google JWKS, or audience mismatch |
| 404    | `TENANT_NOT_FOUND`  | Path tenant ID doesn't exist or is inactive                                |
| 500    | `INTERNAL_ERROR`    | Anything else                                                              |

---

## `GET /health`

Liveness check. Returns 200 if the HTTP server is alive.

```http
GET /health

HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok" }
```

Used by Docker `HEALTHCHECK`, Fly's basic health probe, and load balancer
back-ends. **Does NOT** verify the database is reachable — for that,
use `/ready`.

---

## `GET /ready`

Readiness check. Returns 200 only when the database is reachable and the
encryption key decodes.

```http
GET /ready

HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "checks": {
    "db": "ok",
    "encryption": "ok"
  }
}
```

Degraded:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "status": "degraded",
  "checks": {
    "db": "fail: connection refused",
    "encryption": "ok"
  }
}
```

Used by Fly's deeper health probe and as a deploy gate. A failing
`/ready` aborts the deploy and keeps the previous version serving.

---

## Outbound webhook delivery

Attesto POSTs to your callback URL when an inbound webhook event has been
verified and dedup'd. See [Webhooks](/guide/webhooks#outbound-delivery-format)
for the full delivery format and signature verification examples in JS,
Python, and Go.

Headers:

| Header                | Example                              |
| --------------------- | ------------------------------------ |
| `X-Attesto-Event`     | `apple.did_renew.auto_renew_enabled` |
| `X-Attesto-Event-Id`  | `evt_01HXY...`                       |
| `X-Attesto-Timestamp` | `1744464130`                         |
| `X-Attesto-Signature` | `t=1744464130,v1=<hex-hmac-sha256>`  |

Body shape:

```json
{
  "event": "apple.did_renew.auto_renew_enabled",
  "eventId": "evt_01HXY...",
  "externalId": "...",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "tenantId": "tenant_01HXY...",
  "source": "apple",
  "data": {/* normalized event */},
  "raw": {/* original decoded payload */}
}
```

Retry schedule on non-2xx: `[immediate, 30s, 2m, 10m, 1h, 6h]` then
`failed`.

---

## Error response shape

Every error response (4xx / 5xx) follows this envelope:

```json
{
  "valid": false,
  "error": "<error-code>",
  "message": "<human-readable description>",
  "details": {/* optional, error-specific */}
}
```

See [Error codes](/reference/error-codes) for the complete vocabulary.

## Error codes summary

Quick lookup; full descriptions in [Error codes](/reference/error-codes).

| Code                    | Default status | Where it appears                             |
| ----------------------- | -------------- | -------------------------------------------- |
| `UNAUTHENTICATED`       | 401            | Auth middleware                              |
| `TENANT_NOT_FOUND`      | 404            | Webhook receivers (path tenant ID invalid)   |
| `CREDENTIALS_MISSING`   | 400            | Verify endpoints, Apple webhook receiver     |
| `INVALID_REQUEST`       | 400            | All endpoints with body validation           |
| `TRANSACTION_NOT_FOUND` | 404            | Apple verify (also as `valid:false`)         |
| `SIGNATURE_INVALID`     | 401            | Webhook receivers (Apple JWS, Google OIDC)   |
| `APPLE_API_ERROR`       | 502            | Apple verify (upstream issues)               |
| `GOOGLE_API_ERROR`      | 502            | Google verify (upstream issues)              |
| `RATE_LIMITED`          | 429            | Rate-limit middleware, Google upstream quota |
| `INTERNAL_ERROR`        | 500            | Anything unexpected                          |

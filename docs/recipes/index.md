# Backend recipes

These recipes show how to implement the **client-app backend** that sits between
[`@nossdev/iap`](https://iap.nossdev.com) and Attesto. `@nossdev/iap` is an
open-source Capacitor SDK that handles the **mobile-side** of the purchase flow:
it wraps native StoreKit / Google Play Billing, talks to your backend through a
small set of HTTP endpoints, and caches entitlements locally so reactive UI is
instant. Your backend implements those endpoints; Attesto handles the Apple /
Google verification on your backend's behalf.

Each recipe is a runnable skeleton in one language — pick the one that matches
your stack.

## What you're building

`@nossdev/iap` runs in your mobile app and POSTs receipts to your backend. Your
backend calls Attesto, transforms the verified payload into the shape iap
expects, applies your entitlement rules, and returns to the client.

```
Mobile app (@nossdev/iap)
    │  POST /api/iap/verify/apple  { transactionId, productId, type }
    │  Authorization: Bearer <your user token>
    ▼
Your backend                          ← these recipes
    │  POST /v1/apple/verify  { transactionId }
    │  Authorization: Bearer attesto_live_…
    ▼
Attesto
    │  signs JWT, calls Apple, verifies JWS, returns payload
    ▼
Your backend
    │  derives entitlements from your business rules,
    │  persists, returns iap-shaped response
    ▼
Mobile app
```

## The six endpoints iap calls

| Method | Path                     | Purpose                                                                                              |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POST` | `/api/iap/verify/apple`  | Verify a single Apple transaction                                                                    |
| `POST` | `/api/iap/verify/google` | Verify a single Google purchase                                                                      |
| `GET`  | `/api/iap/entitlements`  | Return the user's currently active entitlements                                                      |
| `POST` | `/api/iap/restore`       | Re-verify a batch of receipts (idempotent, no purchase)                                              |
| `GET`  | `/api/iap/products`      | (Optional) Return the SKU manifest — only called when `config.products` is omitted                   |
| `POST` | `/api/iap/uuid`          | (Optional) Mint-or-lookup the per-user UUID for `appUserId` pre-attach — only called when configured |

Plus the **webhook receiver** Attesto POSTs to (Apple S2S V2 + Google RTDN
events for renewals, cancellations, refunds).

## Endpoint reference

The six endpoints below all live on **your** backend. iap calls them with the
user's bearer token (whatever your client returns from `getAuthHeaders()`); your
handler resolves it to a user, does its job, and returns iap-shaped JSON.

There's also one **additional surface** — the Attesto webhook receiver — that's
direction-reversed (Attesto pushes to you instead of iap pulling). Covered at
the bottom.

### `POST /api/iap/verify/apple`

**What it does.** Verifies a single Apple purchase. When the user completes a
buy on iOS, iap fires this with the StoreKit transaction ID. Your backend asks
Attesto to confirm with Apple, applies your business rules, and returns the
entitlements the user just earned.

**When iap calls it.** Immediately after a successful native purchase, before
iap acknowledges the StoreKit transaction. If your handler returns
`valid: false` or 5xx, iap will NOT acknowledge — the purchase stays pending and
iap retries on next launch.

**Your job:**

- **Authenticate the user.** Decode the bearer token; figure out who's buying.
- **Call Attesto** with the `transactionId` — that's the cryptographic check.
- **Match the productId.** Reject if the verified `productId` doesn't match what
  the client claimed (defense against client spoofing).
- **Derive entitlements** from your domain rules (e.g. `premium_monthly` +
  non-expired → `key: "premium"`).
- **Persist** the new entitlement before returning, so a follow-up GET
  `/entitlements` reflects it.

```json
// Request from iap
{
  "productId": "premium_monthly",
  "transactionId": "2000000123456789",
  "type": "subscription"
}
```

```json
// Success response (iap shape)
{
  "valid": true,
  "transaction": {
    "id": "2000000123456789",
    "productId": "premium_monthly",
    "expiresAt": "2026-05-30T12:00:00.000Z",
    "verifiedAt": "2026-04-30T12:00:00.000Z"
  },
  "entitlements": [
    {
      "key": "premium",
      "productId": "premium_monthly",
      "expiresAt": "2026-05-30T12:00:00.000Z"
    }
  ]
}
```

```json
// Failure response (iap shape — 200 OK, valid: false)
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Transaction not found in production or sandbox"
}
```

> Domain failures (e.g. `TRANSACTION_NOT_FOUND`, `PRODUCT_MISMATCH`) return
> **HTTP 200** with `valid: false`. Reserve non-2xx for transport failures
> (Attesto unavailable, your DB down) so iap's retry semantics work correctly.

::: tip iap recognizes these codes as permanent

`@nosslabs/iap@0.4+` treats `TRANSACTION_NOT_FOUND` and `PRODUCT_MISMATCH` as
**permanently invalid** — recovery removes the transaction from local storage
instead of retrying it on every app launch. Any other `error` string (network
blips, your backend's custom transient codes) is retried.

If your backend returns a custom permanent code (e.g. `USER_BANNED`,
`RECEIPT_REVOKED`), tell iap about it so it won't loop forever:

```ts
import { createIAP, DEFAULT_PERMANENT_ERROR_CODES } from "@nosslabs/iap";

createIAP({
  options: {
    permanentErrorCodes: [
      ...DEFAULT_PERMANENT_ERROR_CODES,
      "USER_BANNED",
    ],
  },
});
```

See iap's
[permanent vs transient classification guide](https://iap.nossdev.com/guide/error-handling#permanent-vs-transient-classification)
for the full picture, including the backend-lag caveat.

:::

### `POST /api/iap/verify/google`

**What it does.** Same as Apple, for Google Play. The shape differs only because
Google's purchase identifier is a `purchaseToken` + `packageName` instead of a
single transaction ID.

**When iap calls it.** Immediately after a successful native purchase on
Android.

**Your job.** Identical to verify/apple — authenticate the user, call Attesto's
`/v1/google/verify`, match the productId, derive entitlements, persist, return
iap-shape.

```json
// Request from iap
{
  "productId": "premium_monthly",
  "purchaseToken": "ojnbalfgmieckdfgjnpekoam.AO-J1Oy...",
  "packageName": "com.example.app",
  "type": "subscription"
}
```

Response shape is identical to `verify/apple`.

### `GET /api/iap/entitlements`

**What it does.** Returns the user's currently-active entitlements. **No Attesto
call needed** — this is a pure read from your database.

**When iap calls it.** On app launch (after `initialize()`), on `iap.refresh()`,
and after every successful purchase/restore so the local cache stays current.
iap then keeps the result in memory and reactive UI components read from it
instantly.

**Your job:**

- **Authenticate the user.**
- **Read** their active entitlements from your database.
- **Optionally filter expired entitlements server-side** so the client never
  sees stale ones (recommended). Or return everything and let the client check
  `expiresAt` — both are valid.

```json
// Response (iap shape)
{
  "entitlements": [
    {
      "key": "premium",
      "productId": "premium_monthly",
      "expiresAt": "2026-05-30T12:00:00.000Z"
    }
  ]
}
```

Empty array (`{ "entitlements": [] }`) is valid and meaningful — the user just
has nothing.

### `POST /api/iap/restore`

**What it does.** Re-verifies a batch of receipts the device already owns. No
new purchase happens; this is the "I already paid, give me back access" flow
after app reinstall, device transfer, or family sharing.

**When iap calls it.** When the user taps a "Restore Purchases" button in your
UI, or when iap detects unfinished native transactions on launch. iap collects
every owned receipt from the platform store and sends them all in one batch.

**Your job:**

- **Authenticate the user.**
- **Loop the batch** — call Attesto's `/v1/apple/verify` or `/v1/google/verify`
  per receipt. Attesto has no batch endpoint; the per-receipt loop happens in
  your handler.
- **Be best-effort.** A dead/refunded receipt in the batch shouldn't fail the
  whole call — `continue` past failures and grant from the receipts that do
  verify.
- **Consolidate** the resulting entitlements across all platforms the user is
  signed into.

```json
// Request from iap
{
  "transactions": [
    {
      "platform": "apple",
      "transactionId": "2000000123456789",
      "productId": "premium_monthly"
    },
    {
      "platform": "google",
      "purchaseToken": "ojnbal...",
      "packageName": "com.example.app",
      "productId": "premium_monthly"
    }
  ]
}
```

Response shape is identical to `verify/apple` (the consolidated `entitlements`
list comes back in the envelope).

### `GET /api/iap/products`

**What it does.** Returns the SKU manifest — the list of products iap should
know about (IDs, types, Android plan IDs). **Optional.** If your mobile client
hardcodes `config.products`, this endpoint is never called and you don't need to
implement it.

**When iap calls it.** During `initialize()`, **only when** `config.products` is
omitted client-side. The client SDK will only know about the products you return
here.

**Why you'd want it.** It lets you change the SKU list without an app store
release — feature flags, A/B mixes, regional pricing tiers, gradual rollouts.
The tradeoff is one extra round-trip on every cold launch.

**Your job:**

- **Optionally authenticate** (same bearer-token convention as the other
  endpoints — useful for per-user catalog scoping; if your catalog is global,
  you can skip).
- **Return the catalog** as a list of `{ id, type, androidPlanId? }` records.
- **Match real store registrations.** Every `id` you return must be a product
  you've actually configured in App Store Connect / Google Play Console —
  otherwise the native purchase flow will fail with "product not found".
- **Set `androidPlanId` on every subscription** — Google Play Billing requires
  the base-plan ID alongside the product ID.

```json
// Response (iap shape)
{
  "products": [
    {
      "id": "premium_monthly",
      "type": "subscription",
      "androidPlanId": "monthly-plan"
    },
    {
      "id": "premium_yearly",
      "type": "subscription",
      "androidPlanId": "yearly-plan"
    },
    { "id": "remove_ads", "type": "product" }
  ]
}
```

Field requirements:

- `id` — must match a product registered in App Store Connect / Google Play
  Console
- `type` — `"subscription"` | `"product"` | `"consumable"`
- `androidPlanId` — **required** when `type === "subscription"` (maps to a Play
  Console base plan ID)

### `POST /api/iap/uuid`

**What it does.** Mints (or returns the existing) per-user UUID v4 that iap
attaches to the StoreKit / Play Billing purchase as `appAccountToken` /
`obfuscatedAccountId`. The UUID surfaces back on Attesto's verify response and
outbound webhook payload as the top-level `appUserId` field, letting your
webhook handler join directly on user identity instead of falling back to the
`subject.key` upsert pattern. **Optional** — only called when your mobile app
opts into the
[`appUserId` async fetcher pattern](https://iap.nossdev.com/guide/getting-started#pre-attaching-a-user-identifier-optional).

**When iap calls it.** Once per `iap.purchase({ appUserId: async () => ... })`
call, immediately before invoking the native StoreKit / Play Billing buy. iap
does NOT cache the result client-side — your backend owns the mint-or-lookup
idempotency.

**Your job:**

- **Authenticate the user.** Standard bearer token — same as the other
  endpoints.
- **Mint or look up.** First call for this user: generate a UUID v4 and persist
  it. Every later call: return the existing UUID. The canonical one-statement
  form is a `UPDATE ... SET col = COALESCE(col, $1) RETURNING
  col` against a
  unique-constrained `iap_user_uuid` column on your users table.
- **Return the UUID v4.** iap validates the response is a strict v4 and rejects
  with `IAPError(INVALID_APP_USER_ID)` otherwise.

```text
// Request from iap — no body, authentication headers only
POST /api/iap/uuid
Authorization: Bearer <user token>
```

```json
// Response (iap shape)
{
  "uuid": "11111111-2222-4333-8444-555555555555"
}
```

> **Why POST and not GET.** The first call mutates state (writes the UUID); GET
> must be safe per HTTP semantics
> ([RFC 9110 §9.2.1](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1)). The
> _application-level_ idempotency comes from the `COALESCE` upsert keyed on the
> authenticated user — not from HTTP method semantics. POST is also
> non-cacheable, so a CDN can't accidentally serve a stale UUID belonging to
> another user. See the language recipes below for full implementations.

### Attesto → your backend: webhook receiver

**What it does.** Receives **server-pushed** events from Attesto for things that
happen _after_ the original purchase: renewals, refunds, billing retries, plan
changes, RTDN. Without this surface, your entitlements drift out of sync with
reality the moment a subscription renews or a user requests a refund.

**When Attesto calls it.** Asynchronously, whenever Apple S2S V2 or Google RTDN
fires upstream. Attesto verifies the upstream signature, deduplicates, and POSTs
an HMAC-signed delivery to **your** callback URL (configured per tenant by your
operator).

**Why this is different from the iap endpoints.** The six endpoints above are
**iap → you** (synchronous, request-response, on user actions). This one is
**Attesto → you** (asynchronous, server-driven, on upstream events). It's the
"state-machine driver" — the iap endpoints are the "point-in-time
confirmations." You need both.

**Your job:**

- **Verify the HMAC signature** on every request. Compute over the raw request
  bytes, with your tenant's webhook secret. Reject in constant time if the
  signature doesn't match. (Skip this and your endpoint becomes spoofable by
  anyone who guesses the URL.)
- **Reject stale timestamps** — the signature header carries a
  `t=<unix_seconds>` claim; reject if `|now - t| > 300` to block replay attacks.
- **Handle idempotency on `X-Attesto-Event-Id`** — Attesto retries on 5xx, so
  the same event can arrive twice. Persist the event ID on first successful
  handle and short-circuit duplicates.
- **Update entitlement state** based on the event type — extend `expiresAt` on
  renew, revoke on refund, etc.
- **Return 2xx fast.** Anything non-2xx triggers Attesto's retry schedule
  (`30s, 2m, 10m, 1h, 6h`). For transient failures (your DB is down) returning
  5xx is correct; for permanent failures (you don't recognize the event), still
  return 200 and log — there's no benefit to making Attesto retry forever.

The full delivery format (headers + body shape) and per-language receiver code
lives in the recipes below and the [Webhooks reference](/reference/webhooks).
Each language recipe ships a complete, copy-paste-ready receiver.

## What your backend owns (Attesto doesn't)

- **User identity.** iap sends `Authorization: Bearer <user-token>` (whatever
  your client provides via `getAuthHeaders()`). Your backend resolves it to a
  user.
- **Entitlement rules.** Attesto returns the verified transaction; your backend
  decides what `productId=premium_monthly` plus a future `expiresDate` means in
  _your_ domain.
- **Persistence.** Save entitlements keyed by user. Webhook updates (renewals,
  refunds) write here.
- **Idempotency.** Both for client retries and webhook redeliveries — key on
  `transactionId` / `originalTransactionId` (Apple) or `purchaseToken` (Google),
  and on `X-Attesto-Event-Id` for webhooks.
- **Error code naming.** When you return `valid: false`, the `error` string
  travels through to iap. Use `TRANSACTION_NOT_FOUND` and `PRODUCT_MISMATCH` for
  permanent "not valid, never will be" outcomes — iap drops them automatically.
  Invent your own strings for transient outcomes (network failures, rate-limits,
  your backend being unhealthy) and for any custom permanent outcomes; configure
  custom permanent codes in iap's
  [`permanentErrorCodes`](https://iap.nossdev.com/guide/error-handling#permanent-vs-transient-classification)
  so they don't retry forever.

## Pick a recipe

- [Deno + Hono](./deno) — same stack Attesto itself runs on
- [Node + Express](./node) — most common JavaScript backend
- [Python + FastAPI](./python)
- [Java + Spring Boot](./java)
- [Ruby + Sinatra](./ruby)

Each recipe is self-contained: copy the handlers, swap in your auth +
entitlement store, you're done.

## See also

- [Integration guide](/guide/integration) — the canonical reference for calling
  Attesto from any backend
- [Webhooks reference](/reference/webhooks) — full webhook delivery format and
  signature verification
- [API reference](/reference/api) — request/response shapes for every Attesto
  endpoint
- [iap.nossdev.com](https://iap.nossdev.com) — the client SDK these recipes pair
  with

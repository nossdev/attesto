# Backend recipes

These recipes show how to implement the **client-app backend** that sits between
[`@nossdev/iap`](https://iap.nossdev.com) (Capacitor IAP client SDK) and
Attesto. Each recipe is a runnable skeleton in one language — pick the one that
matches your stack.

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

## The five endpoints iap calls

| Method | Path                     | Purpose                                                                            |
| ------ | ------------------------ | ---------------------------------------------------------------------------------- |
| `POST` | `/api/iap/verify/apple`  | Verify a single Apple transaction                                                  |
| `POST` | `/api/iap/verify/google` | Verify a single Google purchase                                                    |
| `GET`  | `/api/iap/entitlements`  | Return the user's currently active entitlements                                    |
| `POST` | `/api/iap/restore`       | Re-verify a batch of receipts (idempotent, no purchase)                            |
| `GET`  | `/api/iap/products`      | (Optional) Return the SKU manifest — only called when `config.products` is omitted |

Plus the **webhook receiver** Attesto POSTs to (Apple S2S V2 + Google RTDN
events for renewals, cancellations, refunds).

## Request and response shapes

### `POST /api/iap/verify/apple`

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

### `POST /api/iap/verify/google`

```json
// Request from iap
{
  "productId": "premium_monthly",
  "purchaseToken": "ojnbalfgmieckdfgjnpekoam.AO-J1Oy...",
  "packageName": "com.example.app",
  "type": "subscription"
}
```

Same response shape as `verify/apple`.

### `GET /api/iap/entitlements`

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

Empty array (`{ "entitlements": [] }`) is valid — the user has none.

### `POST /api/iap/restore`

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

Same response shape as `verify/apple` (with a consolidated `entitlements` list).

### `GET /api/iap/products`

Optional. iap calls this during `initialize()` **only when** `config.products`
is omitted in the client SDK — letting your backend curate which SKUs are
surfaced (feature flags, regional catalogs, evolving catalogs between app
releases). If your client hard-codes `config.products`, you don't need this
endpoint.

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
- `androidPlanId` — required when `type === "subscription"` (maps to a Play
  Console base plan ID)

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

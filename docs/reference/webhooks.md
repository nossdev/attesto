# Webhooks

Reference for the outbound webhook delivery Attesto sends to your callback URL.
For receiver implementations, see the [backend recipes](/recipes/) — every
recipe (Deno, Node, Python, Java, Ruby) includes a working webhook receiver with
[HMAC](/reference/glossary#hmac) verification, replay-window guard, and
idempotency notes.

## Outbound delivery format

Headers Attesto sets on every delivery:

| Header                | Example                              | Meaning                      |
| --------------------- | ------------------------------------ | ---------------------------- |
| `X-Attesto-Event`     | `apple.did_renew.auto_renew_enabled` | Normalized event type        |
| `X-Attesto-Event-Id`  | `evt_01HX...`                        | Attesto-internal event ULID  |
| `X-Attesto-Timestamp` | `1744464130`                         | Unix seconds at sign time    |
| `X-Attesto-Signature` | `t=1744464130,v1=<hex-hmac-sha256>`  | Signature over `<ts>.<body>` |

Body (JSON):

```json
{
  "event": "apple.did_renew.auto_renew_enabled",
  "eventId": "evt_01HX...",
  "externalId": "<apple notificationUUID or google messageId>",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "tenantId": "tenant_01HX...",
  "source": "apple",
  "subject": {
    "key": "2000000123456789",
    "productId": "com.example.premium.monthly",
    "type": "subscription"
  },
  "appUserId": null,
  "data": {/* normalized event payload */},
  "raw": {/* original decoded payload from Apple/Google */}
}
```

TypeScript interface (copy-paste into your handler):

```typescript
interface AttestoWebhookPayload {
  /** Normalized event name, e.g. "apple.subscription.renewed" */
  event: string;
  /** Internal event id (evt_<ULID>) — primary idempotency key */
  eventId: string;
  /** Original Apple notificationUUID / Google messageId */
  externalId: string;
  /** ISO-8601 receive time */
  timestamp: string;
  /** Attesto tenant id (tenant_<ULID>) */
  tenantId: string;
  source: "apple" | "google";
  /**
   * Purchase identity. NULL for events without a transaction
   * (Apple TEST, Google testNotification, refund). See § subject.
   */
  subject: WebhookEventSubject | null;
  /**
   * App-supplied user identity (UUID v4). NULL when the original
   * purchase did not carry one. See § appUserId.
   */
  appUserId: string | null;
  /** Normalized event payload — recommended consumption surface */
  data: Record<string, unknown>;
  /** Original decoded payload from Apple/Google — for power users */
  raw: Record<string, unknown>;
}

interface WebhookEventSubject {
  /** Apple `originalTransactionId` / Google root `purchaseToken` */
  key: string;
  productId: string | null;
  type: "subscription" | "product";
}
```

### `subject`

The unified mapping key for backend user-association. Save `subject.key` at
first verify against your `(platform, key) → userId` table; look it up here when
the webhook fires. Eliminates the need to decode Apple's inner JWS or case-split
between Google's `subscriptionNotification` / `oneTimeProductNotification` to
find the stable identifier.

| Field       | Type                           | Apple source                                  | Google source                                                                                                      |
| ----------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `key`       | `string`                       | `signedTransactionInfo.originalTransactionId` | `subscriptionNotification.purchaseToken` (chain-resolved — see below) / `oneTimeProductNotification.purchaseToken` |
| `productId` | `string \| null`               | `signedTransactionInfo.productId`             | `subscriptionNotification.subscriptionId` / `oneTimeProductNotification.sku`                                       |
| `type`      | `"subscription"` / `"product"` | derived from `signedTransactionInfo.type`     | `subscriptionNotification` → `subscription`; `oneTimeProductNotification` → `product`                              |

**Google subscription chain resolution.** When a user moves between SKUs in the
same subscription group, Google issues a new `purchaseToken` linked to the
previous one via `linkedPurchaseToken`. Attesto fetches the full
SubscriptionPurchaseV2 from Play API on every Google subscription webhook,
records the link, and walks back to the root token before persisting. The
`subject.key` on the outbound payload is therefore always the integrator's
**first-seen original token**, even after multiple upgrades — no fallback logic
on the integrator's side. Apple is unaffected because Apple's
`originalTransactionId` is already stable across renewals.

**`subject` is `null`** for events without a transaction:

- Apple `TEST` notifications (App Store Connect's _Request a Test Notification_
  button or the equivalent App Store Server API call)
- Google `testNotification` envelopes (Play Console's _Send test notification_)
- Google `voidedPurchaseNotification` (refund — `orderId` based, no token field
  on the upstream payload)
- Malformed / unrecognized shapes (Attesto logs and falls through)

This means **probe tests don't exercise the user-mapping path.** Probe tests
prove your webhook URL + HMAC verification work; only a real sandbox purchase
(see
[Integration guide § Step 5](/guide/integration#step-5-test-end-to-end-before-launch))
delivers a populated `subject` and exercises your `(platform, key) → userId`
lookup.

Backend handlers should treat `subject == null` as "ignore for user-mapping
purposes" — the event is still real (eventId / event / data are populated), but
it doesn't tie to a single user record.

### `appUserId`

The app-supplied UUID attached at purchase time. Lets backends join directly on
user identity without going through `subject.key`.

| Type             | Apple source                                        | Google source                                                                                          |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `string \| null` | `signedTransactionInfo.appAccountToken` (inner JWS) | `externalAccountIdentifiers.obfuscatedExternalAccountId` (Play API response — fetched at receive time) |

Always present in the envelope; `null` when the original purchase didn't carry
one (guest flows, pre-existing transactions, SDKs that don't expose
`appAccountToken` / `obfuscatedAccountId`). Backends should use `appUserId` as
the **primary join key** when set, falling back to `subject.key` upsert when
null. See the
[integration guide § mapping webhook events back to users](/guide/integration#mapping-webhook-events-back-to-users)
for the full pattern.

For Google, Attesto's webhook receiver fetches the SubscriptionPurchaseV2 once
per inbound subscription notification (the same call that resolves the
`linkedPurchaseToken` chain — no extra Play API quota burned). For Google
one-time products, voided purchases, and test notifications `appUserId` is
always `null` because the inbound notification doesn't carry external
identifiers and we don't fetch the Play API for those event types.

::: tip Why is `appUserId` a top-level field and not nested under `subject`?

`subject` is **purchase identity** — which subscription / product is this event
about? `appUserId` is **user identity** — which user of your app does the
purchase belong to? The two are orthogonal: a single user has many
subscriptions, and Apple's family-sharing splits the relationship further (one
purchase, multiple users via `inAppOwnershipType`). Nesting `appUserId` under
`subject` would imply the user is a property of the purchase — but it's the
inverse: the purchase belongs to the user. Keep them separate when you store and
query.

:::

### `data` and `raw`

The `data` field is the cleaned-up payload Attesto recommends consuming. The
`raw` field is the original decoded [JWS](/reference/glossary#jws) /
[Pub/Sub](/reference/glossary#pub-sub) envelope, included so power users can
read fields Attesto doesn't surface in `data` or `subject`.

## Signature verification

The `X-Attesto-Signature` header has format
`t=<unix_seconds>,v1=<hex_hmac_sha256>`. The HMAC is computed over
`${t}.${rawBody}` with your tenant's webhook secret as the key. To verify:

1. Parse `t` and `v1` from the header.
2. Reject if `|now - t| > 300` (5-minute replay window).
3. Compute `HMAC-SHA256(secret, "${t}.${rawBody}")` over the **raw bytes**
   Attesto sent (not a JSON-parsed-then-restringified version).
4. Compare with `v1` in constant time (`crypto.timingSafeEqual` /
   `hmac.compare_digest` / `MessageDigest.isEqual` / `OpenSSL` constant-time
   helpers).

Working implementations in 5 languages: see the [backend recipes](/recipes/).

## Retry schedule

If your callback returns anything non-2xx (or doesn't respond within 10
seconds), Attesto retries with this schedule:

| Attempt | Delay since previous | Cumulative |
| ------- | -------------------- | ---------- |
| 1       | immediate            | 0          |
| 2       | 30 seconds           | 30s        |
| 3       | 2 minutes            | 2m30s      |
| 4       | 10 minutes           | 12m30s     |
| 5       | 1 hour               | 1h12m      |
| 6       | 6 hours              | 7h12m      |

After 6 failed attempts (~7h12m), Attesto marks the delivery `failed` and stops
retrying.

## Idempotency

Attesto dedupes inbound events on the upstream's idempotency key (Apple's
`notificationUUID`, Google's Pub/Sub `messageId`), so each underlying upstream
event produces **exactly one** logical delivery from Attesto.

Your callback should also be idempotent on `X-Attesto-Event-Id`. A delivery may
be retried multiple times if your callback returned 5xx on attempt 1 but the
side effect (e.g. updating a subscription state) had already happened. Treat the
same `eventId` as the same logical operation — persist it in a
`processed_events(event_id text primary key, processed_at timestamptz)` table on
your side and check before doing anything destructive.

## Event types

Attesto normalizes upstream events into a stable vocabulary. The `event` header
/ body field uses this format:

```
<source>.<canonical-event-name>
```

Common values:

- `apple.did_renew` — subscription renewed
- `apple.did_fail_to_renew` — billing retry started
- `apple.refund` — transaction refunded by Apple
- `apple.did_change_renewal_status` — auto-renew toggled
- `google.subscription.renewed` — subscription renewed
- `google.subscription.cancelled` — auto-renew cancelled
- `google.subscription.recovered` — recovered from grace period
- `google.product.purchased` — one-shot product confirmed

The complete vocabulary tracks Apple's `notificationType` + `subtype` and
Google's `subscriptionNotification.notificationType` +
`oneTimeProductNotification.notificationType`. The full mapping lives in the
source — see
[`app/services/webhooks/normalize.ts`](https://github.com/nossdev/attesto/blob/main/app/services/webhooks/normalize.ts).

## See also

- [Backend recipes](/recipes/) — runnable receiver implementations
- [Integration guide § Receive webhooks](/guide/integration#step-4-receive-webhooks)
  — narrative integration walkthrough
- [API reference](/reference/api) — verify endpoint specifications
- [Self-host webhooks setup](/self-host/webhooks) — operator-side: registering
  Apple S2S / Google Pub/Sub URLs

# Webhooks

Reference for the outbound webhook delivery Attesto sends to your callback URL.
For receiver implementations, see the [backend recipes](/recipes/) — every
recipe (Deno, Node, Python, Java, Ruby) includes a working webhook receiver with
[HMAC](/reference/glossary#hmac) verification, replay-window guard, and
idempotency notes.

## Outbound delivery format

Headers Attesto sets on every delivery:

| Header                | Example                             | Meaning                                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `X-Attesto-Event`     | `subscription.renewed`              | [Unified event name](#event-types) — same value as the body's `event` |
| `X-Attesto-Event-Id`  | `evt_01HX...`                       | Attesto-internal event ULID                                           |
| `X-Attesto-Timestamp` | `1744464130`                        | Unix seconds at sign time                                             |
| `X-Attesto-Signature` | `t=1744464130,v1=<hex-hmac-sha256>` | Signature over `<ts>.<body>`                                          |

Body (JSON):

```json
{
  "event": "subscription.renewed",
  "reason": null,
  "platformEvent": "apple.did_renew",
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
  /** Unified event name, e.g. "subscription.renewed" — see § Event types */
  event: string;
  /**
   * Sub-classification when the upstream payload carries one (Apple
   * subtypes — e.g. "voluntary" / "billing_retry" for an expiry).
   * NULL when the upstream is undifferentiated (Google's flat numeric
   * codes) or no subtype applies.
   */
  reason: string | null;
  /**
   * Original upstream identifier in Attesto's pre-unification form —
   * `apple.<type>{.<subtype>}` / `google.subscription.<N>` etc.
   * Preserved for debugging, advanced routing, and audit logs.
   */
  platformEvent: string;
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

Attesto delivers events in a unified, platform-agnostic vocabulary so backend
handlers write **one** switch statement that covers both Apple and Google.
Three fields drive event handling:

- **`event`** — the unified noun-verb name (`subscription.renewed`,
  `subscription.refunded`, etc.). Switch on this.
- **`reason`** — finer-grained intent when the upstream payload carries a
  subtype (Apple's `EXPIRED.VOLUNTARY` vs `EXPIRED.BILLING_RETRY`). `null`
  when the upstream is undifferentiated or no subtype applies. Use it to
  choose UX response without branching on `source`.
- **`platformEvent`** — the original upstream identifier
  (`apple.did_renew` / `google.subscription.2`). Preserved for debugging,
  advanced routing, and audit logs.

The full mapping table lives in the source —
[`app/services/webhooks/normalize.ts`](https://github.com/nossdev/attesto/blob/main/app/services/webhooks/normalize.ts).
The reference below is organized by **tier of importance** so you can prioritize
implementation:

- **Tier 1** — fire in normal subscription operation. **Implement these.**
- **Tier 2** — real flows you'll hit in production. **Recommended.**
- **Tier 3** — feature-specific (price changes, promotional offers, EU DMA
  external purchases). Implement only if your app uses the relevant feature.
- **Tier 4** — passthrough (test probes, future events Attesto doesn't yet
  recognize).

### Tier 1 — must handle

#### `subscription.purchased`

A user just bought a subscription for the first time, or resubscribed after a
prior expiry. Grant the entitlement. (Note: most apps already grant on the
verify endpoint response; the webhook is a backup signal in case verify was
missed or the user purchased outside your app.)

**`reason`** values:

- `initial` — first-ever purchase of this subscription group for this account.
- `resubscribe` — purchased again after a prior subscription expired.
- `null` — Google's `SUBSCRIPTION_PURCHASED (4)` doesn't distinguish between
  initial and resubscribe; Attesto reports `reason: "initial"` for it as the
  closest match (see Google's `linkedPurchaseToken` chain to detect
  resubscribe on Google).

**Platform sources:**

| Platform | Upstream event                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`SUBSCRIBED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (subtypes: `INITIAL_BUY`, `RESUBSCRIBE`) |
| Google   | [`SUBSCRIPTION_PURCHASED (4)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                                            |

#### `subscription.renewed`

The subscription auto-renewed normally (no billing problem). Extend
`expiresAt` to the new period end.

**Platform sources:**

| Platform | Upstream event                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Apple    | [`DID_RENEW`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (no subtype) |
| Google   | [`SUBSCRIPTION_RENEWED (2)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                 |

#### `subscription.recovered`

The subscription auto-renewed after a billing-retry period (Apple's
`BILLING_RECOVERY` / Google's `SUBSCRIPTION_RECOVERED`). Extend `expiresAt`
and clear any "in retry" flag. Optionally surface a "thanks, your payment
went through" UI.

**Platform sources:**

| Platform | Upstream event                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`DID_RENEW.BILLING_RECOVERY`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | [`SUBSCRIPTION_RECOVERED (1)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                   |

#### `subscription.cancellation_scheduled`

The user turned off auto-renew but their period hasn't ended yet — they still
have access until `subject.productId`'s `expiresAt`. **Do not revoke
entitlement.** Mark the subscription as "ending at `expiresAt`" so your UI
can show "your subscription ends on …" and avoid trying to renew on your
side.

**Platform sources:**

| Platform | Upstream event                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`DID_CHANGE_RENEWAL_STATUS.AUTO_RENEW_DISABLED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | [`SUBSCRIPTION_CANCELED (3)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                                       |

#### `subscription.cancellation_revoked`

The user re-enabled auto-renew (Apple) or restarted a previously canceled
subscription (Google). Clear the "ending" flag.

**Platform sources:**

| Platform | Upstream event                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`DID_CHANGE_RENEWAL_STATUS.AUTO_RENEW_ENABLED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | [`SUBSCRIPTION_RESTARTED (7)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                                     |

#### `subscription.expired`

The subscription's billing period ended and the user no longer has access.
Revoke the entitlement. Use `reason` to choose UX response — show
"resubscribe" for a voluntary expiry, "update payment method" for billing-
retry exhaustion.

**`reason`** values:

- `voluntary` — user turned off auto-renew and the period ran out.
- `billing_retry` — Apple's billing retry exhausted; subscription was
  force-terminated.
- `product_not_for_sale` — the product was removed from sale before the
  renewal window.
- `null` — Google's `SUBSCRIPTION_EXPIRED (13)` doesn't carry a subtype;
  the reason is unavailable from the upstream payload.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`EXPIRED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (subtypes: `VOLUNTARY`, `BILLING_RETRY`, `PRODUCT_NOT_FOR_SALE`) |
| Google   | [`SUBSCRIPTION_EXPIRED (13)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                                                                  |

#### `subscription.revoked`

The platform forcibly revoked the subscription — different from a user-
initiated cancel. Apple fires `REVOKE` when a family-shared subscription
loses access (the original purchaser canceled, refund cleared, etc.).
Google fires `SUBSCRIPTION_REVOKED` for fraud / refund / family-sharing
revocations. **Revoke the entitlement immediately.**

**Platform sources:**

| Platform | Upstream event                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`REVOKE`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (Family Sharing access lost) |
| Google   | [`SUBSCRIPTION_REVOKED (12)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                             |

#### `subscription.refunded`

The user was refunded — by Apple (App Store Connect refund decision) or by
Google (Play Store refund or chargeback). **Revoke the entitlement and
reverse any provisioned content.** Note: `subject` is `null` for
`google.voided` and (per Apple's payload shape) for some Apple `REFUND`
events; backends look up the user via `data.signedTransactionInfo.transactionId`
(Apple) or `raw.voidedPurchaseNotification.purchaseToken` / `.orderId`
(Google) directly.

**Platform sources:**

| Platform | Upstream event                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Apple    | [`REFUND`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype)      |
| Google   | [`voidedPurchaseNotification`](https://developer.android.com/google/play/billing/rtdn-reference#voided) |

#### `subscription.in_grace_period`

A renewal failed but the platform is giving the user grace-period access
(typically 30 days) while it retries the payment. **Keep the entitlement
active** during grace; optionally surface an "update payment method"
prompt in your app.

**Platform sources:**

| Platform | Upstream event                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`DID_FAIL_TO_RENEW.GRACE_PERIOD`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | [`SUBSCRIPTION_IN_GRACE_PERIOD (6)`](https://developer.android.com/google/play/billing/rtdn-reference#sub)                 |

#### `subscription.in_billing_retry`

A renewal failed and there's no grace period configured — the platform is
silently retrying. Apple-only event (Google rolls billing retry into grace
period). Optionally mark "in retry" without revoking; do not revoke until
`subscription.expired` (with `reason: "billing_retry"`).

**Platform sources:**

| Platform | Upstream event                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`DID_FAIL_TO_RENEW`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (no subtype) |
| Google   | —                                                                                                                          |

#### `subscription.grace_period_expired`

The grace period elapsed without a successful retry. Revoke the
entitlement (or wait for `subscription.expired` — both fire in close
succession).

**Platform sources:**

| Platform | Upstream event                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| Apple    | [`GRACE_PERIOD_EXPIRED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                                |

#### `subscription.on_hold`

Google-only. Billing retry exceeded the grace period — user is on hold,
no service. Revoke entitlement.

**Platform sources:**

| Platform | Upstream event                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------- |
| Apple    | —                                                                                                  |
| Google   | [`SUBSCRIPTION_ON_HOLD (5)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) |

### Tier 2 — recommended

#### `subscription.upgraded` / `subscription.downgraded`

Plan tier changed. Apple fires `SUBSCRIBED` with `UPGRADE` / `DOWNGRADE`
subtypes. Google fires `SUBSCRIPTION_PURCHASED (4)` with a
`linkedPurchaseToken` chain to the previous SKU — Attesto resolves the
chain server-side and surfaces the upgrade as
`subscription.purchased` with `subject.key` pointing at the original
token; integrators that want explicit upgrade events can branch on
`subject.productId` change against their stored history.

**Platform sources:**

| Platform | Upstream event                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`SUBSCRIBED.UPGRADE` / `SUBSCRIBED.DOWNGRADE`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | (derived from `linkedPurchaseToken` chain on a `SUBSCRIPTION_PURCHASED (4)`)                                                            |

#### `subscription.renewal_pref_changed`

The user scheduled a plan change for the next renewal (Apple-only
explicit signal). Stage the change in your UI; don't apply until the next
renewal.

**Platform sources:**

| Platform | Upstream event                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Apple    | [`DID_CHANGE_RENEWAL_PREF.AUTO_RENEW_PREF_CHANGE`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                                                          |

#### `subscription.paused` / `subscription.pause_schedule_changed`

Google-only. Apps that allow users to pause subscriptions get these
notifications. Revoke the entitlement on `paused`; track schedule
changes for your billing logic.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | —                                                                                                                                                                                                                       |
| Google   | [`SUBSCRIPTION_PAUSED (10)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) / [`SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED (11)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) |

#### `subscription.deferred`

Google-only. The developer programmatically deferred the next billing
date via the Play Developer API. Update your stored `expiresAt` to the new
deferred date.

**Platform sources:**

| Platform | Upstream event                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------- |
| Apple    | —                                                                                                   |
| Google   | [`SUBSCRIPTION_DEFERRED (9)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) |

#### `subscription.refund_declined` / `subscription.refund_reversed`

Apple-only. The first signals Apple denied a refund request; the second
that an earlier refund was undone. Re-grant the entitlement on
`refund_reversed`; log only on `refund_declined`.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`REFUND_DECLINED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) / [`REFUND_REVERSED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                                                                                                                                         |

### Tier 3 — feature-specific

#### `subscription.price_change_pending` / `subscription.price_change_accepted` / `subscription.price_change_updated` / `subscription.price_change_rejected`

Pricing change lifecycle. Apple fires `PRICE_INCREASE` with `PENDING` /
`ACCEPTED` subtypes; Google fires three distinct integers
(`SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8)`,
`SUBSCRIPTION_PRICE_CHANGE_UPDATED (19)`,
`SUBSCRIPTION_PRICE_CHANGE_REJECTED (20)`). Required for apps that
raise prices — Apple may require user consent in some regions.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`PRICE_INCREASE.PENDING` / `PRICE_INCREASE.ACCEPTED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype)                                                                                                                                  |
| Google   | [`SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) / [`19`](https://developer.android.com/google/play/billing/rtdn-reference#sub) / [`20`](https://developer.android.com/google/play/billing/rtdn-reference#sub) |

#### `subscription.offer_redeemed`

Apple-only. The user redeemed a promotional offer (intro / win-back /
promotional). Update analytics and any tier-specific entitlement state.

**Platform sources:**

| Platform | Upstream event                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Apple    | [`OFFER_REDEEMED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                          |

#### `subscription.renewal_extended` / `subscription.renewal_extension_complete` / `subscription.renewal_extension_failed`

Apple-only. Fired when you call Apple's Renewal Extension API to extend
subscriptions for customer-success / refund-mitigation purposes.

- `subscription.renewal_extended` — an **individual** renewal extension
  succeeded. Update your stored `expiresAt`.
- `subscription.renewal_extension_complete` — a **mass** (batch) renewal
  extension succeeded (Apple `SUMMARY` subtype).
- `subscription.renewal_extension_failed` — a mass renewal extension
  failed (Apple `FAILURE` subtype). Operator may need to retry the API
  call or notify customer success; no per-user state change.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`RENEWAL_EXTENDED`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (individual) / [`RENEWAL_EXTENSION.SUMMARY`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (mass success) / [`RENEWAL_EXTENSION.FAILURE`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) (mass failure) |
| Google   | —                                                                                                                                                                                                                                                                                                                                                                                                       |

#### `subscription.consumption_request`

Apple-only. Apple requests consumption information when a user asks for a
refund (typically for consumables, sometimes for subscriptions in
contested-refund flows). **You have 12 hours to respond** via Apple's
[Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/send_consumption_information)
endpoint with structured data (lifetime dollars spent, consumption status,
etc.). Attesto does not yet wrap this endpoint — call Apple directly
using the same App Store Server API key you've configured.

**Platform sources:**

| Platform | Upstream event                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Apple    | [`CONSUMPTION_REQUEST`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                               |

#### `subscription.external_purchase_token`

Apple-only. EU DMA-only event for apps using external purchase
entitlement. Most apps don't need this.

**Platform sources:**

| Platform | Upstream event                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`EXTERNAL_PURCHASE_TOKEN`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) |
| Google   | —                                                                                                                   |

#### `subscription.pending_purchase_canceled`

Google-only. A pending-payment purchase (e.g. cash payment via Google Pay
deferred) was canceled before completion. No entitlement change needed
since none was granted.

**Platform sources:**

| Platform | Upstream event                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Apple    | —                                                                                                                     |
| Google   | [`SUBSCRIPTION_PENDING_PURCHASE_CANCELED (17)`](https://developer.android.com/google/play/billing/rtdn-reference#sub) |

#### `product.purchased` / `product.canceled` / `product.charged`

One-time / consumable product events. `product.purchased` and
`product.canceled` are Google one-time-product notifications;
`product.charged` is Apple's `ONE_TIME_CHARGE`. Provision / revoke the
non-subscription entitlement accordingly.

**Platform sources:**

| Platform | Upstream event                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple    | [`ONE_TIME_CHARGE`](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype) → `product.charged`                                                                                                                             |
| Google   | [`oneTimeProductNotification.notificationType: 1`](https://developer.android.com/google/play/billing/rtdn-reference#one-time) → `product.purchased` / [`2`](https://developer.android.com/google/play/billing/rtdn-reference#one-time) → `product.canceled` |

### Tier 4 — passthrough

#### `test`

Apple's [_Request a Test Notification_](https://developer.apple.com/documentation/appstoreserverapi/request_a_test_notification) probe or Google Play
Console's _Send test notification_. **Acknowledge with HTTP 200; no
business logic.** `subject` is `null` — these don't carry a real
transaction.

**Platform sources:**

| Platform | Upstream event     |
| -------- | ------------------ |
| Apple    | `TEST`             |
| Google   | `testNotification` |

#### `unknown`

Reserved fallback. When Apple or Google ships a new notification type
before Attesto's mapping table is updated, deliveries still arrive with
`event: "unknown"` and the upstream identifier preserved on
`platformEvent`. Backends should default-case this, log
`platformEvent` for triage, and ignore the event for state changes.

The presence of `unknown` events in your logs is a signal to check for
an Attesto update.

## See also

- [Backend recipes](/recipes/) — runnable receiver implementations
- [Integration guide § Receive webhooks](/guide/integration#step-4-receive-webhooks)
  — narrative integration walkthrough
- [API reference](/reference/api) — verify endpoint specifications
- [Self-host webhooks setup](/self-host/webhooks) — operator-side: registering
  Apple S2S / Google Pub/Sub URLs

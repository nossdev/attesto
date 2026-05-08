/**
 * Outbound delivery envelope sent to tenant callback URLs.
 *
 * Field semantics:
 *   - `event` is Attesto's unified, platform-agnostic vocabulary
 *     (e.g. `subscription.renewed`). Backends switch on this once and
 *     handle both Apple and Google.
 *   - `reason` carries finer-grained intent when the upstream payload
 *     supplies a subtype (Apple's `EXPIRED.VOLUNTARY` vs `BILLING_RETRY`).
 *     Null when the upstream is undifferentiated (Google's flat numeric
 *     codes) or when no subtype applies. Per-event reason vocabulary
 *     lives in `services/webhooks/normalize.ts` and the public reference
 *     docs.
 *   - `platformEvent` preserves the original upstream identifier
 *     (`apple.did_renew` / `google.subscription.2`) for debugging,
 *     advanced routing, and audit logs. Forward-going events always
 *     populate this; pre-unification rows persisted before the
 *     `platform_event` column existed surface as the empty string `""`
 *     (the wire contract is `string`, never null — see
 *     `delivery.ts:buildPayload`). Treat `""` as "legacy row, no
 *     upstream identifier captured" rather than a meaningful identifier.
 *   - `source` indicates the upstream platform — kept for backends that
 *     want to branch on platform without parsing `platformEvent`.
 */
export interface OutboundWebhookPayload {
  event: string; // unified — e.g. "subscription.renewed"
  reason: string | null; // sub-classification (Apple subtype) or null
  platformEvent: string; // upstream identifier — "apple.did_renew" / "google.subscription.2" / "" for legacy rows
  eventId: string; // internal evt_<ULID>
  externalId: string; // original Apple notificationUUID / Google messageId
  timestamp: string; // ISO-8601 receipt time
  tenantId: string;
  source: "apple" | "google";
  /**
   * Unified mapping key for backend user-association. Save `subject.key` at
   * first verify against your `(platform, key) → userId` table; look it up
   * here when the webhook fires. `null` for events without a transaction
   * (Apple TEST, Google testNotification, etc.) — the backend should
   * ignore those for user-mapping purposes.
   */
  subject: WebhookEventSubject | null;
  /**
   * App-supplied UUID attached at purchase time (Apple's `appAccountToken`
   * / Google's `obfuscatedAccountId`), surfaced as a top-level field so
   * backends can join directly on user identity. NULL when the original
   * purchase did not carry one — fall back to the `subject.key` upsert
   * pattern in that case (see integration guide).
   */
  appUserId: string | null;
  data: Record<string, unknown>; // normalized payload
  raw: Record<string, unknown>; // original decoded payload (JWS / Pub/Sub data)
}

export interface WebhookEventSubject {
  /** Apple: `originalTransactionId` (stable across renewals). Google: `purchaseToken` (stable for sub lifetime). */
  key: string;
  /**
   * Apple: `signedTransactionInfo.productId`.
   * Google subscriptions: `subscriptionNotification.subscriptionId`.
   * Google one-shot products: `oneTimeProductNotification.sku` (canonical
   *   field) or `productId` (older payloads, fallback).
   * Null when the upstream payload omits it.
   */
  productId: string | null;
  /** Coarse classification — useful for routing in the backend handler. */
  type: "subscription" | "product";
}

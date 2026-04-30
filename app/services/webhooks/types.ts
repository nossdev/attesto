/**
 * Outbound delivery envelope sent to tenant callback URLs.
 * Mirrors the shape in PLAN.md §4.5.
 */
export interface OutboundWebhookPayload {
  event: string; // normalized event name, e.g. "apple.subscription.renewed"
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

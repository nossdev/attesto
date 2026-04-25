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
  data: Record<string, unknown>; // normalized payload
  raw: Record<string, unknown>; // original decoded payload (JWS / Pub/Sub data)
}

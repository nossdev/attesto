/**
 * Shared helper for the Apple + Google receivers: look up the tenant's
 * webhook config and enqueue an outbound delivery for a newly-persisted event.
 * If no active config exists, the event stays persisted (audit / backfill)
 * but no delivery is enqueued.
 */

import type { Database } from "@/db/client.ts";
import type { WebhookEvent } from "@/db/schema.ts";
import { enqueueWebhookDelivery, getWebhookConfig } from "@/db/queries/webhooks.ts";

export async function maybeEnqueueDeliveryForEvent(
  db: Database,
  event: WebhookEvent,
): Promise<boolean> {
  const config = await getWebhookConfig(db, event.tenantId);
  if (!config || !config.isActive) return false;
  await enqueueWebhookDelivery(db, {
    eventId: event.id,
    tenantId: event.tenantId,
    callbackUrl: config.callbackUrl,
  });
  return true;
}

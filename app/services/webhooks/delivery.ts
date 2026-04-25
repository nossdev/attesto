/**
 * Single-attempt outbound delivery: HMAC-sign the body and POST it to the
 * tenant callback. Decides the outcome (delivered / retry / failed) based on
 * HTTP status + attempt count; returns the decision for the caller to
 * persist via `updateDeliveryAttempt`.
 */

import type { WebhookDelivery, WebhookEvent } from "@/db/schema.ts";
import type { FetchLike } from "@/lib/http-utils.ts";
import {
  ATTESTO_EVENT_HEADER,
  ATTESTO_EVENT_ID_HEADER,
  ATTESTO_SIGNATURE_HEADER,
  ATTESTO_TIMESTAMP_HEADER,
  signWebhook,
} from "@/services/webhooks/signature.ts";
import type { OutboundWebhookPayload } from "@/services/webhooks/types.ts";

// Backoff schedule per PLAN.md §4.5. Index = attemptCount BEFORE the current
// attempt (0 for first retry, 1 for second, etc.). After the last entry we
// declare the delivery failed.
export const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1; // first + retries

// Tight cap on stored response body — tenants may accidentally echo PII or
// secrets in their callback error responses, and we don't want those sitting
// in our DB long-term. Just enough to surface "404 not found" / error codes.
const RESPONSE_BODY_MAX_CHARS = 256;

export interface DeliveryAttemptInput {
  delivery: WebhookDelivery;
  event: WebhookEvent;
  secret: string;
  fetchImpl?: FetchLike;
  /** Override `now` for deterministic tests. */
  now?: () => Date;
  timeoutMs?: number;
}

export interface DeliveryAttemptOutcome {
  outcome: "delivered" | "retry" | "failed";
  responseCode: number | null;
  responseBody: string | null;
  nextAttemptAt?: Date;
}

function buildPayload(event: WebhookEvent): OutboundWebhookPayload {
  return {
    event: event.eventType,
    eventId: event.id,
    externalId: event.externalId,
    timestamp: event.receivedAt.toISOString(),
    tenantId: event.tenantId,
    source: event.source as "apple" | "google",
    data: event.decodedPayload,
    raw: event.rawPayload,
  };
}

export async function attemptDelivery(
  input: DeliveryAttemptInput,
): Promise<DeliveryAttemptOutcome> {
  const fetchImpl: FetchLike = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const body = JSON.stringify(buildPayload(input.event));
  const timestamp = Math.floor(now().getTime() / 1000);
  const { headerValue } = await signWebhook({
    secret: input.secret,
    body,
    timestamp,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);

  let responseCode: number | null = null;
  let responseBody: string | null = null;
  try {
    const response = await fetchImpl(input.delivery.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ATTESTO_EVENT_HEADER]: input.event.eventType,
        [ATTESTO_EVENT_ID_HEADER]: input.event.id,
        [ATTESTO_TIMESTAMP_HEADER]: String(timestamp),
        [ATTESTO_SIGNATURE_HEADER]: headerValue,
      },
      body,
      signal: controller.signal,
    });
    responseCode = response.status;
    const text = await response.text().catch(() => "");
    responseBody = text.slice(0, RESPONSE_BODY_MAX_CHARS);

    if (response.status >= 200 && response.status < 300) {
      return { outcome: "delivered", responseCode, responseBody };
    }
  } catch (err) {
    // Network error / timeout — attempt counts as failed for this round
    // but the error message is saved truncated for ops diagnostics.
    responseBody = (err instanceof Error ? err.message : String(err)).slice(0, 256);
  } finally {
    clearTimeout(timer);
  }

  const attemptIndex = input.delivery.attemptCount; // 0 = just tried for the first time
  const nextDelaySec = RETRY_SCHEDULE_SECONDS[attemptIndex];
  if (nextDelaySec === undefined) {
    return { outcome: "failed", responseCode, responseBody };
  }
  const nextAttemptAt = new Date(now().getTime() + nextDelaySec * 1000);
  return { outcome: "retry", responseCode, responseBody, nextAttemptAt };
}

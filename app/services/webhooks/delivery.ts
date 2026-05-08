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
import { extractSubject } from "@/services/webhooks/subject.ts";

// Backoff schedule per PLAN.md §4.5. Index = attemptCount BEFORE the current
// attempt (0 for first retry, 1 for second, etc.). After the last entry — or
// after `maxRetries` if the operator capped it lower via WEBHOOK_MAX_RETRIES —
// we declare the delivery failed. config.ts validates that
// WEBHOOK_MAX_RETRIES <= RETRY_SCHEDULE_SECONDS.length so attemptIndex never
// exceeds the schedule's bounds at runtime.
export const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600] as const;
/** Default number of retry attempts when the operator hasn't set
 * WEBHOOK_MAX_RETRIES. Equals the schedule length — using all backoff slots. */
export const DEFAULT_MAX_RETRIES = RETRY_SCHEDULE_SECONDS.length;
/**
 * Total attempts using the default cap (first + DEFAULT_MAX_RETRIES retries).
 * NOT authoritative when the operator overrides WEBHOOK_MAX_RETRIES — in that
 * case real max attempts is `1 + maxRetries`. Used by integration tests that
 * exercise the default-mode loop.
 */
export const DEFAULT_MAX_ATTEMPTS = DEFAULT_MAX_RETRIES + 1;

/** Default per-delivery HTTP timeout. Operators tune via WEBHOOK_TIMEOUT_SECONDS;
 * this fallback exists in case a caller bypasses the dispatcher chain (e.g. a
 * future ad-hoc invocation) so the request can't run unbounded. */
const DEFAULT_TIMEOUT_MS = 10_000;

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
  /** Per-attempt timeout in ms. Defaults to 10_000 (matches the previous
   * hardcoded value); operators tune via WEBHOOK_TIMEOUT_SECONDS. */
  timeoutMs?: number;
  /** Cap the number of retries (excluding the first attempt). Defaults to
   * RETRY_SCHEDULE_SECONDS.length. config.ts validates that operator-supplied
   * values from WEBHOOK_MAX_RETRIES don't exceed the schedule length, so this
   * value is always within bounds at runtime. */
  maxRetries?: number;
}

export interface DeliveryAttemptOutcome {
  outcome: "delivered" | "retry" | "failed";
  responseCode: number | null;
  responseBody: string | null;
  nextAttemptAt?: Date;
}

function buildPayload(event: WebhookEvent): OutboundWebhookPayload {
  const source = event.source as "apple" | "google";
  return {
    event: event.eventType,
    reason: event.reason,
    // Pre-normalize.ts rows persisted before this column existed will have
    // `platform_event = NULL`; surface as empty string on the wire so the
    // outbound envelope's contract (`platformEvent: string`) holds.
    // Forward-going events always populate this from normalize.ts.
    platformEvent: event.platformEvent ?? "",
    eventId: event.id,
    externalId: event.externalId,
    timestamp: event.receivedAt.toISOString(),
    tenantId: event.tenantId,
    source,
    // `event.subjectKey` carries a chain-resolved override for Google
    // subscription events (see services/webhooks/google-chain.ts). NULL for
    // Apple (originalTransactionId is already stable across renewals) and
    // for Google one-time / voided / test events — extractSubject falls
    // back to payload-derived key in those cases.
    subject: extractSubject(source, event.decodedPayload, event.subjectKey),
    // `event.appUserId` was extracted at receive time (Apple inner JWS /
    // Google Play API). When set, the integrator can join directly on user
    // identity; when NULL, fall back to the subject.key upsert pattern.
    appUserId: event.appUserId,
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
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  // Operator-capped: if they've shrunk the retry budget (or hit the schedule
  // ceiling), declare failure now. config.ts enforces
  // maxRetries <= RETRY_SCHEDULE_SECONDS.length so the schedule lookup below
  // is always defined.
  if (attemptIndex >= maxRetries) {
    return { outcome: "failed", responseCode, responseBody };
  }
  const nextDelaySec = RETRY_SCHEDULE_SECONDS[attemptIndex]!;
  const nextAttemptAt = new Date(now().getTime() + nextDelaySec * 1000);
  return { outcome: "retry", responseCode, responseBody, nextAttemptAt };
}

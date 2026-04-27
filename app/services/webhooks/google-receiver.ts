/**
 * Google Real-Time Developer Notifications receiver (Pub/Sub push subscription).
 *
 * Accepts the Pub/Sub envelope:
 *   { message: { data: "<base64>", messageId: "...", publishTime: "..." }, subscription: "..." }
 *
 * Decodes `message.data` (base64 JSON) into Google's DeveloperNotification,
 * dedupes on `messageId`, persists, and enqueues delivery.
 *
 * **OIDC verification is required and is enforced at the route layer**
 * (`routes/webhooks.ts` calls `googleOidcVerifier.verify(...)` before
 * delegating here). Callers that bypass the route — e.g. a future queue
 * worker or CLI replay tool — MUST run the same verification first; this
 * function trusts that auth has already happened.
 */

import type { Database } from "@/db/client.ts";
import { insertWebhookEventIdempotent } from "@/db/queries/webhooks.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { maybeEnqueueDeliveryForEvent } from "@/services/webhooks/enqueue.ts";

export interface ReceiveGoogleWebhookInput {
  tenantId: string;
  body: {
    message?: {
      data?: unknown;
      messageId?: unknown;
      publishTime?: unknown;
    };
    subscription?: unknown;
  };
}

export interface ReceiveGoogleWebhookResult {
  eventId: string;
  externalId: string;
  isNew: boolean;
  enqueuedDelivery: boolean;
}

function base64Decode(value: string): string {
  // Google Pub/Sub uses standard base64 (not base64url) for message data.
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch (err) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Malformed Pub/Sub message.data (not base64)", {
      cause: err,
    });
  }
}

function normalizeGoogleEventType(decoded: Record<string, unknown>): string {
  // Google's DeveloperNotification carries one of:
  //   - subscriptionNotification: { notificationType: 1..N, ... }
  //   - oneTimeProductNotification: { notificationType: 1..N, ... }
  //   - voidedPurchaseNotification: { ... }
  //   - testNotification: { version: "..." }
  //
  // We surface a stable string like "google.subscription.<n>" /
  // "google.product.<n>" / "google.voided" / "google.test". Clients that
  // want the numeric code can read rawDecodedPayload.
  const sub = decoded.subscriptionNotification as Record<string, unknown> | undefined;
  if (sub && typeof sub.notificationType === "number") {
    return `google.subscription.${sub.notificationType}`;
  }
  const otp = decoded.oneTimeProductNotification as Record<string, unknown> | undefined;
  if (otp && typeof otp.notificationType === "number") {
    return `google.product.${otp.notificationType}`;
  }
  if (decoded.voidedPurchaseNotification) return "google.voided";
  if (decoded.testNotification) return "google.test";
  return "google.unknown";
}

export async function receiveGoogleWebhook(
  db: Database,
  input: ReceiveGoogleWebhookInput,
): Promise<ReceiveGoogleWebhookResult> {
  const message = input.body.message;
  if (!message || typeof message.data !== "string" || typeof message.messageId !== "string") {
    throw new AppError(
      ErrorCodes.INVALID_REQUEST,
      "Missing Pub/Sub envelope fields (message.data, message.messageId)",
    );
  }

  const jsonText = base64Decode(message.data);
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Decoded Pub/Sub data is not valid JSON", {
      cause: err,
    });
  }

  const eventType = normalizeGoogleEventType(decoded);

  // Store only the Pub/Sub message envelope fields we need — NOT the wrapper's
  // `subscription` string (e.g. "projects/<gcp-project>/subscriptions/...")
  // which would leak Attesto's internal GCP coordinates to the tenant callback's
  // `raw` field on the outbound delivery.
  const rawPayload: Record<string, unknown> = {
    message: {
      data: message.data,
      messageId: message.messageId,
      publishTime: message.publishTime,
    },
  };

  const { event, isNew } = await insertWebhookEventIdempotent(db, {
    tenantId: input.tenantId,
    source: "google",
    externalId: message.messageId,
    eventType,
    rawPayload,
    decodedPayload: decoded,
  });

  const enqueuedDelivery = isNew ? await maybeEnqueueDeliveryForEvent(db, event) : false;

  return {
    eventId: event.id,
    externalId: message.messageId,
    isNew,
    enqueuedDelivery,
  };
}

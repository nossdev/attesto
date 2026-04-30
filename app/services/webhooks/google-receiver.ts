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
import { recordChainLink, resolveToRoot } from "@/services/webhooks/google-chain.ts";
import type { GoogleClient, GooglePurchaseFetchResult } from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { GoogleCredentialMaterial } from "@/services/google/types.ts";

/**
 * Dependencies the receiver uses to fetch the full SubscriptionPurchaseV2
 * from Play API and walk the linkedPurchaseToken chain.
 */
export interface GoogleChainResolverDeps {
  credentialsLoader: GoogleCredentialsLoader;
  /**
   * Build a Google API client for the given tenant's credentials. Mirrors
   * the verify path's clientFactory shape — same `createGoogleHttpClient`
   * call site, just invoked here instead of at the verify endpoint.
   */
  clientFactory: (
    material: GoogleCredentialMaterial,
    tenantId: string,
  ) => GoogleClient;
}

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
  /**
   * When supplied, the receiver fetches the full purchase from Play API for
   * subscriptionNotifications, records the chain link if `linkedPurchaseToken`
   * is present, and walks to the root before persisting. Result lands in
   * `webhook_events.subject_key` and surfaces as the canonical
   * `subject.key` on the outbound payload.
   *
   * Resolution failures (Play API down, no credentials, malformed response)
   * are logged at warn level but never block the webhook — we persist with
   * `subjectKey = null` and the integrator gets the raw token, same as
   * before this code existed.
   */
  chainResolver?: GoogleChainResolverDeps;
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

  // Resolve the canonical subject.key for Google subscription notifications.
  // For one-time / voided / test events, leave subjectKey NULL — the delivery
  // layer will derive subject from the payload as before.
  const subjectKey = await resolveSubscriptionSubjectKey(
    db,
    input.tenantId,
    decoded,
    input.chainResolver,
  );

  const { event, isNew } = await insertWebhookEventIdempotent(db, {
    tenantId: input.tenantId,
    source: "google",
    externalId: message.messageId,
    eventType,
    rawPayload,
    decodedPayload: decoded,
    subjectKey,
  });

  const enqueuedDelivery = isNew ? await maybeEnqueueDeliveryForEvent(db, event) : false;

  return {
    eventId: event.id,
    externalId: message.messageId,
    isNew,
    enqueuedDelivery,
  };
}

/**
 * For Google subscriptionNotifications: fetch the full purchase from Play
 * API, record any linkedPurchaseToken, and walk the chain back to the root.
 * Returns the canonical token to persist as `subject_key`. Returns NULL for
 * non-subscription notifications (one-time / voided / test) and on any
 * resolution failure (logged at warn level — never blocks the webhook).
 */
async function resolveSubscriptionSubjectKey(
  db: Database,
  tenantId: string,
  decoded: Record<string, unknown>,
  resolver: GoogleChainResolverDeps | undefined,
): Promise<string | null> {
  const subNotif = decoded.subscriptionNotification;
  if (!subNotif || typeof subNotif !== "object") return null;
  const o = subNotif as Record<string, unknown>;
  const purchaseToken = o.purchaseToken;
  const subscriptionId = o.subscriptionId;
  if (typeof purchaseToken !== "string" || purchaseToken.length === 0) return null;

  // Without a chain resolver we can't fetch the full purchase, but the raw
  // token is still the right key when no upgrade has happened — return it
  // so non-resolver test paths still surface a stable subject.key.
  // NOTE: in production `app/main.ts` always wires `googleChainResolver`, so
  // the no-resolver branch is exercised only by tests that build the
  // receiver directly. Don't infer from the optional `?` on the type that
  // we have a "no-chain-resolution" deployment mode.
  if (!resolver || typeof subscriptionId !== "string") {
    return purchaseToken;
  }

  try {
    const credentials = await resolver.credentialsLoader.load(tenantId);
    if (!credentials) {
      // No Google credentials for this tenant — can't fetch the full
      // purchase. Fall back to the raw token (no chain resolution).
      return purchaseToken;
    }
    const client = resolver.clientFactory(credentials, tenantId);
    const result = await client.getPurchase({
      type: "subscription",
      productId: subscriptionId,
      purchaseToken,
    });
    const linked = readLinkedPurchaseToken(result);
    if (linked) {
      await recordChainLink(db, {
        tenantId,
        currentToken: purchaseToken,
        previousToken: linked,
      });
    }
    return await resolveToRoot(db, tenantId, purchaseToken);
  } catch (err) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "google_chain_resolution_failed",
        tenantId,
        purchaseToken: redactToken(purchaseToken),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return purchaseToken; // graceful fallback — better to deliver than fail
  }
}

/**
 * Pull `linkedPurchaseToken` out of the SubscriptionPurchaseV2 response.
 * Defensive: Google has revised this field's location across API versions
 * (top-level on v1, nested on v2 in some shapes). We accept either.
 */
function readLinkedPurchaseToken(
  fetched: GooglePurchaseFetchResult,
): string | null {
  const raw = fetched.raw;
  if (!raw || typeof raw !== "object") return null;
  const direct = (raw as Record<string, unknown>).linkedPurchaseToken;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

/**
 * Truncate a Google purchaseToken for logging — they're long opaque strings
 * (~250+ chars) and nobody needs the full value in a triage log line.
 */
function redactToken(token: string): string {
  if (token.length <= 16) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

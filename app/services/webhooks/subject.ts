/**
 * Extracts the unified `subject` field for the outbound webhook envelope.
 *
 * The "subject" is the stable identifier a backend uses to map a webhook
 * event back to one of its users — saved at first verify, looked up when
 * webhook arrives. See `docs/guide/integration.md#mapping-webhook-events-back-to-users`.
 *
 * Apple:  inner `signedTransactionInfo` JWS → `originalTransactionId`.
 *         The outer notification JWS has already been verified by the
 *         receiver BEFORE this function runs; we use an UNVERIFIED peek
 *         (`decodeJwsPayload`) on the inner. Safety chain: Apple signs the
 *         outer envelope, which contains the inner JWS string as a regular
 *         JSON property — so a verified outer guarantees the inner JWS
 *         string is byte-identical to what Apple emitted. We never trust
 *         the inner JWS *signature*; we trust that the bytes weren't
 *         tampered. INVARIANT: callers MUST pass a payload that was already
 *         decoded from a verified outer JWS. Don't relax that.
 *
 * Google: `subscriptionNotification.purchaseToken` or
 *         `oneTimeProductNotification.purchaseToken` directly.
 *
 * Returns null when the payload doesn't carry a transaction (Apple TEST
 * notifications, Google `testNotification`, malformed shapes). Callers
 * propagate the null to the outbound payload so backend handlers can
 * cleanly distinguish "real event for a known purchase" from "edge".
 */

import { decodeJwsPayload } from "@/services/apple/client.ts";
import type { WebhookEventSubject } from "@/services/webhooks/types.ts";

const APPLE_SUBSCRIPTION_TYPES = new Set([
  "Auto-Renewable Subscription",
  "Non-Renewing Subscription",
]);

/**
 * Extract the unified `subject` for the outbound payload.
 *
 * @param source             "apple" | "google"
 * @param decodedPayload     The platform's decoded notification body
 * @param subjectKeyOverride When non-null, replaces the extracted `key` field
 *   with this value. The receiver populates this for Google subscription
 *   notifications after walking the linkedPurchaseToken chain to its root,
 *   so the outbound `subject.key` is always the canonical original token
 *   even across upgrade/downgrade events. When null/undefined, the key is
 *   read from the payload as-is. Other fields (productId, type) are always
 *   derived from the payload regardless.
 */
export function extractSubject(
  source: "apple" | "google",
  decodedPayload: Record<string, unknown>,
  subjectKeyOverride?: string | null,
): WebhookEventSubject | null {
  const subject = source === "apple"
    ? extractAppleSubject(decodedPayload)
    : extractGoogleSubject(decodedPayload);
  if (!subject) return null;
  // The receiver guarantees `subject_key` is either NULL or non-empty (it's
  // gated on `purchaseToken.length > 0` upstream and the DB column has no
  // default), so an empty-string override here is unreachable in production.
  // The `.length > 0` check is defense-in-depth against a future caller that
  // might pass `""` directly. Truthiness alone (`if (subjectKeyOverride)`)
  // would also work; the explicit length test makes the intent clearer.
  if (subjectKeyOverride && subjectKeyOverride.length > 0) {
    return { ...subject, key: subjectKeyOverride };
  }
  return subject;
}

function extractAppleSubject(payload: Record<string, unknown>): WebhookEventSubject | null {
  // Apple's V2 notification shape: { notificationType, data: { signedTransactionInfo, signedRenewalInfo, ... } }
  const data = payload.data;
  if (!data || typeof data !== "object") return null;
  const signed = (data as Record<string, unknown>).signedTransactionInfo;
  if (typeof signed !== "string" || signed.length === 0) return null;

  let decoded: Record<string, unknown>;
  try {
    decoded = decodeJwsPayload(signed);
  } catch {
    return null;
  }

  const originalTransactionId = decoded.originalTransactionId;
  if (typeof originalTransactionId !== "string" || originalTransactionId.length === 0) return null;

  const productId = typeof decoded.productId === "string" ? decoded.productId : null;
  const rawType = typeof decoded.type === "string" ? decoded.type : "";
  return {
    key: originalTransactionId,
    productId,
    type: APPLE_SUBSCRIPTION_TYPES.has(rawType) ? "subscription" : "product",
  };
}

function extractGoogleSubject(payload: Record<string, unknown>): WebhookEventSubject | null {
  // Google's RTDN: { subscriptionNotification?, oneTimeProductNotification?, voidedPurchaseNotification?, testNotification? }
  const subNotif = payload.subscriptionNotification;
  if (subNotif && typeof subNotif === "object") {
    const o = subNotif as Record<string, unknown>;
    const token = o.purchaseToken;
    if (typeof token === "string" && token.length > 0) {
      return {
        key: token,
        productId: typeof o.subscriptionId === "string" ? o.subscriptionId : null,
        type: "subscription",
      };
    }
  }
  const oneTimeNotif = payload.oneTimeProductNotification;
  if (oneTimeNotif && typeof oneTimeNotif === "object") {
    const o = oneTimeNotif as Record<string, unknown>;
    const token = o.purchaseToken;
    if (typeof token === "string" && token.length > 0) {
      return {
        key: token,
        // Google's RTDN uses `sku` here; some older payloads use `productId`.
        productId: typeof o.sku === "string"
          ? o.sku
          : typeof o.productId === "string"
          ? o.productId
          : null,
        type: "product",
      };
    }
  }
  // voidedPurchaseNotification (refunds): deliberately returns null —
  // integrators handle refunds via the eventType, not subject-mapping. The
  // upstream payload does carry a purchaseToken, but the operation is
  // event-driven (e.g. revoke entitlement), not user-mapping-driven.
  // testNotification / unrecognized: no transaction → no subject.
  return null;
}

/**
 * Unified webhook event vocabulary.
 *
 * Apple App Store Server Notifications V2 and Google Play RTDN both fire
 * the "same" semantic events under different protocol detail (Apple sends
 * `DID_RENEW` strings; Google sends integers like `2`). Receivers normalize
 * upstream events into Attesto's platform-agnostic vocabulary so backend
 * integrators write one switch statement for both stores.
 *
 * The mapping has three outputs:
 *   - `event`: the unified noun-verb name (e.g. `subscription.renewed`).
 *     This is what the outbound webhook envelope's `event` field carries.
 *   - `reason`: a sub-classification, populated when the upstream payload
 *     carries finer-grained intent (Apple subtypes — `voluntary` vs
 *     `billing_retry` for an expiry). Null when the upstream doesn't
 *     distinguish (Google `SUBSCRIPTION_EXPIRED`) or when no subtype
 *     applies. Backends use it to choose UX response without branching
 *     on platform.
 *   - `platformEvent`: the original upstream identifier in the canonical
 *     form Attesto used to emit before unification — `apple.did_renew` /
 *     `google.subscription.2` etc. Preserved for debugging, advanced
 *     routing, and audit logs.
 *
 * Unknown upstream types fall through to `event: "unknown"` rather than
 * being dropped — operators get a triage signal in delivery logs to ship
 * a mapping update; backends safely default-case the unknown.
 */

import type { DecodedJwsPayload } from "@/services/apple/jws-verifier.ts";

export interface UnifiedEvent {
  /** Attesto's platform-agnostic event name, e.g. `subscription.renewed`. */
  event: string;
  /**
   * Sub-classification when the upstream payload carries one (Apple
   * subtypes). Null when the upstream is undifferentiated or when no
   * subtype applies to this event type.
   */
  reason: string | null;
  /**
   * Original upstream identifier, normalized to the legacy
   * `apple.<type>{.<subtype>}` / `google.subscription.<N>` form. Stable
   * for debugging and advanced routing — backends needing wire-level
   * detail consult this.
   */
  platformEvent: string;
}

interface Mapping {
  event: string;
  reason: string | null;
}

// ─── Apple ────────────────────────────────────────────────────────────────────

/**
 * Apple notificationType + optional subtype → unified event.
 *
 * Lookup is by composite key `"<TYPE>:<SUBTYPE>"` (subtype-qualified) with
 * fallback to bare `"<TYPE>"` when the subtype is absent or unrecognized.
 * This means a new Apple subtype on a known type degrades gracefully:
 * unified `event` and `reason` come from the parent type's entry; the
 * full subtype survives in `platformEvent`.
 */
const APPLE_MAP: Record<string, Mapping> = {
  // ── lifecycle ─────────────────────────────────────────────────────────────
  "SUBSCRIBED": { event: "subscription.purchased", reason: "initial" },
  "SUBSCRIBED:INITIAL_BUY": { event: "subscription.purchased", reason: "initial" },
  "SUBSCRIBED:RESUBSCRIBE": { event: "subscription.purchased", reason: "resubscribe" },
  "SUBSCRIBED:UPGRADE": { event: "subscription.upgraded", reason: null },
  "SUBSCRIBED:DOWNGRADE": { event: "subscription.downgraded", reason: null },

  "DID_RENEW": { event: "subscription.renewed", reason: null },
  "DID_RENEW:BILLING_RECOVERY": { event: "subscription.recovered", reason: null },

  "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED": {
    event: "subscription.cancellation_scheduled",
    reason: null,
  },
  "DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_ENABLED": {
    event: "subscription.cancellation_revoked",
    reason: null,
  },

  "EXPIRED": { event: "subscription.expired", reason: null },
  "EXPIRED:VOLUNTARY": { event: "subscription.expired", reason: "voluntary" },
  "EXPIRED:BILLING_RETRY": { event: "subscription.expired", reason: "billing_retry" },
  "EXPIRED:PRODUCT_NOT_FOR_SALE": {
    event: "subscription.expired",
    reason: "product_not_for_sale",
  },

  "REVOKE": { event: "subscription.revoked", reason: null },
  "REFUND": { event: "subscription.refunded", reason: null },

  "DID_FAIL_TO_RENEW": { event: "subscription.in_billing_retry", reason: null },
  "DID_FAIL_TO_RENEW:GRACE_PERIOD": { event: "subscription.in_grace_period", reason: null },
  "GRACE_PERIOD_EXPIRED": { event: "subscription.grace_period_expired", reason: null },

  // ── plan changes ──────────────────────────────────────────────────────────
  "DID_CHANGE_RENEWAL_PREF": { event: "subscription.renewal_pref_changed", reason: null },
  "DID_CHANGE_RENEWAL_PREF:AUTO_RENEW_PREF_CHANGE": {
    event: "subscription.renewal_pref_changed",
    reason: null,
  },

  // ── refund flow extras ────────────────────────────────────────────────────
  "REFUND_DECLINED": { event: "subscription.refund_declined", reason: null },
  "REFUND_REVERSED": { event: "subscription.refund_reversed", reason: null },

  // ── pricing ───────────────────────────────────────────────────────────────
  "PRICE_INCREASE": { event: "subscription.price_change_pending", reason: null },
  "PRICE_INCREASE:PENDING": { event: "subscription.price_change_pending", reason: null },
  "PRICE_INCREASE:ACCEPTED": { event: "subscription.price_change_accepted", reason: null },

  // ── promotional / extension ───────────────────────────────────────────────
  "OFFER_REDEEMED": { event: "subscription.offer_redeemed", reason: null },
  "RENEWAL_EXTENDED": { event: "subscription.renewal_extended", reason: null },
  "RENEWAL_EXTENSION": {
    event: "subscription.renewal_extension_complete",
    reason: null,
  },

  // ── consumables / external ────────────────────────────────────────────────
  "CONSUMPTION_REQUEST": { event: "subscription.consumption_request", reason: null },
  "EXTERNAL_PURCHASE_TOKEN": {
    event: "subscription.external_purchase_token",
    reason: null,
  },
  "ONE_TIME_CHARGE": { event: "product.charged", reason: null },

  // ── test ──────────────────────────────────────────────────────────────────
  "TEST": { event: "test", reason: null },
};

export function normalizeApple(decoded: DecodedJwsPayload): UnifiedEvent {
  const rawType = typeof decoded.notificationType === "string" ? decoded.notificationType : "";
  const rawSubtype = typeof decoded.subtype === "string" ? decoded.subtype : "";

  const platformType = rawType.toLowerCase() || "unknown";
  const platformEvent = rawSubtype
    ? `apple.${platformType}.${rawSubtype.toLowerCase()}`
    : `apple.${platformType}`;

  if (!rawType) {
    return { event: "unknown", reason: null, platformEvent };
  }

  // Subtype-qualified lookup wins; fall back to the bare type so a new
  // Apple subtype on a known type still classifies under the right
  // unified event (with reason: null).
  const subtypeKey = rawSubtype ? `${rawType}:${rawSubtype}` : null;
  const mapping = (subtypeKey && APPLE_MAP[subtypeKey]) || APPLE_MAP[rawType];

  if (!mapping) {
    return { event: "unknown", reason: null, platformEvent };
  }

  return { event: mapping.event, reason: mapping.reason, platformEvent };
}

// ─── Google ───────────────────────────────────────────────────────────────────

/**
 * Google `subscriptionNotification.notificationType` integer → unified.
 * Google doesn't carry subtypes, so `reason` is mostly null. Exception:
 * `SUBSCRIPTION_PURCHASED (4)` corresponds to Apple's `INITIAL_BUY` — we
 * surface the same `reason: "initial"` so backends switching on
 * `subscription.purchased` see consistent reason values across platforms.
 */
const GOOGLE_SUB_MAP: Record<number, Mapping> = {
  1: { event: "subscription.recovered", reason: null },
  2: { event: "subscription.renewed", reason: null },
  3: { event: "subscription.cancellation_scheduled", reason: null },
  4: { event: "subscription.purchased", reason: "initial" },
  5: { event: "subscription.on_hold", reason: null },
  6: { event: "subscription.in_grace_period", reason: null },
  7: { event: "subscription.cancellation_revoked", reason: null },
  8: { event: "subscription.price_change_accepted", reason: null },
  9: { event: "subscription.deferred", reason: null },
  10: { event: "subscription.paused", reason: null },
  11: { event: "subscription.pause_schedule_changed", reason: null },
  12: { event: "subscription.revoked", reason: null },
  13: { event: "subscription.expired", reason: null },
  17: { event: "subscription.pending_purchase_canceled", reason: null },
  19: { event: "subscription.price_change_updated", reason: null },
  20: { event: "subscription.price_change_rejected", reason: null },
};

const GOOGLE_PRODUCT_MAP: Record<number, Mapping> = {
  1: { event: "product.purchased", reason: null },
  2: { event: "product.canceled", reason: null },
};

export function normalizeGoogle(decoded: Record<string, unknown>): UnifiedEvent {
  const sub = decoded.subscriptionNotification as Record<string, unknown> | undefined;
  if (sub && typeof sub.notificationType === "number") {
    const n = sub.notificationType;
    const platformEvent = `google.subscription.${n}`;
    const mapping = GOOGLE_SUB_MAP[n];
    if (mapping) {
      return { event: mapping.event, reason: mapping.reason, platformEvent };
    }
    return { event: "unknown", reason: null, platformEvent };
  }

  const otp = decoded.oneTimeProductNotification as Record<string, unknown> | undefined;
  if (otp && typeof otp.notificationType === "number") {
    const n = otp.notificationType;
    const platformEvent = `google.product.${n}`;
    const mapping = GOOGLE_PRODUCT_MAP[n];
    if (mapping) {
      return { event: mapping.event, reason: mapping.reason, platformEvent };
    }
    return { event: "unknown", reason: null, platformEvent };
  }

  if (decoded.voidedPurchaseNotification) {
    return {
      event: "subscription.refunded",
      reason: null,
      platformEvent: "google.voided",
    };
  }

  if (decoded.testNotification) {
    return { event: "test", reason: null, platformEvent: "google.test" };
  }

  return { event: "unknown", reason: null, platformEvent: "google.unknown" };
}

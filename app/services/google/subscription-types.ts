/**
 * Types for `POST /v1/google/subscription-status` — Google Play's
 * `purchases.subscriptionsv2.get`.
 *
 * The verify endpoint already calls subscriptionsv2, but its envelope
 * (`NormalizedGoogleSubscriptionPurchase`) was shaped to mirror Apple's
 * verify response and drops the fields a status caller needs:
 * `subscriptionState` (which is where grace, on-hold, paused and canceled
 * actually live), the cancellation / pause context, `testPurchase`, and the
 * per-line-item detail.
 *
 * Per PLAN.md §14 these are Google's own field names and enum strings —
 * no cross-platform entitlement model. Clients normalize.
 */

/** One `lineItems[]` entry. A subscription may carry several (add-ons). */
export interface NormalizedGoogleLineItem {
  productId: string | null;
  expiryTime: string | null; // ISO-8601, as Google returns it
  autoRenewEnabled: boolean | null;
  basePlanId: string | null;
  offerId: string | null;
  offerTags: string[] | null;
  priceCurrencyCode: string | null;
  priceAmountMicros: string | null;
  /** Set while a deferred plan change is pending. */
  deferredItemReplacementProductId: string | null;
}

export interface NormalizedGoogleSubscriptionStatus {
  kind: "androidpublisher#subscriptionPurchaseV2";
  packageName: string;
  purchaseToken: string;
  /**
   * Google's own enum string, e.g. `SUBSCRIPTION_STATE_ACTIVE`,
   * `SUBSCRIPTION_STATE_IN_GRACE_PERIOD`, `SUBSCRIPTION_STATE_ON_HOLD`,
   * `SUBSCRIPTION_STATE_CANCELED`, `SUBSCRIPTION_STATE_EXPIRED`,
   * `SUBSCRIPTION_STATE_PAUSED`, `SUBSCRIPTION_STATE_PENDING`.
   *
   * Note that a subscription Google revoked after a refund reports as
   * `SUBSCRIPTION_STATE_EXPIRED` here — subscriptionsv2 has no "revoked"
   * state. Attesto does not call the Voided Purchases API (it is a
   * separate, allowlisted endpoint and a different scope); clients that
   * must distinguish a refund from a lapse should consume the
   * `subscription.refunded` webhook or query that API themselves.
   */
  subscriptionState: string | null;
  startTime: string | null;
  /** The FIRST line item's expiry. Read `lineItems` for multi-item fidelity. */
  expiryTime: string | null;
  /** The FIRST line item's `autoRenewingPlan.autoRenewEnabled`. */
  autoRenewEnabled: boolean | null;
  latestOrderId: string | null;
  /** Set when this token superseded an earlier one (upgrade / downgrade). */
  linkedPurchaseToken: string | null;
  /** v2 reports a STRING enum here (e.g. `ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`). */
  acknowledgementState: string | null;
  /** True for a licence-tester purchase — Google signals it by presence. */
  testPurchase: boolean;
  regionCode: string | null;
  /** Verbatim `pausedStateContext` (carries `autoResumeTime`). */
  pausedStateContext: Record<string, unknown> | null;
  /** Verbatim `canceledStateContext` (user / system / developer / replacement). */
  canceledStateContext: Record<string, unknown> | null;
  /** The purchase binding set at buy time via Play Billing's `obfuscatedAccountId`. */
  obfuscatedExternalAccountId: string | null;
  obfuscatedExternalProfileId: string | null;
  lineItems: NormalizedGoogleLineItem[];
  rawResponse: Record<string, unknown>;
}

export interface GoogleSubscriptionStatusResultValid {
  valid: true;
  subscription: NormalizedGoogleSubscriptionStatus;
  /**
   * `obfuscatedExternalAccountId`, surfaced at the top level to match the
   * verify endpoints. Null when the original purchase carried no binding.
   */
  appUserId: string | null;
}

export interface GoogleSubscriptionStatusResultInvalid {
  valid: false;
  error: "SUBSCRIPTION_NOT_FOUND" | "PACKAGE_NAME_MISMATCH";
  message: string;
}

export type GoogleSubscriptionStatusResult =
  | GoogleSubscriptionStatusResultValid
  | GoogleSubscriptionStatusResultInvalid;

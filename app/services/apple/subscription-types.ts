/**
 * Types for `POST /v1/apple/subscription-status` — Apple's **Get All
 * Subscription Statuses** endpoint (`/inApps/v1/subscriptions/{id}`).
 *
 * Distinct from `verify.ts` / `types.ts`, which model **Get Transaction
 * Info**. The difference matters: for an *original* transaction id, Get
 * Transaction Info returns the FIRST period of the subscription, so it
 * cannot answer "does this subscription still pay?" at an arbitrary later
 * time. Get All Subscription Statuses returns the LAST transaction per
 * subscription group, plus the renewal info that carries grace-period and
 * billing-retry state.
 *
 * Per PLAN.md §14 we return Apple's own vocabulary — the numeric `status`
 * (1 active / 2 expired / 3 billing retry / 4 grace / 5 revoked) and the
 * decoded renewal info — rather than a cross-platform entitlement model.
 * Clients normalize.
 */

import type {
  AppleEnvironmentResolved,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";

/**
 * Shape Apple returns after decoding `signedRenewalInfo`. Mirrors the SDK's
 * `JWSRenewalInfoDecodedPayload`; every field is optional because Apple
 * populates them conditionally (e.g. `gracePeriodExpiresDate` only while a
 * grace period is running).
 */
export interface DecodedAppleRenewalInfoPayload {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  productId?: string;
  autoRenewStatus?: number;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number; // ms epoch
  priceIncreaseStatus?: number;
  offerType?: number;
  offerIdentifier?: string;
  recentSubscriptionStartDate?: number; // ms epoch
  renewalDate?: number; // ms epoch
  signedDate?: number; // ms epoch
  environment?: string;
  currency?: string;
  renewalPrice?: number;
  appAccountToken?: string;
  [extra: string]: unknown;
}

/**
 * One `data[].lastTransactions[]` item, flattened with its group id and with
 * both JWSs verified + decoded.
 */
export interface AppleSubscriptionStatusEntry {
  subscriptionGroupIdentifier: string | null;
  /** Apple's `Status` enum: 1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked. */
  status: number | null;
  originalTransactionId: string | null;
  signedTransactionInfo: string;
  transaction: DecodedAppleTransactionPayload;
  /** Null when Apple omits renewal info (non-renewing / revoked transactions). */
  signedRenewalInfo: string | null;
  renewalInfo: DecodedAppleRenewalInfoPayload | null;
}

/** Result shape returned by `AppleClient.getSubscriptionStatuses`. */
export interface AppleSubscriptionStatusFetchResult {
  /** Response-level `bundleId` — authoritative for the tenant check. */
  bundleId: string | null;
  /** Apple's own environment label ("Production" / "Sandbox"), verbatim. */
  environment: string | null;
  appAppleId: number | null;
  entries: AppleSubscriptionStatusEntry[];
}

/** Renewal info with timestamps rendered as ISO-8601, per the repo envelope style. */
export interface NormalizedAppleRenewalInfo {
  autoRenewStatus: number | null;
  autoRenewProductId: string | null;
  expirationIntent: number | null;
  isInBillingRetryPeriod: boolean | null;
  gracePeriodExpiresDate: string | null;
  renewalDate: string | null;
  recentSubscriptionStartDate: string | null;
  priceIncreaseStatus: number | null;
  offerType: number | null;
  offerIdentifier: string | null;
  currency: string | null;
  renewalPrice: number | null;
  signedRenewalInfo: string;
  rawDecodedPayload: Record<string, unknown>;
}

/** One subscription's current status, in Apple's vocabulary. */
export interface NormalizedAppleSubscriptionStatus {
  subscriptionGroupIdentifier: string | null;
  status: number | null;
  originalTransactionId: string | null;
  transactionId: string | null;
  bundleId: string | null;
  productId: string | null;
  purchaseDate: string | null;
  expiresDate: string | null;
  revocationDate: string | null;
  revocationReason: number | null;
  offerType: number | null;
  offerIdentifier: string | null;
  appAccountToken: string | null;
  inAppOwnershipType: string | null;
  type: string | null;
  renewalInfo: NormalizedAppleRenewalInfo | null;
  signedTransactionInfo: string;
  rawDecodedPayload: Record<string, unknown>;
}

export interface AppleSubscriptionStatusResultValid {
  valid: true;
  environment: AppleEnvironmentResolved;
  /**
   * Every subscription group Apple returned, flattened. Apple answers a
   * query for one `originalTransactionId` with the status of its whole
   * subscription group (and, for family sharing, one entry per owner), so
   * we hand all of them over rather than picking one and losing the rest.
   */
  subscriptions: NormalizedAppleSubscriptionStatus[];
  /**
   * `appAccountToken` of the entry whose `originalTransactionId` matches the
   * request — the purchase binding. Null when Apple returned no matching
   * entry or the original purchase carried no token.
   */
  appUserId: string | null;
}

export interface AppleSubscriptionStatusResultInvalid {
  valid: false;
  // CREDENTIALS_MISSING is intentionally absent — it throws AppError (a
  // server-configuration fault), matching verify.ts.
  error: "SUBSCRIPTION_NOT_FOUND" | "BUNDLE_ID_MISMATCH";
  message: string;
}

export type AppleSubscriptionStatusResult =
  | AppleSubscriptionStatusResultValid
  | AppleSubscriptionStatusResultInvalid;

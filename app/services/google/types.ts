/**
 * Google Play service-account JSON and normalized purchase types.
 *
 * PLAN.md §4.2 defines the response envelope. We surface the fields most
 * clients care about directly and keep `rawResponse` for anyone who needs
 * Google's full payload (state machines vary between SubscriptionPurchaseV2
 * and ProductPurchase, so the raw form is the most reliable source of truth).
 */

/** Google service-account JSON schema (the fields we use). */
export interface GoogleServiceAccount {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string; // PKCS#8 PEM
  client_email: string;
  client_id?: string;
  token_uri: string; // usually https://oauth2.googleapis.com/token
  [extra: string]: unknown;
}

export type GooglePurchaseType = "subscription" | "product";

export interface GoogleCredentialMaterial {
  packageName: string;
  serviceAccount: GoogleServiceAccount;
}

/** Google subscription purchase (subset of SubscriptionPurchaseV2). */
export interface NormalizedGoogleSubscriptionPurchase {
  kind: "androidpublisher#subscriptionPurchaseV2";
  packageName: string;
  productId: string;
  purchaseToken: string;
  startTime: string | null; // ISO-8601
  expiryTime: string | null;
  autoRenewing: boolean | null;
  priceCurrencyCode: string | null;
  priceAmountMicros: string | null;
  countryCode: string | null;
  paymentState: number | null;
  acknowledgementState: number | null;
  orderId: string | null;
  /**
   * App-supplied UUID attached at purchase via Play Billing's
   * `obfuscatedAccountId`. SubscriptionPurchaseV2 nests it under
   * `externalAccountIdentifiers.obfuscatedExternalAccountId`. NULL when
   * the original purchase did not carry one.
   */
  obfuscatedExternalAccountId: string | null;
  rawResponse: Record<string, unknown>;
}

/** Google one-shot product purchase. */
export interface NormalizedGoogleProductPurchase {
  kind: "androidpublisher#productPurchase";
  packageName: string;
  productId: string;
  purchaseToken: string;
  purchaseTimeMillis: string | null;
  purchaseState: number | null;
  consumptionState: number | null;
  acknowledgementState: number | null;
  orderId: string | null;
  /**
   * App-supplied UUID attached at purchase via Play Billing's
   * `obfuscatedAccountId`. OneTimeProductPurchase carries it directly
   * (not nested). NULL when the original purchase did not carry one.
   */
  obfuscatedExternalAccountId: string | null;
  rawResponse: Record<string, unknown>;
}

export type NormalizedGooglePurchase =
  | NormalizedGoogleSubscriptionPurchase
  | NormalizedGoogleProductPurchase;

export interface VerifyGoogleResultValid {
  valid: true;
  purchase: NormalizedGooglePurchase;
  /**
   * App-supplied UUID attached at purchase time via Play Billing's
   * `obfuscatedAccountId` (sourced from
   * `externalAccountIdentifiers.obfuscatedExternalAccountId` on
   * subscriptions, or the top-level field on one-time products).
   * Surfaced here so integrators can join on user identity without
   * digging into the platform-specific `purchase` shape. NULL when the
   * original purchase did not carry one.
   */
  appUserId: string | null;
}

export interface VerifyGoogleResultInvalid {
  valid: false;
  error: "PURCHASE_NOT_FOUND" | "PACKAGE_NAME_MISMATCH";
  message: string;
}

export type VerifyGoogleResult = VerifyGoogleResultValid | VerifyGoogleResultInvalid;

/**
 * Normalized Apple transaction payload. Mirrors PLAN.md §4.1 — we surface the
 * fields most clients care about directly and keep `rawDecodedPayload` for
 * power users who need Apple's complete response.
 */

export type AppleEnvironmentResolved = "production" | "sandbox";

/** Tenant credential material decrypted into memory for a single verify call. */
export interface AppleCredentialMaterial {
  bundleId: string;
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
  /** Apple's numeric App ID, from App Store Connect → My Apps → app →
   * App Information → Apple ID. Required by the SDK's SignedDataVerifier
   * for environment=production; null for sandbox-only / pre-launch tenants.
   * Always present from the loader (never undefined) — the DB column is
   * nullable, so callers should handle `null`. */
  appAppleId: number | null;
}

/** Result shape returned by every AppleClient implementation. */
export interface AppleTransactionFetchResult {
  signedTransactionInfo: string;
  decoded: DecodedAppleTransactionPayload;
}

export interface NormalizedAppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: string; // ISO-8601
  originalPurchaseDate: string; // ISO-8601
  expiresDate: string | null; // ISO-8601 or null for consumables
  type: string; // "Auto-Renewable Subscription" | "Consumable" | ...
  inAppOwnershipType: string; // "PURCHASED" | "FAMILY_SHARED"
  quantity: number;
  webOrderLineItemId: string | null;
  revocationDate: string | null;
  revocationReason: number | null;
  offerType: number | null;
  offerIdentifier: string | null;
  appAccountToken: string | null;
  storefront: string | null;
  storefrontId: string | null;
  transactionReason: string | null;
  currency: string | null;
  price: number | null; // in milli-units of the local currency (e.g. $9.99 → 9990)
  signedTransactionInfo: string; // the original JWS for power users
  rawDecodedPayload: Record<string, unknown>; // full Apple payload
}

/**
 * Shape Apple returns after decoding `signedTransactionInfo` — we keep this as
 * an unknown record and map to our normalized form in `verify.ts`.
 */
export interface DecodedAppleTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number; // ms epoch
  originalPurchaseDate: number;
  expiresDate?: number;
  type: string;
  inAppOwnershipType?: string;
  quantity?: number;
  webOrderLineItemId?: string;
  revocationDate?: number;
  revocationReason?: number;
  offerType?: number;
  offerIdentifier?: string;
  appAccountToken?: string;
  storefront?: string;
  storefrontId?: string;
  transactionReason?: string;
  currency?: string;
  price?: number;
  [extra: string]: unknown;
}

export interface VerifyAppleResultValid {
  valid: true;
  environment: AppleEnvironmentResolved;
  transaction: NormalizedAppleTransaction;
  /**
   * App-supplied UUID attached at purchase time via StoreKit's
   * `applicationUsername` (sourced from the JWS's `appAccountToken`).
   * Surfaced at the top level so integrators can join on user identity
   * without having to reach into the platform-specific `transaction`
   * fields. NULL when the original purchase did not carry one.
   */
  appUserId: string | null;
}

export interface VerifyAppleResultInvalid {
  valid: false;
  // CREDENTIALS_MISSING intentionally omitted — that case throws AppError (400);
  // it's a server-configuration problem, not a domain result about a transaction.
  error: "TRANSACTION_NOT_FOUND" | "BUNDLE_ID_MISMATCH";
  message: string;
}

export type VerifyAppleResult = VerifyAppleResultValid | VerifyAppleResultInvalid;

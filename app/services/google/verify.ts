/**
 * Orchestrates Google Play purchase verification:
 * 1. Load tenant's service account (decrypted, cached).
 * 2. Call the right Play API endpoint for subscription vs product.
 * 3. Normalize the response per PLAN.md §4.2.
 */

import {
  createGoogleHttpClient,
  type GoogleClient,
  GooglePurchaseNotFoundError,
  mapGoogleApiError,
} from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type {
  GoogleCredentialMaterial,
  GooglePurchaseType,
  NormalizedGoogleProductPurchase,
  NormalizedGooglePurchase,
  NormalizedGoogleSubscriptionPurchase,
  VerifyGoogleResult,
} from "@/services/google/types.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  moneyToMicros,
} from "@/services/google/field-utils.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

export interface VerifyGoogleInput {
  tenantId: string;
  packageName: string;
  productId: string;
  purchaseToken: string;
  type: GooglePurchaseType;
}

export interface VerifyGoogleDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  /** Tests inject a fake GoogleClient to avoid real HTTPS. */
  clientFactory?: (
    material: GoogleCredentialMaterial,
    tenantCacheKey: string,
    tokenProvider: AccessTokenProvider,
  ) => GoogleClient;
}

export async function verifyGooglePurchase(
  deps: VerifyGoogleDeps,
  input: VerifyGoogleInput,
): Promise<VerifyGoogleResult> {
  const material = await deps.credentialsLoader.load(input.tenantId);
  if (!material) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "Google credentials are not configured for this tenant",
    );
  }
  if (material.packageName !== input.packageName) {
    return {
      valid: false,
      error: "PACKAGE_NAME_MISMATCH",
      message:
        `Tenant is configured for "${material.packageName}" but request was for "${input.packageName}"`,
    };
  }

  const client: GoogleClient = deps.clientFactory
    ? deps.clientFactory(material, input.tenantId, deps.tokenProvider)
    : createGoogleHttpClient({
      credentials: material,
      tokenProvider: deps.tokenProvider,
      tenantCacheKey: input.tenantId,
    });

  try {
    const result = await client.getPurchase({
      type: input.type,
      productId: input.productId,
      purchaseToken: input.purchaseToken,
    });
    const purchase = input.type === "subscription"
      ? normalizeSubscription(input, result.raw)
      : normalizeProduct(input, result.raw);
    return {
      valid: true,
      purchase,
      appUserId: purchase.obfuscatedExternalAccountId,
    };
  } catch (err) {
    if (err instanceof GooglePurchaseNotFoundError) {
      return {
        valid: false,
        error: "PURCHASE_NOT_FOUND",
        message: err.reason === "gone"
          ? "Purchase token is gone (consumed / acknowledged and expired)"
          : "Purchase token not found",
      };
    }
    const mapped = mapGoogleApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

function normalizeSubscription(
  input: VerifyGoogleInput,
  raw: Record<string, unknown>,
): NormalizedGoogleSubscriptionPurchase {
  // SubscriptionPurchaseV2 nests pricing inside `lineItems[]` (Google supports
  // add-on / bundled line items per subscription). We surface the FIRST line
  // item for quick consumption; clients needing full multi-line-item fidelity
  // MUST consume `rawResponse.lineItems` directly. This is intentional — no
  // clean way to collapse N line items into a single envelope without losing
  // information.
  const firstLine = asArray(raw.lineItems)[0] ?? {};
  const autoRenewingPlan = asRecord(firstLine.autoRenewingPlan);
  const autoRenewing = asBoolean(autoRenewingPlan?.autoRenewEnabled);
  // The recurring price is a single Money under `autoRenewingPlan`, NOT a
  // `prices[]` array — that field does not exist on a v2 line item, so
  // reading it left both price fields null against every real response.
  const recurringPrice = asRecord(autoRenewingPlan?.recurringPrice);
  // SubscriptionPurchaseV2: obfuscated identifiers nested under
  // `externalAccountIdentifiers`. OneTimeProductPurchase has them at the
  // top level — different from subscriptions. See normalizeProduct().
  const externalIds = asRecord(raw.externalAccountIdentifiers);

  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    packageName: input.packageName,
    productId: input.productId,
    purchaseToken: input.purchaseToken,
    startTime: asString(raw.startTime),
    expiryTime: asString(firstLine.expiryTime) ?? asString(raw.expiryTime),
    autoRenewing,
    priceCurrencyCode: asString(recurringPrice?.currencyCode),
    priceAmountMicros: moneyToMicros(recurringPrice),
    countryCode: asString(raw.regionCode),
    paymentState: null, // v2 doesn't expose paymentState the same way as v1
    // v2 reports a STRING enum here (e.g. ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED).
    // The v1 ProductPurchase below really does use a number — only the
    // subscription branch was modelled on the wrong version.
    acknowledgementState: asString(raw.acknowledgementState),
    orderId: asString(raw.latestOrderId),
    obfuscatedExternalAccountId: asString(externalIds?.obfuscatedExternalAccountId),
    rawResponse: raw,
  };
}

function normalizeProduct(
  input: VerifyGoogleInput,
  raw: Record<string, unknown>,
): NormalizedGoogleProductPurchase {
  return {
    kind: "androidpublisher#productPurchase",
    packageName: input.packageName,
    productId: input.productId,
    purchaseToken: input.purchaseToken,
    purchaseTimeMillis: asString(raw.purchaseTimeMillis),
    purchaseState: asNumber(raw.purchaseState),
    consumptionState: asNumber(raw.consumptionState),
    // v2 reports a STRING enum here (e.g. ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED).
    // The v1 ProductPurchase below really does use a number — only the
    // subscription branch was modelled on the wrong version.
    acknowledgementState: asNumber(raw.acknowledgementState),
    orderId: asString(raw.orderId),
    // OneTimeProductPurchase exposes obfuscated identifiers at the top
    // level (unlike SubscriptionPurchaseV2 — see normalizeSubscription()).
    obfuscatedExternalAccountId: asString(raw.obfuscatedExternalAccountId),
    rawResponse: raw,
  };
}

export type { NormalizedGooglePurchase };

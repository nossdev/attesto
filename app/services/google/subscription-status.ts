/**
 * Orchestrates "what is this subscription's status right now?" for Google:
 * 1. Load the tenant's service account (decrypted, cached).
 * 2. Check the request's packageName against the tenant's.
 * 3. Call `purchases.subscriptionsv2.get` by purchase token alone.
 * 4. Surface Google's own state vocabulary, keeping `rawResponse` intact.
 *
 * No device and no productId are needed — a caller holding only a stored
 * purchase reference can ask at any later time.
 */

import {
  createGoogleHttpClient,
  GooglePurchaseNotFoundError,
  type GoogleSubscriptionClient,
  mapGoogleApiError,
} from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleCredentialMaterial } from "@/services/google/types.ts";
import type {
  GoogleSubscriptionStatusResult,
  NormalizedGoogleLineItem,
  NormalizedGoogleSubscriptionStatus,
} from "@/services/google/subscription-types.ts";
import {
  asArray,
  asBoolean,
  asRecord,
  asString,
  asStringArray,
  moneyToMicros,
} from "@/services/google/field-utils.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

export interface GoogleSubscriptionStatusInput {
  tenantId: string;
  packageName: string;
  purchaseToken: string;
}

export interface GoogleSubscriptionStatusDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  /** Tests inject a fake client to avoid real HTTPS. */
  clientFactory?: (
    material: GoogleCredentialMaterial,
    tenantCacheKey: string,
    tokenProvider: AccessTokenProvider,
  ) => GoogleSubscriptionClient;
}

export async function getGoogleSubscriptionStatus(
  deps: GoogleSubscriptionStatusDeps,
  input: GoogleSubscriptionStatusInput,
): Promise<GoogleSubscriptionStatusResult> {
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

  const client: GoogleSubscriptionClient = deps.clientFactory
    ? deps.clientFactory(material, input.tenantId, deps.tokenProvider)
    : createGoogleHttpClient({
      credentials: material,
      tokenProvider: deps.tokenProvider,
      tenantCacheKey: input.tenantId,
    });

  try {
    const { raw } = await client.getSubscription({ purchaseToken: input.purchaseToken });
    const subscription = normalizeSubscriptionStatus(input, raw);
    return {
      valid: true,
      subscription,
      appUserId: subscription.obfuscatedExternalAccountId,
    };
  } catch (err) {
    if (err instanceof GooglePurchaseNotFoundError) {
      return {
        valid: false,
        error: "SUBSCRIPTION_NOT_FOUND",
        message: err.reason === "gone"
          ? "Purchase token is gone (acknowledged and expired)"
          : "Purchase token not found",
      };
    }
    const mapped = mapGoogleApiError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

function normalizeLineItem(raw: Record<string, unknown>): NormalizedGoogleLineItem {
  const autoRenewingPlan = asRecord(raw.autoRenewingPlan);
  const offerDetails = asRecord(raw.offerDetails);
  const recurringPrice = asRecord(autoRenewingPlan?.recurringPrice);
  const deferred = asRecord(raw.deferredItemReplacement);

  return {
    productId: asString(raw.productId),
    expiryTime: asString(raw.expiryTime),
    autoRenewEnabled: asBoolean(autoRenewingPlan?.autoRenewEnabled),
    basePlanId: asString(offerDetails?.basePlanId),
    offerId: asString(offerDetails?.offerId),
    offerTags: asStringArray(offerDetails?.offerTags),
    priceCurrencyCode: asString(recurringPrice?.currencyCode),
    priceAmountMicros: moneyToMicros(recurringPrice),
    deferredItemReplacementProductId: asString(deferred?.productId),
  };
}

function normalizeSubscriptionStatus(
  input: GoogleSubscriptionStatusInput,
  raw: Record<string, unknown>,
): NormalizedGoogleSubscriptionStatus {
  const lineItems = asArray(raw.lineItems).map(normalizeLineItem);
  const first = lineItems[0];
  const externalIds = asRecord(raw.externalAccountIdentifiers);

  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    packageName: input.packageName,
    purchaseToken: input.purchaseToken,
    subscriptionState: asString(raw.subscriptionState),
    startTime: asString(raw.startTime),
    expiryTime: first?.expiryTime ?? null,
    autoRenewEnabled: first?.autoRenewEnabled ?? null,
    latestOrderId: asString(raw.latestOrderId),
    linkedPurchaseToken: asString(raw.linkedPurchaseToken),
    acknowledgementState: asString(raw.acknowledgementState),
    // Google signals a licence-tester purchase by the PRESENCE of an
    // (otherwise empty) `testPurchase` object, so `{}` must read as true.
    testPurchase: asRecord(raw.testPurchase) !== null,
    regionCode: asString(raw.regionCode),
    pausedStateContext: asRecord(raw.pausedStateContext),
    canceledStateContext: asRecord(raw.canceledStateContext),
    obfuscatedExternalAccountId: asString(externalIds?.obfuscatedExternalAccountId),
    obfuscatedExternalProfileId: asString(externalIds?.obfuscatedExternalProfileId),
    lineItems,
    rawResponse: raw,
  };
}

/**
 * Orchestrates Google Play purchase verification:
 * 1. Load tenant's service account (decrypted, cached).
 * 2. Call the right Play API endpoint for subscription vs product.
 * 3. Normalize the response per PLAN.md §4.2.
 */

import {
  createGoogleHttpClient,
  GoogleApiError,
  type GoogleClient,
  GooglePurchaseNotFoundError,
  GoogleRateLimitError,
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
    return {
      valid: true,
      purchase: input.type === "subscription"
        ? normalizeSubscription(input, result.raw)
        : normalizeProduct(input, result.raw),
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
    if (err instanceof GoogleRateLimitError) {
      // Distinct from a generic 5xx — clients should back off and retry.
      throw new AppError(ErrorCodes.RATE_LIMITED, "Google Play quota exceeded", {
        details: err.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: err.retryAfterSeconds }
          : undefined,
      });
    }
    if (err instanceof GoogleApiError) {
      // As with Apple: discard the raw upstream message — can embed
      // driver/network/auth details. Keep structured status + code only.
      throw new AppError(ErrorCodes.GOOGLE_API_ERROR, "Google API request failed", {
        details: { status: err.status, googleErrorCode: err.googleErrorCode },
      });
    }
    throw err;
  }
}

// `asNumber` / `asString` drop mistyped fields (rather than coerce) because
// coerced bad data is worse than missing data — clients that care about
// numeric state should consume `rawResponse` directly when envelope fields
// are null.
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Google's Money type exposes {units: string, nanos: number} where
 * 1 unit = 1 whole currency unit and 10⁹ nanos = 1 unit. Micros = 10⁶
 * sub-units, so `micros = units * 1_000_000 + nanos / 1_000`. Returned as
 * string because `units` may exceed Number.MAX_SAFE_INTEGER for some
 * currencies and we prefer exactness over a potential truncation.
 */
function moneyToMicros(money: Record<string, unknown> | undefined): string | null {
  if (!money) return null;
  const unitsStr = money.units;
  const nanosN = money.nanos;
  if (typeof unitsStr !== "string" && typeof unitsStr !== "number") return null;
  try {
    const units = BigInt(String(unitsStr));
    const nanos = typeof nanosN === "number" ? BigInt(nanosN) : 0n;
    return (units * 1_000_000n + nanos / 1000n).toString();
  } catch {
    return null;
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
  const lineItems = raw.lineItems as Array<Record<string, unknown>> | undefined;
  const firstLine = lineItems?.[0] ?? {};
  const autoRenewing = asBoolean(
    (firstLine.autoRenewingPlan as Record<string, unknown> | undefined)?.autoRenewEnabled,
  );
  const prices = firstLine.prices as Array<Record<string, unknown>> | undefined;
  const firstPrice = prices?.[0];

  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    packageName: input.packageName,
    productId: input.productId,
    purchaseToken: input.purchaseToken,
    startTime: asString(raw.startTime),
    expiryTime: asString(firstLine.expiryTime) ?? asString(raw.expiryTime),
    autoRenewing,
    priceCurrencyCode: asString(firstPrice?.currencyCode),
    priceAmountMicros: moneyToMicros(firstPrice),
    countryCode: asString(raw.regionCode),
    paymentState: null, // v2 doesn't expose paymentState the same way as v1
    acknowledgementState: asNumber(raw.acknowledgementState),
    orderId: asString(raw.latestOrderId),
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
    acknowledgementState: asNumber(raw.acknowledgementState),
    orderId: asString(raw.orderId),
    rawResponse: raw,
  };
}

export type { NormalizedGooglePurchase };

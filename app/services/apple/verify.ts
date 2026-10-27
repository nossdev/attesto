/**
 * Orchestrates Apple transaction verification:
 * 1. Load tenant's Apple credentials (decrypted, cached).
 * 2. Call Apple's transaction endpoint in the hinted or tenant-configured env.
 * 3. On any "not found" for `auto`, fall back to the other environment —
 *    Apple's errorCode semantics between 4040005 and 4040010 are inconsistent,
 *    and it's cheap to try both before declaring the transaction missing.
 * 4. Normalize the decoded payload to the shape documented in PLAN.md §4.1.
 */
import type { AppleClient } from "@/services/apple/client.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type {
  AppleCredentialMaterial,
  AppleEnvironmentResolved,
  AppleTransactionFetchResult,
  DecodedAppleTransactionPayload,
  NormalizedAppleTransaction,
  VerifyAppleResult,
} from "@/services/apple/types.ts";
import {
  APP_APPLE_ID_REMEDIATION,
  requiresProductionAppAppleId,
} from "@/services/apple/preflight.ts";
import { attemptAcrossEnvironments, resolveEnvironments } from "@/services/apple/environments.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { toIsoOrNull } from "@/lib/iso-time.ts";

export interface VerifyAppleTransactionInput {
  tenantId: string;
  transactionId: string;
  environmentHint?: AppleEnvironmentResolved;
}

export interface VerifyAppleDeps {
  credentialsLoader: AppleCredentialsLoader;
  /**
   * Factory that constructs an AppleClient given decrypted credential
   * material. Required: production uses a closure over `createAppleHttpClient`
   * with a verifier cache (see `app/main.ts`); tests inject a fake.
   *
   * (Was previously optional with a bare `createAppleHttpClient(...)`
   * fallback — but that fallback would throw at runtime because the bare
   * ctor requires a `verifier`/`verifierCache`. Making it required prevents
   * the unreachable-but-broken default from drifting into a real call site.)
   */
  clientFactory: (material: AppleCredentialMaterial) => AppleClient;
}

export async function verifyAppleTransaction(
  deps: VerifyAppleDeps,
  input: VerifyAppleTransactionInput,
): Promise<VerifyAppleResult> {
  const loaded = await deps.credentialsLoader.load(input.tenantId);
  if (!loaded) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "Apple credentials are not configured for this tenant",
    );
  }

  const client: AppleClient = deps.clientFactory(loaded.material);

  const environments = resolveEnvironments(input.environmentHint, loaded.environment);

  // Pre-flight: if the only environment to try is production AND we don't
  // have appAppleId, surface a clear CREDENTIALS_MISSING with the exact
  // remediation step. (Auto-mode falls through to sandbox via client.ts's
  // 401 throw + the loop's 401-fallback below; this guard catches the
  // explicit-production-only case before we even attempt Apple. The
  // predicate is shared with apple-receiver.ts via preflight.ts.)
  if (requiresProductionAppAppleId(environments, loaded.material.appAppleId)) {
    throw new AppError(ErrorCodes.CREDENTIALS_MISSING, APP_APPLE_ID_REMEDIATION);
  }

  const attempt = await attemptAcrossEnvironments(
    environments,
    (environment) => client.getTransaction({ environment, transactionId: input.transactionId }),
  );

  if (!attempt) {
    return {
      valid: false,
      error: "TRANSACTION_NOT_FOUND",
      message: environments.length > 1
        ? "Transaction not found in any environment (production or sandbox)"
        : "Transaction not found",
    };
  }

  if (attempt.value.decoded.bundleId !== loaded.material.bundleId) {
    return {
      valid: false,
      error: "BUNDLE_ID_MISMATCH",
      message:
        `Transaction belongs to bundleId "${attempt.value.decoded.bundleId}" but tenant is configured for "${loaded.material.bundleId}"`,
    };
  }

  const transaction = normalizeTransaction(attempt.value);
  return {
    valid: true,
    environment: attempt.environment,
    transaction,
    appUserId: transaction.appAccountToken,
  };
}

function normalizeTransaction(
  result: AppleTransactionFetchResult,
): NormalizedAppleTransaction {
  const decoded: DecodedAppleTransactionPayload = result.decoded;

  return {
    transactionId: decoded.transactionId,
    originalTransactionId: decoded.originalTransactionId,
    bundleId: decoded.bundleId,
    productId: decoded.productId,
    purchaseDate: new Date(decoded.purchaseDate).toISOString(),
    originalPurchaseDate: new Date(decoded.originalPurchaseDate).toISOString(),
    expiresDate: toIsoOrNull(decoded.expiresDate),
    type: decoded.type,
    inAppOwnershipType: decoded.inAppOwnershipType ?? "PURCHASED",
    quantity: decoded.quantity ?? 1,
    webOrderLineItemId: decoded.webOrderLineItemId ?? null,
    revocationDate: toIsoOrNull(decoded.revocationDate),
    revocationReason: decoded.revocationReason ?? null,
    offerType: decoded.offerType ?? null,
    offerIdentifier: decoded.offerIdentifier ?? null,
    appAccountToken: decoded.appAccountToken ?? null,
    storefront: decoded.storefront ?? null,
    storefrontId: decoded.storefrontId ?? null,
    transactionReason: decoded.transactionReason ?? null,
    currency: decoded.currency ?? null,
    price: decoded.price ?? null,
    signedTransactionInfo: result.signedTransactionInfo,
    rawDecodedPayload: { ...decoded } as Record<string, unknown>,
  };
}

/**
 * Orchestrates Apple transaction verification:
 * 1. Load tenant's Apple credentials (decrypted, cached).
 * 2. Call Apple's transaction endpoint in the hinted or tenant-configured env.
 * 3. On any "not found" for `auto`, fall back to the other environment —
 *    Apple's errorCode semantics between 4040005 and 4040010 are inconsistent,
 *    and it's cheap to try both before declaring the transaction missing.
 * 4. Normalize the decoded payload to the shape documented in PLAN.md §4.1.
 */
import {
  AppleApiError,
  type AppleClient,
  AppleTransactionNotFoundError,
} from "@/services/apple/client.ts";
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
import { AppError, ErrorCodes } from "@/lib/errors.ts";

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

  for (let i = 0; i < environments.length; i++) {
    const environment = environments[i]!;
    try {
      const result = await client.getTransaction({
        environment,
        transactionId: input.transactionId,
      });

      if (result.decoded.bundleId !== loaded.material.bundleId) {
        return {
          valid: false,
          error: "BUNDLE_ID_MISMATCH",
          message:
            `Transaction belongs to bundleId "${result.decoded.bundleId}" but tenant is configured for "${loaded.material.bundleId}"`,
        };
      }

      const transaction = normalizeTransaction(result);
      return {
        valid: true,
        environment,
        transaction,
        appUserId: transaction.appAccountToken,
      };
    } catch (err) {
      if (err instanceof AppleTransactionNotFoundError) {
        // Any not-found on a non-final env → try the next. Apple's error-code
        // semantics for env-mismatch vs true-not-found have drifted over time;
        // sandbox-vs-prod checks are cheap, so we try the other env regardless.
        if (i < environments.length - 1) continue;
        break;
      }
      if (err instanceof AppleApiError) {
        // 401 from production typically means "this app isn't authorized for the
        // production environment yet" (pre-launch / TestFlight-only / pending
        // App Store review). Apple's IAP keys auth fine but the production
        // endpoint refuses access. In `auto` mode (multi-env list), fall back
        // to sandbox before giving up — symmetric to AppleTransactionNotFoundError.
        if (err.status === 401 && i < environments.length - 1) continue;
        // Deliberately do NOT attach `cause: err` — AppleApiError messages can
        // embed raw fetch error text (DNS, TLS, proxy messages) that shouldn't
        // propagate through server logs. Keep the typed details; discard the
        // original stack and message.
        throw new AppError(ErrorCodes.APPLE_API_ERROR, "Apple API request failed", {
          details: { status: err.status, appleErrorCode: err.appleErrorCode },
        });
      }
      throw err;
    }
  }

  return {
    valid: false,
    error: "TRANSACTION_NOT_FOUND",
    message: environments.length > 1
      ? "Transaction not found in any environment (production or sandbox)"
      : "Transaction not found",
  };
}

function resolveEnvironments(
  hint: AppleEnvironmentResolved | undefined,
  configured: import("@/db/queries/apple-credentials.ts").AppleEnvironment,
): AppleEnvironmentResolved[] {
  if (hint) return [hint];
  if (configured === "production") return ["production"];
  if (configured === "sandbox") return ["sandbox"];
  return ["production", "sandbox"];
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
    expiresDate: decoded.expiresDate ? new Date(decoded.expiresDate).toISOString() : null,
    type: decoded.type,
    inAppOwnershipType: decoded.inAppOwnershipType ?? "PURCHASED",
    quantity: decoded.quantity ?? 1,
    webOrderLineItemId: decoded.webOrderLineItemId ?? null,
    revocationDate: decoded.revocationDate ? new Date(decoded.revocationDate).toISOString() : null,
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

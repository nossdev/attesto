/**
 * Orchestrates "what is this subscription's status right now?" for Apple:
 * 1. Load the tenant's Apple credentials (decrypted, cached).
 * 2. Call Get All Subscription Statuses in the hinted or configured env,
 *    falling back across environments exactly as `verify.ts` does.
 * 3. Check the response's bundleId against the tenant's.
 * 4. Render Apple's payload in the repo's envelope style (ISO timestamps,
 *    raw payload retained) WITHOUT inventing a cross-platform status.
 *
 * Why not reuse `verify.ts`: that path calls Get Transaction Info, which
 * for an *original* transaction id returns the first period of the
 * subscription. It cannot answer whether the subscription still pays today,
 * and it never returns renewal info (grace period, billing retry,
 * expiration intent).
 */

import {
  type AppleSubscriptionStatusClient,
  AppleTransactionNotFoundError,
} from "@/services/apple/client.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type {
  AppleCredentialMaterial,
  AppleEnvironmentResolved,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";
import type {
  AppleSubscriptionStatusEntry,
  AppleSubscriptionStatusResult,
  DecodedAppleRenewalInfoPayload,
  NormalizedAppleRenewalInfo,
  NormalizedAppleSubscriptionStatus,
} from "@/services/apple/subscription-types.ts";
import {
  APP_APPLE_ID_REMEDIATION,
  requiresProductionAppAppleId,
} from "@/services/apple/preflight.ts";
import { attemptAcrossEnvironments, resolveEnvironments } from "@/services/apple/environments.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { toIsoOrNull as toIso } from "@/lib/iso-time.ts";

export interface AppleSubscriptionStatusInput {
  tenantId: string;
  originalTransactionId: string;
  environmentHint?: AppleEnvironmentResolved;
}

export interface AppleSubscriptionStatusDeps {
  credentialsLoader: AppleCredentialsLoader;
  /** Production wires `createAppleHttpClient`; tests inject a fake. */
  clientFactory: (material: AppleCredentialMaterial) => AppleSubscriptionStatusClient;
}

export async function getAppleSubscriptionStatus(
  deps: AppleSubscriptionStatusDeps,
  input: AppleSubscriptionStatusInput,
): Promise<AppleSubscriptionStatusResult> {
  const loaded = await deps.credentialsLoader.load(input.tenantId);
  if (!loaded) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "Apple credentials are not configured for this tenant",
    );
  }

  const client = deps.clientFactory(loaded.material);
  const environments = resolveEnvironments(input.environmentHint, loaded.environment);

  // Same pre-flight as verify.ts: a production-only tenant with no
  // appAppleId can never construct the SDK verifier, so say so plainly
  // instead of failing deep inside the client. (Auto-mode tenants fall
  // through to sandbox via the 401 handling below.)
  if (requiresProductionAppAppleId(environments, loaded.material.appAppleId)) {
    throw new AppError(ErrorCodes.CREDENTIALS_MISSING, APP_APPLE_ID_REMEDIATION);
  }

  const attempt = await attemptAcrossEnvironments(
    environments,
    async (environment) => {
      const result = await client.getSubscriptionStatuses({
        environment,
        originalTransactionId: input.originalTransactionId,
      });
      // Apple answering 200 with `data: []` is not a positive answer.
      // Returning it as success would report `subscriptions: []` AND skip
      // the sandbox fallback, so a pre-launch app would look permanently
      // unsubscribed. Treat it as not-found so the next environment runs.
      if (result.entries.length === 0) {
        throw new AppleTransactionNotFoundError("transaction_id_not_found");
      }
      return result;
    },
  );

  if (!attempt) {
    return {
      valid: false,
      error: "SUBSCRIPTION_NOT_FOUND",
      message: environments.length > 1
        ? "No subscription found for that original transaction id in any environment (production or sandbox)"
        : "No subscription found for that original transaction id",
    };
  }

  // Prefer the response-level bundleId; fall back to the first decoded
  // transaction for a response that omits it.
  const bundleId = attempt.value.bundleId ?? attempt.value.entries[0]?.transaction.bundleId ?? null;
  if (bundleId !== null && bundleId !== loaded.material.bundleId) {
    return {
      valid: false,
      error: "BUNDLE_ID_MISMATCH",
      message:
        `Subscription belongs to bundleId "${bundleId}" but tenant is configured for "${loaded.material.bundleId}"`,
    };
  }

  const subscriptions = attempt.value.entries.map(normalizeEntry);
  return {
    valid: true,
    environment: attempt.environment,
    subscriptions,
    appUserId: resolveAppUserId(subscriptions, input.originalTransactionId),
  };
}

/**
 * The purchase binding for the subscription the caller actually asked about.
 * Apple answers with the whole subscription group (and one entry per owner
 * under family sharing), so picking the first entry's token could hand back
 * a different person's binding.
 */
function resolveAppUserId(
  subscriptions: NormalizedAppleSubscriptionStatus[],
  originalTransactionId: string,
): string | null {
  const match = subscriptions.find((s) => s.originalTransactionId === originalTransactionId);
  return match?.appAccountToken ?? null;
}

function normalizeRenewalInfo(
  signedRenewalInfo: string,
  decoded: DecodedAppleRenewalInfoPayload,
): NormalizedAppleRenewalInfo {
  return {
    autoRenewStatus: decoded.autoRenewStatus ?? null,
    autoRenewProductId: decoded.autoRenewProductId ?? null,
    expirationIntent: decoded.expirationIntent ?? null,
    isInBillingRetryPeriod: decoded.isInBillingRetryPeriod ?? null,
    gracePeriodExpiresDate: toIso(decoded.gracePeriodExpiresDate),
    renewalDate: toIso(decoded.renewalDate),
    recentSubscriptionStartDate: toIso(decoded.recentSubscriptionStartDate),
    priceIncreaseStatus: decoded.priceIncreaseStatus ?? null,
    offerType: decoded.offerType ?? null,
    offerIdentifier: decoded.offerIdentifier ?? null,
    currency: decoded.currency ?? null,
    renewalPrice: decoded.renewalPrice ?? null,
    signedRenewalInfo,
    rawDecodedPayload: { ...decoded } as Record<string, unknown>,
  };
}

function normalizeEntry(entry: AppleSubscriptionStatusEntry): NormalizedAppleSubscriptionStatus {
  const tx: DecodedAppleTransactionPayload = entry.transaction;

  return {
    subscriptionGroupIdentifier: entry.subscriptionGroupIdentifier,
    status: entry.status,
    originalTransactionId: entry.originalTransactionId ?? tx.originalTransactionId ?? null,
    transactionId: tx.transactionId ?? null,
    bundleId: tx.bundleId ?? null,
    productId: tx.productId ?? null,
    purchaseDate: toIso(tx.purchaseDate),
    expiresDate: toIso(tx.expiresDate),
    revocationDate: toIso(tx.revocationDate),
    revocationReason: tx.revocationReason ?? null,
    offerType: tx.offerType ?? null,
    offerIdentifier: tx.offerIdentifier ?? null,
    appAccountToken: tx.appAccountToken ?? null,
    inAppOwnershipType: tx.inAppOwnershipType ?? null,
    type: tx.type ?? null,
    renewalInfo: entry.signedRenewalInfo && entry.renewalInfo
      ? normalizeRenewalInfo(entry.signedRenewalInfo, entry.renewalInfo)
      : null,
    signedTransactionInfo: entry.signedTransactionInfo,
    rawDecodedPayload: { ...tx } as Record<string, unknown>,
  };
}

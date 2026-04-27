/**
 * Pre-flight checks for the Apple verifier path.
 *
 * The SDK's `SignedDataVerifier` ctor requires `appAppleId` for
 * environment=production (throws otherwise). We catch this at three call
 * sites with subtly different shapes:
 *
 *   1. `verify.ts` — at function entry, when the resolved environment list
 *      is `[production]` only (explicit-production tenant or environment
 *      hint). Throws AppError(CREDENTIALS_MISSING) so the caller sees the
 *      remediation.
 *
 *   2. `client.ts:resolveVerifier` — per-iteration, throws AppleApiError(401)
 *      for production+null. The 401 status reuses verify.ts's existing
 *      401-fallback so auto-mode degrades transparently to sandbox.
 *
 *   3. `apple-receiver.ts:verifyWithEnvironments` — webhooks. Skips the
 *      production env in the loop AND surfaces CREDENTIALS_MISSING after
 *      the loop if the production env was the only viable choice.
 *
 * This module exposes the shared predicate + the operator-facing remediation
 * message so the three sites stay in sync.
 */

import type { AppleEnvironmentResolved } from "@/services/apple/types.ts";

/**
 * True iff the resolved environment list is `[production]` only AND
 * appAppleId is missing — meaning we cannot construct a production verifier
 * AND there's no fallback to try.
 */
export function requiresProductionAppAppleId(
  environments: AppleEnvironmentResolved[],
  appAppleId: number | null,
): boolean {
  return environments.length === 1 &&
    environments[0] === "production" &&
    appAppleId == null;
}

/** Operator-facing remediation message when the production verifier is
 * needed but `appAppleId` is missing. Used by all three pre-flight sites
 * so an operator triaging an error sees the same actionable hint. */
export const APP_APPLE_ID_REMEDIATION = "App Apple ID is required for production " +
  "verification — run `attesto apple:set-credentials --app-apple-id <numeric_app_id>` " +
  "to add it. Find the value in App Store Connect → My Apps → app → " +
  "App Information → Apple ID.";

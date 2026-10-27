/**
 * Apple environment resolution and the production→sandbox fallback.
 *
 * Both Apple lookups (`verify.ts`, `subscription-status.ts`) have to try the
 * same environments in the same order and react identically to Apple's two
 * ambiguous failures. Keeping that in one place is the point: the rules are
 * subtle and two copies drift.
 *
 *   - **Not found.** Apple's error-code semantics for "wrong environment"
 *     (4040005) vs "truly absent" (4040010) have drifted across API
 *     versions, so a not-found in one environment is never conclusive while
 *     another remains untried.
 *   - **401 from production.** An app that hasn't shipped yet (TestFlight
 *     only, or pending review) authenticates fine but production refuses
 *     access. In `auto` mode that must degrade to sandbox, not fail.
 */

import { AppleApiError, AppleTransactionNotFoundError } from "@/services/apple/client.ts";
import type { AppleEnvironmentResolved } from "@/services/apple/types.ts";
import type { AppleEnvironment } from "@/db/queries/apple-credentials.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

/**
 * Which environments to try, in order. An explicit hint from the request
 * wins; otherwise the tenant's configured setting decides, with `auto`
 * meaning production first, then sandbox.
 */
export function resolveEnvironments(
  hint: AppleEnvironmentResolved | undefined,
  configured: AppleEnvironment,
): AppleEnvironmentResolved[] {
  if (hint) return [hint];
  if (configured === "production") return ["production"];
  if (configured === "sandbox") return ["sandbox"];
  return ["production", "sandbox"];
}

export interface EnvironmentAttempt<T> {
  environment: AppleEnvironmentResolved;
  value: T;
}

/**
 * Run `attempt` against each environment in turn, returning the first
 * success together with the environment that produced it, or `null` when
 * every environment reported not-found.
 *
 * Throws `AppError(APPLE_API_ERROR)` for any other upstream fault. The
 * original `AppleApiError` is deliberately NOT attached as `cause`: its
 * message can embed raw fetch text (DNS, TLS, proxy detail) that must not
 * reach the client or the logs.
 */
export async function attemptAcrossEnvironments<T>(
  environments: AppleEnvironmentResolved[],
  attempt: (environment: AppleEnvironmentResolved) => Promise<T>,
): Promise<EnvironmentAttempt<T> | null> {
  for (let i = 0; i < environments.length; i++) {
    const environment = environments[i]!;
    const isLast = i === environments.length - 1;
    try {
      return { environment, value: await attempt(environment) };
    } catch (err) {
      if (err instanceof AppleTransactionNotFoundError) {
        if (!isLast) continue;
        return null;
      }
      if (err instanceof AppleApiError) {
        if (err.status === 401 && !isLast) continue;
        throw new AppError(ErrorCodes.APPLE_API_ERROR, "Apple API request failed", {
          details: { status: err.status, appleErrorCode: err.appleErrorCode },
        });
      }
      throw err;
    }
  }
  return null;
}

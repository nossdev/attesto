/**
 * Wraps Apple's `POST /inApps/v1/notifications/test` endpoint.
 *
 * Asks Apple to dispatch a synthetic V2 notification to whatever webhook URL
 * the operator has configured in App Store Connect. Used by:
 *   - `attesto apple:request-test-notification` CLI subcommand (DB-backed)
 *   - `scripts/apple-test-notification.ts` (one-shot, .p8 from disk)
 *
 * Apple docs:
 *   https://developer.apple.com/documentation/appstoreserverapi/request_a_test_notification
 *
 * The endpoint takes no request body and returns
 * `{ testNotificationToken: string }`. The token is later usable with
 * `GET /inApps/v1/notifications/test/{testNotificationToken}` to inspect
 * delivery state, but for our use case (just trigger and watch fly logs)
 * we surface the token without polling.
 */

import { APPLE_API_BASES, AppleApiError } from "@/services/apple/client.ts";
import { signAppStoreConnectJwt } from "@/services/apple/jwt-signer.ts";
import type { AppleCredentialMaterial } from "@/services/apple/types.ts";
import type { FetchLike } from "@/lib/http-utils.ts";

export type AppleTestNotificationEnv = keyof typeof APPLE_API_BASES;

export interface RequestAppleTestNotificationOptions {
  material: AppleCredentialMaterial;
  env: AppleTestNotificationEnv;
  /** Fetch seam — tests stub Apple's HTTPS endpoint. */
  fetchImpl?: FetchLike;
  /** Override `now` for deterministic JWT iat/exp in tests. */
  now?: () => number;
}

export interface AppleTestNotificationResult {
  testNotificationToken: string;
}

export async function requestAppleTestNotification(
  opts: RequestAppleTestNotificationOptions,
): Promise<AppleTestNotificationResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const jwt = await signAppStoreConnectJwt({
    privateKeyPem: opts.material.privateKeyPem,
    keyId: opts.material.keyId,
    issuerId: opts.material.issuerId,
    bundleId: opts.material.bundleId,
    now: opts.now,
  });

  const url = `${APPLE_API_BASES[opts.env]}/inApps/v1/notifications/test`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
  } catch (err) {
    throw new AppleApiError(err instanceof Error ? err.message : String(err), 0);
  }

  if (!response.ok) {
    const text = await response.text();
    // Apple returns JSON `{ errorCode, errorMessage }` for documented errors;
    // surface the code so operators see e.g. "errorCode=4040007" (account not
    // found) rather than just an opaque status.
    let appleErrorCode: number | undefined;
    try {
      appleErrorCode = (JSON.parse(text) as { errorCode?: number }).errorCode;
    } catch {
      // non-JSON body (rare — typically a 5xx HTML page); fall through with
      // the raw text in the error message.
    }
    throw new AppleApiError(
      `apple returned ${response.status}${
        appleErrorCode !== undefined ? ` errorCode=${appleErrorCode}` : ""
      }: ${text}`,
      response.status,
      appleErrorCode,
    );
  }

  const body = await response.json() as { testNotificationToken?: unknown };
  if (typeof body.testNotificationToken !== "string" || body.testNotificationToken.length === 0) {
    throw new AppleApiError(
      "apple response missing testNotificationToken",
      response.status,
    );
  }
  return { testNotificationToken: body.testNotificationToken };
}

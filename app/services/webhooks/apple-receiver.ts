/**
 * Apple App Store Server Notifications V2 receiver.
 *
 * Accepts `{ signedPayload: "<JWS>" }`, VERIFIES the JWS signature against
 * Apple's pinned certificate chain (via `@apple/app-store-server-library`),
 * dedupes on Apple's `notificationUUID`, persists, and enqueues delivery.
 *
 * Verification requires the tenant to have Apple credentials configured
 * (`apple_credentials.bundle_id` + `environment`) so we know what bundle
 * this webhook should match. For env=auto, we try both production and
 * sandbox verification — whichever signature resolves wins.
 */

import type { Database } from "@/db/client.ts";
import { insertWebhookEventIdempotent } from "@/db/queries/webhooks.ts";
import { getAppleCredentials } from "@/db/queries/apple-credentials.ts";
import {
  AppleJwsVerificationError,
  type AppleJwsVerifierCache,
  type DecodedJwsPayload,
} from "@/services/apple/jws-verifier.ts";
import { decodeJwsPayload } from "@/services/apple/client.ts";
import type { AppleEnvironmentResolved } from "@/services/apple/types.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { maybeEnqueueDeliveryForEvent } from "@/services/webhooks/enqueue.ts";

export interface ReceiveAppleWebhookInput {
  tenantId: string;
  body: { signedPayload?: unknown };
}

export interface ReceiveWebhookResult {
  eventId: string;
  externalId: string;
  isNew: boolean;
  /** True if a delivery row was enqueued for this event. */
  enqueuedDelivery: boolean;
}

function normalizeAppleEventType(decoded: DecodedJwsPayload): string {
  const type = typeof decoded.notificationType === "string"
    ? decoded.notificationType.toLowerCase()
    : "unknown";
  const subtype = typeof decoded.subtype === "string" ? `.${decoded.subtype.toLowerCase()}` : "";
  return `apple.${type}${subtype}`;
}

/**
 * Peek at the JWS payload (WITHOUT verifying the signature) to read the
 * `environment` claim Apple embeds in every notification. This is a
 * hint — NOT trusted on its own — used only to pick which verifier to
 * invoke. The actual signature verification then runs against that env's
 * Apple-chain-pinned `SignedDataVerifier`. This saves the ~50ms OCSP
 * roundtrip that would be spent verifying against the WRONG env first
 * when the tenant is configured `auto`.
 */
function peekAppleEnvironment(signedPayload: string): AppleEnvironmentResolved | null {
  try {
    const decoded = decodeJwsPayload(signedPayload);
    const env = decoded.environment;
    if (env === "Production") return "production";
    if (env === "Sandbox") return "sandbox";
  } catch {
    // Malformed JWS — let the real verifier produce the canonical error.
  }
  return null;
}

async function verifyWithEnvironments(
  verifierCache: AppleJwsVerifierCache,
  bundleId: string,
  configuredEnvs: AppleEnvironmentResolved[],
  signedPayload: string,
  appAppleId: number | null,
): Promise<DecodedJwsPayload> {
  // If configured=auto, use the payload's self-declared environment to
  // pick a single verifier. The verifier still cryptographically checks
  // the env match — this peek is purely a perf hint.
  let environments = configuredEnvs;
  if (configuredEnvs.length > 1) {
    const hint = peekAppleEnvironment(signedPayload);
    if (hint) environments = [hint];
  }

  let lastError: AppleJwsVerificationError | null = null;
  for (const env of environments) {
    // Pre-flight: SDK requires appAppleId for production-env verifier
    // construction. Skip production verifiers when missing — for `auto`
    // tenants this transparently degrades to sandbox-only (matching the
    // verify path's behavior). Symmetric with apple/client.ts:118.
    if (env === "production" && appAppleId == null) continue;
    try {
      const verifier = await verifierCache.get(bundleId, env, appAppleId ?? undefined);
      return await verifier.verifyNotification(signedPayload);
    } catch (err) {
      if (err instanceof AppleJwsVerificationError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  // Peek picked the wrong env (attacker-tampered payload) — fall back to
  // the other env from the original configured list. Only runs when we
  // narrowed `environments` above.
  if (
    environments.length === 1 && configuredEnvs.length > 1 &&
    lastError
  ) {
    const alt = configuredEnvs.find((e) => e !== environments[0]);
    if (alt && !(alt === "production" && appAppleId == null)) {
      try {
        const verifier = await verifierCache.get(bundleId, alt, appAppleId ?? undefined);
        return await verifier.verifyNotification(signedPayload);
      } catch (err) {
        if (err instanceof AppleJwsVerificationError) lastError = err;
        else throw err;
      }
    }
  }
  throw lastError ??
    new AppleJwsVerificationError("no candidate environments produced a valid verification");
}

export interface ReceiveAppleWebhookDeps {
  db: Database;
  verifierCache: AppleJwsVerifierCache;
}

export async function receiveAppleWebhook(
  deps: ReceiveAppleWebhookDeps,
  input: ReceiveAppleWebhookInput,
): Promise<ReceiveWebhookResult> {
  const { signedPayload } = input.body;
  if (typeof signedPayload !== "string" || signedPayload.length === 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Missing or empty signedPayload");
  }

  const creds = await getAppleCredentials(deps.db, input.tenantId);
  if (!creds) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "Apple credentials must be configured before receiving webhooks for this tenant",
    );
  }

  const environments: AppleEnvironmentResolved[] = creds.environment === "production"
    ? ["production"]
    : creds.environment === "sandbox"
    ? ["sandbox"]
    : ["production", "sandbox"];

  // Symmetric with verify.ts pre-flight: explicit `production` config without
  // appAppleId can't construct a production verifier and there's no fallback,
  // so surface a clear remediation message before attempting verification.
  if (
    environments.length === 1 && environments[0] === "production" &&
    creds.appAppleId == null
  ) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "App Apple ID is required for production webhook verification — run " +
        "`attesto apple:set-credentials --app-apple-id <numeric_app_id>` to add it.",
    );
  }

  let decoded: DecodedJwsPayload;
  try {
    decoded = await verifyWithEnvironments(
      deps.verifierCache,
      creds.bundleId,
      environments,
      signedPayload,
      creds.appAppleId ?? null,
    );
  } catch (err) {
    if (err instanceof AppleJwsVerificationError) {
      throw new AppError(ErrorCodes.SIGNATURE_INVALID, "Apple JWS signature verification failed");
    }
    throw err;
  }

  const notificationUUID = typeof decoded.notificationUUID === "string"
    ? decoded.notificationUUID
    : null;
  if (!notificationUUID) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Decoded payload missing notificationUUID");
  }

  const eventType = normalizeAppleEventType(decoded);

  const { event, isNew } = await insertWebhookEventIdempotent(deps.db, {
    tenantId: input.tenantId,
    source: "apple",
    externalId: notificationUUID,
    eventType,
    rawPayload: { signedPayload },
    decodedPayload: decoded as Record<string, unknown>,
  });

  const enqueuedDelivery = isNew ? await maybeEnqueueDeliveryForEvent(deps.db, event) : false;

  return {
    eventId: event.id,
    externalId: notificationUUID,
    isNew,
    enqueuedDelivery,
  };
}

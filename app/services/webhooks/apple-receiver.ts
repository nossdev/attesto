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
import {
  APP_APPLE_ID_REMEDIATION,
  requiresProductionAppAppleId,
} from "@/services/apple/preflight.ts";
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
  // Track when we declined to construct a production verifier because of a
  // missing appAppleId. If the loop ends without a successful verification,
  // we surface this as CREDENTIALS_MISSING (NOT SIGNATURE_INVALID) — the
  // operator's tenant lacks the credential needed to verify production
  // webhooks, not a bad signature.
  let productionSkipped = false;
  for (const env of environments) {
    // Pre-flight: SDK requires appAppleId for production-env verifier
    // construction. Skip production verifiers when missing — for `auto`
    // tenants this lets sandbox attempt to verify; if sandbox doesn't
    // verify either (because the JWS was actually production-signed), we
    // surface CREDENTIALS_MISSING below. Symmetric with apple/client.ts.
    if (env === "production" && appAppleId == null) {
      productionSkipped = true;
      continue;
    }
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
  // the other env from the original configured list. Triggers when we
  // narrowed `environments` AND something happened (either a sandbox
  // failure OR we skipped production due to missing appAppleId).
  if (
    environments.length === 1 && configuredEnvs.length > 1 &&
    (lastError || productionSkipped)
  ) {
    const alt = configuredEnvs.find((e) => e !== environments[0]);
    if (alt === "production" && appAppleId == null) {
      productionSkipped = true;
    } else if (alt) {
      try {
        const verifier = await verifierCache.get(bundleId, alt, appAppleId ?? undefined);
        return await verifier.verifyNotification(signedPayload);
      } catch (err) {
        if (err instanceof AppleJwsVerificationError) lastError = err;
        else throw err;
      }
    }
  }
  // If production was skipped (or skippable) and nothing else verified,
  // the operator's tenant is missing required credentials for production
  // webhooks. Surface as CREDENTIALS_MISSING so they get the actionable
  // remediation, not a misleading SIGNATURE_INVALID.
  if (productionSkipped) {
    throw new AppError(ErrorCodes.CREDENTIALS_MISSING, APP_APPLE_ID_REMEDIATION);
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
  // Predicate + message shared with the verify path via preflight.ts.
  if (requiresProductionAppAppleId(environments, creds.appAppleId ?? null)) {
    throw new AppError(ErrorCodes.CREDENTIALS_MISSING, APP_APPLE_ID_REMEDIATION);
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
      // The SDK's underlying error names the actual failure mode (bundleId
      // mismatch, environment mismatch, OCSP failure, cert chain, etc.).
      // Apple's `VerificationException` extends Error but constructs with
      // `super()` (no message), so `.message` is empty and the real signal
      // lives on `.status` (a numeric VerificationStatus) and `.cause`.
      // Capture both. The HTTP response still collapses to SIGNATURE_INVALID
      // — we don't leak detail to unauthenticated callers — but operators
      // get full ground truth in fly logs.
      // Apple SDK VerificationStatus enum (verbatim from
      // @apple/app-store-server-library@3.0.0/dist/jws_verification.js):
      //   0=OK, 1=VERIFICATION_FAILURE, 2=RETRYABLE_VERIFICATION_FAILURE,
      //   3=INVALID_APP_IDENTIFIER, 4=INVALID_ENVIRONMENT,
      //   5=INVALID_CHAIN_LENGTH, 6=INVALID_CERTIFICATE, 7=FAILURE
      //
      // Status 6 (INVALID_CERTIFICATE) deserves special care: the SDK's
      // verifyJWT() wraps a try/catch around BOTH the chain-length check
      // (which throws status 5) AND `new X509Certificate(...)`, then
      // re-classifies whatever bubbles out as status 6 with the original as
      // .cause. So a status-6 with a nested-cause status-5 means "wrong
      // x5c chain length"; a status-6 with no nested .status means a real
      // X509 parse failure (and the inner cause's .message will name the
      // ASN.1 / DER complaint).
      const causeObj = (err.cause ?? {}) as {
        status?: unknown;
        message?: unknown;
        name?: unknown;
        cause?: { status?: unknown; message?: unknown; name?: unknown };
      };
      const inner = causeObj.cause ?? {};
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "apple_jws_verification_failed",
          tenantId: input.tenantId,
          bundleId: creds.bundleId,
          environments,
          appAppleIdPresent: creds.appAppleId != null,
          reason: err.message || null,
          sdkStatus: causeObj.status ?? null,
          sdkCauseName: causeObj.name ?? null,
          sdkCauseMessage: causeObj.message ?? null,
          // One level deeper — disambiguates SDK self-re-classification
          // (e.g. nested status:5 inside outer status:6).
          sdkInnerStatus: inner.status ?? null,
          sdkInnerName: inner.name ?? null,
          sdkInnerMessage: inner.message ?? null,
        }),
      );
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

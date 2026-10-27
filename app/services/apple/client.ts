/**
 * Abstraction over the App Store Server API — lets us swap real HTTPS calls
 * for deterministic fakes in tests.
 *
 * The real adapter signs an ES256 JWT per request (using the tenant's `.p8`
 * via `jwt-signer.ts`), calls Apple's transaction endpoint, and VERIFIES
 * the `signedTransactionInfo` JWS via `@apple/app-store-server-library`'s
 * `SignedDataVerifier`. Transport is already TLS-authenticated; the JWS
 * verification layers on cryptographic attestation of the payload contents.
 */

import type {
  AppleCredentialMaterial,
  AppleEnvironmentResolved,
  AppleTransactionFetchResult,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";
import type {
  AppleSubscriptionStatusEntry,
  AppleSubscriptionStatusFetchResult,
  DecodedAppleRenewalInfoPayload,
} from "@/services/apple/subscription-types.ts";
import { signAppStoreConnectJwt } from "@/services/apple/jwt-signer.ts";
import {
  type AppleJwsVerifier,
  type AppleJwsVerifierCache,
} from "@/services/apple/jws-verifier.ts";
import { type FetchLike, safeReadJson } from "@/lib/http-utils.ts";
import { fromBase64Url } from "@/lib/crypto-utils.ts";

// Canonical hosts for the App Store Server API. Re-exported so other modules
// (test-notification, future endpoints) share one source of truth.
export const APPLE_API_BASES = {
  production: "https://api.storekit.itunes.apple.com",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
} as const;
const PRODUCTION_BASE = APPLE_API_BASES.production;
const SANDBOX_BASE = APPLE_API_BASES.sandbox;

type TransactionNotFoundReason =
  | "transaction_id_not_found"
  | "environment_mismatch";

export class AppleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly appleErrorCode?: number,
  ) {
    super(message);
    this.name = "AppleApiError";
  }
}

export class AppleTransactionNotFoundError extends Error {
  constructor(readonly reason: TransactionNotFoundReason) {
    super(`apple: ${reason}`);
    this.name = "AppleTransactionNotFoundError";
  }
}

export interface GetTransactionArgs {
  environment: AppleEnvironmentResolved;
  transactionId: string;
}

export interface GetSubscriptionStatusesArgs {
  environment: AppleEnvironmentResolved;
  originalTransactionId: string;
}

/**
 * The subscription-status lookup, narrowed to its own interface so the
 * status service (and its fakes) need not know about the transaction path.
 */
export interface AppleSubscriptionStatusClient {
  /**
   * Fetch a subscription's current status from Apple's **Get All
   * Subscription Statuses** endpoint and verify+decode every JWS it
   * carries (`signedTransactionInfo` and, when present,
   * `signedRenewalInfo`).
   *
   * Unlike `getTransaction`, this answers "does it still pay *now*?" for an
   * original transaction id — Get Transaction Info would return the first
   * period instead.
   *
   * Error contract matches `getTransaction`: throws
   * `AppleTransactionNotFoundError` for a known 404, `AppleApiError`
   * otherwise (including JWS verification failures).
   */
  getSubscriptionStatuses(
    args: GetSubscriptionStatusesArgs,
  ): Promise<AppleSubscriptionStatusFetchResult>;
}

export interface AppleClient extends AppleSubscriptionStatusClient {
  /**
   * Fetch a transaction from Apple and verify+decode its JWS payload.
   * - Returns `{signedTransactionInfo, decoded}` on success.
   * - Throws `AppleTransactionNotFoundError` for 404 with a known errorCode.
   * - Throws `AppleApiError` for auth / server / transport / unknown 404s
   *   / JWS signature verification failures.
   */
  getTransaction(args: GetTransactionArgs): Promise<AppleTransactionFetchResult>;
}

/** Apple error codes documented at
 *  https://developer.apple.com/documentation/appstoreserverapi/error_codes */
const APPLE_ERR_TRANSACTION_NOT_FOUND = 4040010;
const APPLE_ERR_TRANSACTION_ENV_MISMATCH = 4040005;
// Sandbox returns 400 with this errorCode for malformed-or-nonexistent
// transactionIds (e.g. wrong digit count, wrong leading digit). Operationally
// indistinguishable from 404 + TRANSACTION_NOT_FOUND from the verify caller's
// perspective, so we map both to the same not-found result.
const APPLE_ERR_INVALID_TRANSACTION_ID = 4000006;

function baseUrlFor(env: AppleEnvironmentResolved): string {
  return env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

/**
 * UNVERIFIED decode of a JWS payload — peeks at the middle segment. Exported
 * because Phase 5 webhook tests built their fakes on top of this. The
 * production verify path uses SDK-backed verification via
 * `AppleJwsVerifier.verifyTransaction` instead.
 */
export function decodeJwsPayload(jws: string): Record<string, unknown> {
  const segments = jws.split(".");
  if (segments.length !== 3) {
    throw new Error(`apple: malformed JWS (expected 3 segments, got ${segments.length})`);
  }
  const bytes = fromBase64Url(segments[1]!);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export interface CreateAppleHttpClientOptions {
  credentials: AppleCredentialMaterial;
  /** Fetcher seam — tests stub Apple's HTTPS endpoint. */
  fetchImpl?: FetchLike;
  /** Applied to the entire request lifecycle (connect + headers + body read). */
  timeoutMs?: number;
  /**
   * JWS verifier for Apple's response. One of `verifier` or `verifierCache`
   * must be provided. Use `verifierCache` at the app boundary (it memoizes
   * per (bundleId, env)); use `verifier` directly in tests with a stub.
   */
  verifier?: AppleJwsVerifier;
  verifierCache?: AppleJwsVerifierCache;
}

export function createAppleHttpClient(opts: CreateAppleHttpClientOptions): AppleClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!opts.verifier && !opts.verifierCache) {
    throw new Error("createAppleHttpClient: `verifier` or `verifierCache` is required");
  }

  async function resolveVerifier(env: AppleEnvironmentResolved): Promise<AppleJwsVerifier> {
    if (opts.verifier) return opts.verifier;
    // Pre-flight: the SDK's SignedDataVerifier ctor throws when env=production
    // and appAppleId is undefined. Catch that here BEFORE the cache.get call —
    // throwing AppleApiError(401) lets verify.ts's existing 401-fallback
    // transparently degrade auto-mode tenants to sandbox without ever
    // reaching the SDK. For explicit production tenants, verify.ts's
    // pre-loop guard turns this into a CREDENTIALS_MISSING with a
    // helpful message; we never reach this branch for explicit-prod-only.
    if (env === "production" && opts.credentials.appAppleId == null) {
      throw new AppleApiError(
        "appAppleId required for production verifier construction",
        401,
      );
    }
    return await opts.verifierCache!.get(
      opts.credentials.bundleId,
      env,
      opts.credentials.appAppleId ?? undefined,
    );
  }

  /**
   * Shared request path for every App Store Server API GET: signs a fresh
   * ES256 JWT, applies the timeout, and maps Apple's error vocabulary onto
   * our two error classes. Extracted so `getTransaction` and
   * `getSubscriptionStatuses` cannot drift in how they classify a 404.
   */
  async function appleGet(
    environment: AppleEnvironmentResolved,
    path: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const jwt = await signAppStoreConnectJwt({
      privateKeyPem: opts.credentials.privateKeyPem,
      keyId: opts.credentials.keyId,
      issuerId: opts.credentials.issuerId,
      bundleId: opts.credentials.bundleId,
    });
    const url = `${baseUrlFor(environment)}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        throw new AppleApiError(
          err instanceof Error ? err.message : String(err),
          0,
        );
      }

      if (response.status === 404) {
        const body = await safeReadJson(response);
        const code = (body as { errorCode?: number } | null)?.errorCode;
        if (code === APPLE_ERR_TRANSACTION_ENV_MISMATCH) {
          throw new AppleTransactionNotFoundError("environment_mismatch");
        }
        if (code === APPLE_ERR_TRANSACTION_NOT_FOUND) {
          throw new AppleTransactionNotFoundError("transaction_id_not_found");
        }
        throw new AppleApiError(`apple 404 with errorCode ${code ?? "(none)"}`, 404, code);
      }
      if (!response.ok) {
        const body = await safeReadJson(response);
        const code = (body as { errorCode?: number } | null)?.errorCode;
        if (code === APPLE_ERR_INVALID_TRANSACTION_ID) {
          throw new AppleTransactionNotFoundError("transaction_id_not_found");
        }
        throw new AppleApiError(`apple returned ${response.status}`, response.status, code);
      }

      return {
        status: response.status,
        body: await response.json() as Record<string, unknown>,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verify one JWS, converting any verifier rejection into AppleApiError. */
  async function verifyJws(
    verifier: AppleJwsVerifier,
    kind: "transaction" | "renewal info",
    jws: string,
    status: number,
  ): Promise<Record<string, unknown>> {
    try {
      return kind === "transaction"
        ? await verifier.verifyTransaction(jws)
        : await verifier.verifyRenewalInfo(jws);
    } catch (err) {
      throw new AppleApiError(
        `apple ${kind} JWS signature verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status,
      );
    }
  }

  return {
    async getTransaction(args) {
      const { status, body } = await appleGet(
        args.environment,
        `/inApps/v1/transactions/${encodeURIComponent(args.transactionId)}`,
      );
      const signedTransactionInfo = (body as { signedTransactionInfo?: string })
        .signedTransactionInfo;
      if (!signedTransactionInfo) {
        throw new AppleApiError("apple response missing signedTransactionInfo", status);
      }

      // Verify the JWS signature against Apple's cert chain. Failures
      // surface as AppleApiError so verify callers treat them as upstream
      // faults rather than tenant-facing validation errors.
      const verifier = await resolveVerifier(args.environment);
      const decoded = await verifyJws(verifier, "transaction", signedTransactionInfo, status);

      return {
        signedTransactionInfo,
        decoded: decoded as unknown as DecodedAppleTransactionPayload,
      };
    },

    async getSubscriptionStatuses(args) {
      const { status, body } = await appleGet(
        args.environment,
        `/inApps/v1/subscriptions/${encodeURIComponent(args.originalTransactionId)}`,
      );
      const verifier = await resolveVerifier(args.environment);

      const groups = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : [];
      const entries: AppleSubscriptionStatusEntry[] = [];
      for (const group of groups) {
        const groupId = typeof group.subscriptionGroupIdentifier === "string"
          ? group.subscriptionGroupIdentifier
          : null;
        const lastTransactions = Array.isArray(group.lastTransactions)
          ? group.lastTransactions as Array<Record<string, unknown>>
          : [];
        for (const item of lastTransactions) {
          const signedTransactionInfo = typeof item.signedTransactionInfo === "string"
            ? item.signedTransactionInfo
            : null;
          if (!signedTransactionInfo) {
            throw new AppleApiError(
              "apple subscription status entry missing signedTransactionInfo",
              status,
            );
          }
          const transaction = await verifyJws(
            verifier,
            "transaction",
            signedTransactionInfo,
            status,
          );
          // Apple omits signedRenewalInfo for transactions with nothing left
          // to renew (revoked / non-renewing). Absent is not an error.
          const signedRenewalInfo = typeof item.signedRenewalInfo === "string"
            ? item.signedRenewalInfo
            : null;
          const renewalInfo = signedRenewalInfo
            ? await verifyJws(verifier, "renewal info", signedRenewalInfo, status)
            : null;

          entries.push({
            subscriptionGroupIdentifier: groupId,
            status: typeof item.status === "number" ? item.status : null,
            originalTransactionId: typeof item.originalTransactionId === "string"
              ? item.originalTransactionId
              : null,
            signedTransactionInfo,
            transaction: transaction as unknown as DecodedAppleTransactionPayload,
            signedRenewalInfo,
            renewalInfo: renewalInfo as DecodedAppleRenewalInfoPayload | null,
          });
        }
      }

      return {
        bundleId: typeof body.bundleId === "string" ? body.bundleId : null,
        environment: typeof body.environment === "string" ? body.environment : null,
        appAppleId: typeof body.appAppleId === "number" ? body.appAppleId : null,
        entries,
      };
    },
  };
}

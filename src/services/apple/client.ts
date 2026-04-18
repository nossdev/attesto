/**
 * Abstraction over the App Store Server API — lets us swap real HTTPS calls
 * for deterministic fakes in tests.
 *
 * The real adapter signs an ES256 JWT per request (using the tenant's `.p8`
 * via `jwt-signer.ts`), calls Apple's transaction endpoint, and decodes the
 * `signedTransactionInfo` JWS payload. JWS signature verification (Apple
 * cert chain) is deferred to a hardening pass — transport security (TLS to
 * api.storekit[-sandbox].itunes.apple.com) already authenticates the
 * response. See Phase 3 close-out notes.
 */

import type {
  AppleCredentialMaterial,
  AppleEnvironmentResolved,
  AppleTransactionFetchResult,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";
import { signAppStoreConnectJwt } from "@/services/apple/jwt-signer.ts";
import { type FetchLike, safeReadJson } from "@/lib/http-utils.ts";

const PRODUCTION_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

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

export interface AppleClient {
  /**
   * Fetch a transaction from Apple and decode its JWS payload.
   * - Returns `{signedTransactionInfo, decoded}` on success.
   * - Throws `AppleTransactionNotFoundError` for 404 with a known errorCode.
   * - Throws `AppleApiError` for auth / server / transport / unknown 404s.
   */
  getTransaction(args: GetTransactionArgs): Promise<AppleTransactionFetchResult>;
}

/** Apple error codes documented at
 *  https://developer.apple.com/documentation/appstoreserverapi/error_codes */
const APPLE_ERR_TRANSACTION_NOT_FOUND = 4040010;
const APPLE_ERR_TRANSACTION_ENV_MISMATCH = 4040005;

function baseUrlFor(env: AppleEnvironmentResolved): string {
  return env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

export function decodeJwsPayload(jws: string): Record<string, unknown> {
  const segments = jws.split(".");
  if (segments.length !== 3) {
    throw new Error(`apple: malformed JWS (expected 3 segments, got ${segments.length})`);
  }
  const payload = segments[1]!;
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (payload.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export interface CreateAppleHttpClientOptions {
  credentials: AppleCredentialMaterial;
  /** Fetcher seam — tests stub Apple's HTTPS endpoint. */
  fetchImpl?: FetchLike;
  /** Applied to the entire request lifecycle (connect + headers + body read). */
  timeoutMs?: number;
}

export function createAppleHttpClient(opts: CreateAppleHttpClientOptions): AppleClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async getTransaction(args) {
      const jwt = await signAppStoreConnectJwt({
        privateKeyPem: opts.credentials.privateKeyPem,
        keyId: opts.credentials.keyId,
        issuerId: opts.credentials.issuerId,
        bundleId: opts.credentials.bundleId,
      });
      const url = `${baseUrlFor(args.environment)}/inApps/v1/transactions/${
        encodeURIComponent(args.transactionId)
      }`;
      // A single AbortController gates the whole request — connect, headers, AND
      // body read. Clearing the timer only after the body is consumed prevents
      // a slow upstream from wedging requests past the declared timeout.
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
          // Unknown / missing errorCode on 404 — upstream outage, HTML error
          // page, or proxy-injected 404. Escalate to AppleApiError so the
          // consumer sees a 502 rather than reporting "not found" to the
          // tenant and masking the outage.
          throw new AppleApiError(`apple 404 with errorCode ${code ?? "(none)"}`, 404, code);
        }
        if (!response.ok) {
          const body = await safeReadJson(response);
          const code = (body as { errorCode?: number } | null)?.errorCode;
          throw new AppleApiError(`apple returned ${response.status}`, response.status, code);
        }

        const body = await response.json() as { signedTransactionInfo?: string };
        if (!body.signedTransactionInfo) {
          throw new AppleApiError("apple response missing signedTransactionInfo", response.status);
        }
        return {
          signedTransactionInfo: body.signedTransactionInfo,
          decoded: decodeJwsPayload(
            body.signedTransactionInfo,
          ) as unknown as DecodedAppleTransactionPayload,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

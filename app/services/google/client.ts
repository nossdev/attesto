/**
 * Google Play Developer API client for purchase verification.
 *
 * Pluggable `GoogleClient` interface mirrors the Apple pattern: tests inject
 * a fake; production wires `createGoogleHttpClient` which handles the
 * service-account JWT + OAuth exchange + authenticated Play API call.
 */

import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleCredentialMaterial, GooglePurchaseType } from "@/services/google/types.ts";
import { type FetchLike, safeReadJson } from "@/lib/http-utils.ts";

const PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly googleErrorCode?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export class GoogleRateLimitError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("google: rate limit exceeded");
    this.name = "GoogleRateLimitError";
  }
}

export type PurchaseNotFoundReason = "not_found" | "gone";

export class GooglePurchaseNotFoundError extends Error {
  constructor(readonly reason: PurchaseNotFoundReason = "not_found") {
    super(`google: purchase token ${reason === "gone" ? "gone (410)" : "not found (404)"}`);
    this.name = "GooglePurchaseNotFoundError";
  }
}

export interface GetPurchaseArgs {
  type: GooglePurchaseType;
  productId: string;
  purchaseToken: string;
}

export interface GooglePurchaseFetchResult {
  raw: Record<string, unknown>;
}

export interface GoogleClient {
  getPurchase(args: GetPurchaseArgs): Promise<GooglePurchaseFetchResult>;
}

export interface CreateGoogleHttpClientOptions {
  credentials: GoogleCredentialMaterial;
  /** Token provider owns OAuth exchange + cache — usually shared across tenants. */
  tokenProvider: AccessTokenProvider;
  /** Cache key for access tokens (normally the tenant id). */
  tenantCacheKey: string;
  /** Fetcher seam — tests stub Google's HTTPS endpoint. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function buildUrl(packageName: string, args: GetPurchaseArgs): string {
  const encPkg = encodeURIComponent(packageName);
  const encProd = encodeURIComponent(args.productId);
  const encToken = encodeURIComponent(args.purchaseToken);
  if (args.type === "subscription") {
    // v2 endpoint: per-token, no productId in the path.
    return `${PLAY_API_BASE}/applications/${encPkg}/purchases/subscriptionsv2/tokens/${encToken}`;
  }
  return `${PLAY_API_BASE}/applications/${encPkg}/purchases/products/${encProd}/tokens/${encToken}`;
}

export function createGoogleHttpClient(opts: CreateGoogleHttpClientOptions): GoogleClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async getPurchase(args) {
      const accessToken = await opts.tokenProvider.getAccessToken(
        opts.tenantCacheKey,
        opts.credentials.serviceAccount,
      );
      const url = buildUrl(opts.credentials.packageName, args);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
            signal: controller.signal,
          });
        } catch (err) {
          throw new GoogleApiError(
            err instanceof Error ? err.message : String(err),
            0,
          );
        }

        if (response.status === 404) {
          throw new GooglePurchaseNotFoundError("not_found");
        }
        if (response.status === 410) {
          // Google returns 410 Gone for tokens that were acknowledged +
          // consumed or products flagged for delete-after-consumption —
          // distinct operationally from a never-existed 404.
          throw new GooglePurchaseNotFoundError("gone");
        }
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
            ? Number(retryAfterHeader)
            : undefined;
          throw new GoogleRateLimitError(retryAfterSeconds);
        }
        if (!response.ok) {
          const body = await safeReadJson(response);
          const code = (body as { error?: { status?: string } } | null)?.error?.status;
          throw new GoogleApiError(
            `google returned ${response.status}`,
            response.status,
            code,
          );
        }

        const raw = await response.json() as Record<string, unknown>;
        return { raw };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

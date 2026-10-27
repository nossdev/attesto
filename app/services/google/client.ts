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
import { AppError, ErrorCodes } from "@/lib/errors.ts";

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

/**
 * Translate a non-domain Google fault into Attesto's client-facing error.
 *
 * Shared because both lookups must classify identically. The raw upstream
 * message is deliberately DISCARDED: Deno's fetch error text embeds the
 * full request URL, which contains the purchase token.
 *
 * `GooglePurchaseNotFoundError` is NOT handled here — a missing purchase is
 * a domain outcome each caller names for itself (`PURCHASE_NOT_FOUND` vs
 * `SUBSCRIPTION_NOT_FOUND`).
 */
export function mapGoogleApiError(err: unknown): AppError | null {
  if (err instanceof GoogleRateLimitError) {
    return new AppError(ErrorCodes.RATE_LIMITED, "Google Play quota exceeded", {
      details: err.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: err.retryAfterSeconds }
        : undefined,
    });
  }
  if (err instanceof GoogleApiError) {
    return new AppError(ErrorCodes.GOOGLE_API_ERROR, "Google API request failed", {
      details: { status: err.status, googleErrorCode: err.googleErrorCode },
    });
  }
  return null;
}

export interface GetPurchaseArgs {
  type: GooglePurchaseType;
  productId: string;
  purchaseToken: string;
}

export interface GetSubscriptionArgs {
  purchaseToken: string;
}

export interface ListVoidedPurchasesArgs {
  /** Window start, ms epoch as a string. Google caps the lookback at 30 days. */
  startTimeMillis?: string;
  endTimeMillis?: string;
  /**
   * Google's `type`: 0 = one-time product purchases only, 1 = those AND
   * voided subscription purchases. Attesto defaults to 1 — see the client.
   */
  type?: 0 | 1;
  maxResults?: number;
  /** Google's opaque `token` page cursor. */
  pageToken?: string;
}

export interface GooglePurchaseFetchResult {
  raw: Record<string, unknown>;
}

/**
 * The subscriptionsv2 lookup, narrowed to its own interface so the
 * subscription-status service (and its fakes) need not know about the
 * product path.
 */
export interface GoogleSubscriptionClient {
  /**
   * Resolve a subscription purchase token against `subscriptionsv2`.
   *
   * Unlike `getPurchase`, this takes no `productId` — v2 is per-token and
   * a status caller holding only a stored purchase reference has no product
   * id to supply.
   */
  getSubscription(args: GetSubscriptionArgs): Promise<GooglePurchaseFetchResult>;
}

/**
 * The Voided Purchases lookup, narrowed to its own interface.
 *
 * Separate from the purchase lookups because it is the only call that needs
 * the service account to hold **"View financial data"** in Play Console; a
 * deployment without it gets 401/403 here while everything else works.
 */
export interface GoogleVoidedPurchasesClient {
  /**
   * One page of the app's voided (refunded / revoked / charged-back)
   * purchases.
   *
   * This is a per-APP list over a time window, not a per-token lookup:
   * Google offers no "is this token voided?" endpoint. Answering that
   * question means paging this list and matching — see
   * `services/google/voided-purchases.ts`.
   */
  listVoidedPurchases(args: ListVoidedPurchasesArgs): Promise<GooglePurchaseFetchResult>;
}

export interface GoogleClient extends GoogleSubscriptionClient, GoogleVoidedPurchasesClient {
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

/** v2 subscription endpoint: per-token, no productId in the path. */
function subscriptionUrl(packageName: string, purchaseToken: string): string {
  const encPkg = encodeURIComponent(packageName);
  const encToken = encodeURIComponent(purchaseToken);
  return `${PLAY_API_BASE}/applications/${encPkg}/purchases/subscriptionsv2/tokens/${encToken}`;
}

function voidedPurchasesUrl(packageName: string, args: ListVoidedPurchasesArgs): string {
  const q = new URLSearchParams();
  // Google's own default for `type` is 0 — one-time products only, silently
  // omitting voided SUBSCRIPTIONS. For a caller asking "was this refunded?"
  // that reads as "no", so Attesto defaults to 1 instead.
  q.set("type", String(args.type ?? 1));
  if (args.startTimeMillis !== undefined) q.set("startTime", args.startTimeMillis);
  if (args.endTimeMillis !== undefined) q.set("endTime", args.endTimeMillis);
  if (args.maxResults !== undefined) q.set("maxResults", String(args.maxResults));
  if (args.pageToken !== undefined) q.set("token", args.pageToken);
  return `${PLAY_API_BASE}/applications/${
    encodeURIComponent(packageName)
  }/purchases/voidedpurchases?${q.toString()}`;
}

function buildUrl(packageName: string, args: GetPurchaseArgs): string {
  if (args.type === "subscription") {
    return subscriptionUrl(packageName, args.purchaseToken);
  }
  const encPkg = encodeURIComponent(packageName);
  const encProd = encodeURIComponent(args.productId);
  const encToken = encodeURIComponent(args.purchaseToken);
  return `${PLAY_API_BASE}/applications/${encPkg}/purchases/products/${encProd}/tokens/${encToken}`;
}

export function createGoogleHttpClient(opts: CreateGoogleHttpClientOptions): GoogleClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  /**
   * Shared request path: OAuth token, timeout, and Google's error
   * vocabulary mapped onto our error classes. Extracted so the purchase
   * and subscription lookups cannot drift in how they classify a 404/410.
   */
  async function playGet(url: string): Promise<GooglePurchaseFetchResult> {
    const accessToken = await opts.tokenProvider.getAccessToken(
      opts.tenantCacheKey,
      opts.credentials.serviceAccount,
    );

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
  }

  return {
    // `async` matters here: building the URL calls encodeURIComponent,
    // which throws synchronously on an unpaired surrogate. Without it the
    // declared Promise return type would lie and the throw would bypass
    // every caller's `await`-in-try.
    async getPurchase(args) {
      return await playGet(buildUrl(opts.credentials.packageName, args));
    },

    async getSubscription(args) {
      return await playGet(subscriptionUrl(opts.credentials.packageName, args.purchaseToken));
    },

    async listVoidedPurchases(args) {
      return await playGet(voidedPurchasesUrl(opts.credentials.packageName, args));
    },
  };
}

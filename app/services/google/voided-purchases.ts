/**
 * Google Play's Voided Purchases API — refunds, revocations and chargebacks.
 *
 * ### Why this exists
 *
 * `subscriptionsv2` has **no revoked state**. A subscription Google revoked
 * after a refund reports as `SUBSCRIPTION_STATE_EXPIRED`, indistinguishable
 * from one that simply lapsed. Webhook consumers get the difference from the
 * `subscription.refunded` event; a stateless consumer that uses no webhooks
 * had no way to ask at all. This closes that gap.
 *
 * ### The shape of the upstream API
 *
 * Google offers no "is this token voided?" endpoint. `voidedpurchases.list`
 * returns the whole **app's** voided purchases over a time window, paged,
 * and the lookback is capped at 30 days. So:
 *
 *   - `listGoogleVoidedPurchases` is a faithful page-at-a-time proxy, for
 *     callers that want to reconcile in bulk.
 *   - `findGoogleVoidedPurchase` answers the per-token question by paging
 *     that list, and is explicit when it had to stop early — a bounded scan
 *     that reported a bare `false` would be read as "not refunded", which is
 *     a different claim from "I did not find it".
 *
 * ### Permission
 *
 * The tenant's service account needs **"View financial data"** in Play
 * Console. Without it Google answers 401/403, which surfaces as
 * `GOOGLE_API_ERROR` rather than an empty list — deliberately, so a
 * misconfiguration can never read as "nothing was refunded".
 */

import {
  createGoogleHttpClient,
  GooglePurchaseNotFoundError,
  type GoogleVoidedPurchasesClient,
  mapGoogleApiError,
} from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleCredentialMaterial } from "@/services/google/types.ts";
import { asArray, asNumber, asRecord, asString } from "@/services/google/field-utils.ts";
import { toIsoOrNull } from "@/lib/iso-time.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

/**
 * How many pages `findGoogleVoidedPurchase` will walk before giving up.
 *
 * At Google's 1,000-per-page maximum this covers 50,000 voided purchases in
 * the 30-day window — far beyond a normal app. Beyond it the result is
 * marked `truncated` rather than silently negative.
 */
export const VOIDED_SCAN_MAX_PAGES = 50;

/**
 * Wall-clock budget for one scan, in milliseconds.
 *
 * The page cap alone is not a bound on time: 50 pages at the client's 10s
 * per-call timeout is ~500 seconds of a single request holding a
 * connection and a Play quota slot. One authenticated caller opening
 * enough of those would pin every connection on the machine while costing
 * one rate-limit token each. The budget is what actually bounds the cost;
 * hitting it reports `truncated` exactly as the page cap does.
 */
export const VOIDED_SCAN_BUDGET_MS = 25_000;

/** Page size requested while scanning for one token. */
const SCAN_PAGE_SIZE = 1_000;

/** One voided purchase, in Google's own vocabulary. */
export interface NormalizedVoidedPurchase {
  kind: string | null;
  purchaseToken: string | null;
  orderId: string | null;
  purchaseTime: string | null; // ISO-8601
  voidedTime: string | null; // ISO-8601
  /** Google's enum: 0 user, 1 developer, 2 Google. */
  voidedSource: number | null;
  /**
   * Google's enum: 0 other, 1 remorse, 2 not received, 3 defective,
   * 4 accidental purchase, 5 fraud, 6 friendly fraud, 7 chargeback,
   * 8 unauthorized parent purchase.
   */
  voidedReason: number | null;
}

export interface GoogleVoidedPurchasesDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  /** Tests inject a fake client to avoid real HTTPS. */
  clientFactory?: (
    material: GoogleCredentialMaterial,
    tenantCacheKey: string,
    tokenProvider: AccessTokenProvider,
  ) => GoogleVoidedPurchasesClient;
}

export interface ListVoidedPurchasesInput {
  tenantId: string;
  packageName: string;
  startTimeMillis?: string;
  endTimeMillis?: string;
  type?: 0 | 1;
  maxResults?: number;
  pageToken?: string;
}

export interface FindVoidedPurchaseInput {
  tenantId: string;
  packageName: string;
  purchaseToken: string;
  startTimeMillis?: string;
  endTimeMillis?: string;
}

export interface ListVoidedPurchasesResultValid {
  valid: true;
  voidedPurchases: NormalizedVoidedPurchase[];
  /** Pass back as `pageToken` for the next page; null on the last one. */
  nextPageToken: string | null;
  rawResponse: Record<string, unknown>;
}

export interface VoidedPurchasesResultInvalid {
  valid: false;
  error: "PACKAGE_NAME_MISMATCH";
  message: string;
}

export type ListVoidedPurchasesResult =
  | ListVoidedPurchasesResultValid
  | VoidedPurchasesResultInvalid;

export interface FindVoidedPurchaseResultValid {
  valid: true;
  voided: boolean;
  voidedPurchase: NormalizedVoidedPurchase | null;
  pagesScanned: number;
  /**
   * True when the scan stopped at `VOIDED_SCAN_MAX_PAGES` with pages left.
   * A `voided: false` alongside this is "not found in what I read", NOT
   * "not refunded" — treat it as inconclusive and narrow the window.
   */
  truncated: boolean;
}

export type FindVoidedPurchaseResult =
  | FindVoidedPurchaseResultValid
  | VoidedPurchasesResultInvalid;

function millisToIso(v: unknown): string | null {
  const raw = asString(v) ?? (typeof v === "number" ? String(v) : null);
  if (raw === null) return null;
  // `toIsoOrNull` also rejects values outside the ECMA-262 time range,
  // which `Number.isFinite` admits and `toISOString()` throws on. Upstream
  // data is untrusted: one malformed field must not 500 a whole page.
  return toIsoOrNull(Number(raw));
}

function normalizeVoidedPurchase(raw: Record<string, unknown>): NormalizedVoidedPurchase {
  return {
    kind: asString(raw.kind),
    purchaseToken: asString(raw.purchaseToken),
    orderId: asString(raw.orderId),
    purchaseTime: millisToIso(raw.purchaseTimeMillis),
    voidedTime: millisToIso(raw.voidedTimeMillis),
    voidedSource: asNumber(raw.voidedSource),
    voidedReason: asNumber(raw.voidedReason),
  };
}

function nextPageTokenOf(raw: Record<string, unknown>): string | null {
  return asString(asRecord(raw.tokenPagination)?.nextPageToken);
}

/**
 * Resolve credentials, check the package, and build a client — the prelude
 * both entry points share.
 */
async function prepare(
  deps: GoogleVoidedPurchasesDeps,
  tenantId: string,
  packageName: string,
): Promise<{ client: GoogleVoidedPurchasesClient } | VoidedPurchasesResultInvalid> {
  const material = await deps.credentialsLoader.load(tenantId);
  if (!material) {
    throw new AppError(
      ErrorCodes.CREDENTIALS_MISSING,
      "Google credentials are not configured for this tenant",
    );
  }
  if (material.packageName !== packageName) {
    return {
      valid: false,
      error: "PACKAGE_NAME_MISMATCH",
      message:
        `Tenant is configured for "${material.packageName}" but request was for "${packageName}"`,
    };
  }
  const client = deps.clientFactory
    ? deps.clientFactory(material, tenantId, deps.tokenProvider)
    : createGoogleHttpClient({
      credentials: material,
      tokenProvider: deps.tokenProvider,
      tenantCacheKey: tenantId,
    });
  return { client };
}

/** Map a Play fault onto Attesto's error vocabulary; never swallow one. */
function rethrow(err: unknown): never {
  // `playGet` turns any 404/410 into GooglePurchaseNotFoundError, which
  // `mapGoogleApiError` deliberately leaves alone — for the purchase
  // lookups a missing purchase is a domain outcome each caller names for
  // itself. There is no per-token lookup here, so a 404 means the APP is
  // not reachable for this service account. Letting it through produced an
  // unhandled 500 logged as "purchase token not found", on a call that
  // looked up no token.
  if (err instanceof GooglePurchaseNotFoundError) {
    throw new AppError(ErrorCodes.GOOGLE_API_ERROR, "Google API request failed", {
      details: { status: err.reason === "gone" ? 410 : 404 },
    });
  }
  const mapped = mapGoogleApiError(err);
  if (mapped) throw mapped;
  throw err;
}

/** One page of the app's voided purchases. */
export async function listGoogleVoidedPurchases(
  deps: GoogleVoidedPurchasesDeps,
  input: ListVoidedPurchasesInput,
): Promise<ListVoidedPurchasesResult> {
  const prepared = await prepare(deps, input.tenantId, input.packageName);
  if ("valid" in prepared) return prepared;

  try {
    const { raw } = await prepared.client.listVoidedPurchases({
      startTimeMillis: input.startTimeMillis,
      endTimeMillis: input.endTimeMillis,
      type: input.type,
      maxResults: input.maxResults,
      pageToken: input.pageToken,
    });
    return {
      valid: true,
      voidedPurchases: asArray(raw.voidedPurchases).map(normalizeVoidedPurchase),
      nextPageToken: nextPageTokenOf(raw),
      rawResponse: raw,
    };
  } catch (err) {
    rethrow(err);
  }
}

/** Was this specific purchase token voided within the window? */
export async function findGoogleVoidedPurchase(
  deps: GoogleVoidedPurchasesDeps,
  input: FindVoidedPurchaseInput,
  /** Clock seam, so the budget is testable without real waiting. */
  now: () => number = () => Date.now(),
): Promise<FindVoidedPurchaseResult> {
  const prepared = await prepare(deps, input.tenantId, input.packageName);
  if ("valid" in prepared) return prepared;

  let pageToken: string | undefined = undefined;
  let pagesScanned = 0;
  const deadline = now() + VOIDED_SCAN_BUDGET_MS;

  try {
    for (let page = 0; page < VOIDED_SCAN_MAX_PAGES; page++) {
      const { raw } = await prepared.client.listVoidedPurchases({
        startTimeMillis: input.startTimeMillis,
        endTimeMillis: input.endTimeMillis,
        maxResults: SCAN_PAGE_SIZE,
        pageToken,
      });
      pagesScanned++;

      const match = asArray(raw.voidedPurchases)
        .map(normalizeVoidedPurchase)
        .find((v) => v.purchaseToken === input.purchaseToken);
      if (match) {
        return { valid: true, voided: true, voidedPurchase: match, pagesScanned, truncated: false };
      }

      const next = nextPageTokenOf(raw);
      // A degenerate upstream handing back the same cursor would otherwise
      // cost the full page budget in identical round-trips.
      if (next !== null && next === pageToken) break;
      if (next === null) {
        // The list is exhausted, so "not voided" is a real answer.
        return {
          valid: true,
          voided: false,
          voidedPurchase: null,
          pagesScanned,
          truncated: false,
        };
      }
      pageToken = next;
      if (now() >= deadline) break;
    }
  } catch (err) {
    rethrow(err);
  }

  // Ran out of pages, time, or patience with a stuck cursor — in every
  // case there is list left unread, so the answer is not conclusive.
  return { valid: true, voided: false, voidedPurchase: null, pagesScanned, truncated: true };
}

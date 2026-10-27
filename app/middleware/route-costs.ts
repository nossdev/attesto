/**
 * Rate-limit cost per route.
 *
 * Lives in the transport layer rather than in a domain service: `app.ts`
 * configuring middleware should not have to import a Google service to
 * learn a price. The service still owns the number — the scan's cost is a
 * fact about its upstream fan-out — this module owns the path it applies
 * to.
 *
 * Keyed on the path the ROUTER matched (percent-decoded), which is what
 * `createRateLimiter` passes. Comparing against a raw URL would let an
 * encoded spelling of an expensive route be charged as a cheap one.
 */

import { VOIDED_SCAN_RATE_LIMIT_COST } from "@/services/google/voided-purchases.ts";

/** The scan route, as `routes/google.ts` registers it beneath `/v1`. */
export const VOIDED_SCAN_PATH = "/v1/google/purchase-voided";

/** Tokens a request to `path` costs. One, unless the route fans out. */
export function rateLimitCostForPath(path: string): number {
  return path === VOIDED_SCAN_PATH ? VOIDED_SCAN_RATE_LIMIT_COST : 1;
}

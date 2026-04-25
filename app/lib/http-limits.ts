/**
 * Shared HTTP request-size caps. Centralized so changing a limit doesn't
 * require touching every route that enforces it.
 */

/**
 * Verify endpoints (`/v1/apple/verify`, `/v1/google/verify`) accept small
 * JSON bodies — a transactionId / purchaseToken plus a few flags. 16KB is
 * generous for the legitimate payload and tight enough to reject abuse.
 */
export const VERIFY_MAX_BODY_BYTES = 16 * 1024;

/**
 * Webhook receivers cap at 1MB per PLAN.md §11 — Apple/Google payloads are
 * typically &lt;10KB but we leave headroom for future notification shapes.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

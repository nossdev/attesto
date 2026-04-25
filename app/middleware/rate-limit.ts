/**
 * Token-bucket rate limiter, keyed by the authenticated tenant.
 *
 * One bucket per tenant, in-memory. Refills at `refillPerSecond` tokens/s,
 * capped at `burst`. On depletion, throws `AppError(RATE_LIMITED)` — the
 * error middleware looks at `RATE_LIMITED` specifically and emits a
 * `Retry-After` header (see `app/middleware/error.ts`'s `headersForError`).
 *
 * This middleware MUST run AFTER the auth middleware — it reads `tenant.id`
 * from `c.get("auth")`. If auth isn't in context we fail closed (throw
 * INTERNAL_ERROR) so a route-tree reorganization that accidentally
 * bypasses auth is loud, not silent.
 *
 * Multi-instance note: buckets are per-process. An N-machine Fly deploy
 * effectively allows up to N× the configured rate per tenant. Until
 * Attesto scales horizontally enough for that to matter, set
 * `RATE_LIMIT_PER_SECOND` conservatively (fly.toml uses 60, anticipating
 * 2-3 machines at peak × ~50 rps effective). A Redis-backed counter is
 * the replacement when we need hard multi-instance enforcement.
 */

import type { MiddlewareHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

interface RateLimitOptions {
  /** Steady-state requests per second per tenant. */
  refillPerSecond: number;
  /** Burst capacity — bucket is capped at this many tokens. */
  burst: number;
  /** Override `now` for deterministic tests. Returns ms since epoch. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface RateLimiter {
  middleware: MiddlewareHandler<HonoEnv>;
  /** Exposed for tests — inspect current bucket state. */
  peek(tenantId: string): Bucket | undefined;
  /** Clear all buckets (tests). */
  reset(): void;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  function take(
    tenantId: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const nowMs = now();
    let bucket = buckets.get(tenantId);
    if (!bucket) {
      bucket = { tokens: opts.burst, lastRefillMs: nowMs };
      buckets.set(tenantId, bucket);
    } else {
      // Clamp elapsed at 0 — guards against NTP step-backs. When the clock
      // goes backwards we don't refill (and we don't move `lastRefillMs`
      // back either). The next valid tick resumes normally.
      const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
      if (elapsedSec > 0) {
        bucket.tokens = Math.min(opts.burst, bucket.tokens + elapsedSec * opts.refillPerSecond);
        bucket.lastRefillMs = nowMs;
      }
    }
    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      const retryAfterSeconds = Math.max(1, Math.ceil(deficit / opts.refillPerSecond));
      return { allowed: false, retryAfterSeconds };
    }
    bucket.tokens -= 1;
    return { allowed: true };
  }

  const middleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
    const auth = c.get("auth");
    if (!auth) {
      throw new AppError(
        ErrorCodes.INTERNAL_ERROR,
        "rate-limit middleware reached without auth context",
      );
    }
    const result = take(auth.tenant.id);
    if (!result.allowed) {
      // `retryAfterSeconds` in details drives the Retry-After header emitted
      // by the error middleware. We do NOT push headers through AppError
      // directly — doing so would create a CRLF-injection surface on every
      // future AppError site.
      throw new AppError(ErrorCodes.RATE_LIMITED, "Rate limit exceeded", {
        details: { retryAfterSeconds: result.retryAfterSeconds },
      });
    }
    await next();
  };

  return {
    middleware,
    peek: (id) => buckets.get(id),
    reset: () => buckets.clear(),
  };
}

/**
 * Plumbing shared by the four authenticated lookup endpoints
 * (`{apple,google}/{verify,subscription-status}`).
 *
 * Extracted because each handler needs the same three things — a size-capped
 * JSON body, schema validation, and an audit row recorded on success *and*
 * failure — and four hand-rolled copies drift. In particular the errorCode
 * precedence below is subtle: an AppError's code must win over the domain
 * `error`, or every upstream fault collapses to `errorCode: null` and
 * operators lose the signal.
 */

import type { Context } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { VERIFY_MAX_BODY_BYTES } from "@/lib/http-limits.ts";
import type { ValidationAuditRecorder } from "@/services/audit/validation-audit.ts";

/**
 * A client-supplied identifier that will be interpolated into an upstream
 * URL path.
 *
 * The well-formedness check is not cosmetic: `encodeURIComponent` throws
 * `URIError` on an unpaired surrogate, and these strings reach it inside
 * the Apple/Google clients. Without this the caller gets a 500 (plus a
 * stack trace in non-production logs) for what is plainly a bad request.
 */
export function purchaseReference(maxLength: number, opts: { trim?: boolean } = {}) {
  // `.trim()` must precede `.min()` to be meaningful. It is opt-in so each
  // endpoint keeps the semantics it shipped with: the Google fields have
  // always been trimmed, the Apple ones have not.
  const base = opts.trim ? z.string().trim() : z.string();
  return base
    .min(1)
    .max(maxLength)
    .refine((v) => v.isWellFormed(), "must not contain unpaired surrogates");
}

/**
 * Read and validate a request body, rejecting anything over the size cap
 * before it is parsed.
 */
export async function parseLookupBody<T>(
  c: Context<HonoEnv>,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentLength = c.req.header("content-length");
  if (contentLength && Number(contentLength) > VERIFY_MAX_BODY_BYTES) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Request body too large", {
      details: { maxBytes: VERIFY_MAX_BODY_BYTES },
    });
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid request body", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}

export interface AuditContext {
  /** Omitted unless the tenant has the validation audit log switched on. */
  recorder?: ValidationAuditRecorder;
  tenantId: string;
  source: "apple" | "google";
  /** Raw purchase reference — the recorder HMAC-hashes it before insert. */
  identifier: string;
}

type LookupOutcome = { valid: true } | { valid: false; error: string };

/**
 * Run a lookup and record one audit row for it, whether it returned a
 * domain outcome or threw. Re-throws whatever the lookup threw.
 */
export async function withAudit<T extends LookupOutcome>(
  ctx: AuditContext,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let result: T | undefined;
  let thrownError: unknown;
  try {
    result = await run();
    return result;
  } catch (err) {
    thrownError = err;
    throw err;
  } finally {
    if (ctx.recorder) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const errorCode = thrownError instanceof AppError
        ? thrownError.code
        : thrownError !== undefined
        ? ErrorCodes.INTERNAL_ERROR
        : result?.valid === false
        ? result.error
        : null;
      // `.catch` is load-bearing, not defensive dressing: `record` is a DI
      // seam typed `Promise<void>`, and the concrete recorder awaits an
      // HMAC *outside* its own try/catch. An unhandled rejection terminates
      // the Deno process, so one audit hiccup would become an outage for
      // every tenant. Audit is observability; it never fails a request.
      void ctx.recorder
        .record({
          tenantId: ctx.tenantId,
          source: ctx.source,
          identifier: ctx.identifier,
          valid: result?.valid === true,
          errorCode,
          latencyMs,
        })
        .catch((err: unknown) => {
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "validation_audit_record_failed",
            tenantId: ctx.tenantId,
            source: ctx.source,
            error: err instanceof Error ? err.message : String(err),
          }));
        });
    }
  }
}

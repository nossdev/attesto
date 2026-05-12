import type { ErrorHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { ATTESTO_VERSION_HEADER, VERSION } from "@/lib/version.ts";

export interface ErrorHandlerOptions {
  isProduction: boolean;
  /** Build version stamped on the `X-Attesto-Version` header of error
   * responses (which are built as raw Responses, so the shared response
   * middleware doesn't reach them). Defaults to {@link VERSION}. */
  version?: string;
}

function jsonResponse(
  body: unknown,
  status: number,
  version: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    [ATTESTO_VERSION_HEADER]: version,
    ...(extraHeaders ?? {}),
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Compute the narrow set of response headers we allow AppErrors to emit.
 * Hard-coded here rather than letting AppError sites push arbitrary headers
 * into the response — doing so creates a CRLF-injection surface every time
 * someone constructs an AppError from user input. If a new error code needs
 * a response header, add an explicit branch here.
 */
function headersForError(err: AppError): Record<string, string> | undefined {
  if (err.code === ErrorCodes.RATE_LIMITED) {
    const retryAfter = err.details?.retryAfterSeconds;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      return { "Retry-After": String(Math.ceil(retryAfter)) };
    }
  }
  return undefined;
}

function describeError(err: unknown, isProduction: boolean): {
  name: string;
  message: string;
  stack?: string;
} {
  if (!(err instanceof Error)) {
    return { name: "NonError", message: isProduction ? "(redacted)" : String(err) };
  }
  // In production we log only the error *class* (e.g. PostgresError) —
  // never the message or stack. Raw driver messages can carry connection
  // strings, stack-encoded SQL, decrypted payload fragments, or keyring
  // references that become a problem if server logs are shipped to a
  // third-party aggregator. For debugging, reproduce in staging where
  // full fidelity is available.
  if (isProduction) {
    return { name: err.name, message: "(redacted in production; see errorClass)" };
  }
  return { name: err.name, message: err.message, stack: err.stack };
}

export function createErrorHandler(opts: ErrorHandlerOptions): ErrorHandler<HonoEnv> {
  const version = opts.version ?? VERSION;
  return (err, c) => {
    if (err instanceof AppError) {
      return jsonResponse(err.toResponseBody(), err.status, version, headersForError(err));
    }

    const requestId = c.get("requestId");
    // Read from the canonical `tenantId` context key — populated by
    // both the auth middleware AND the inbound webhook routes. Falling
    // back to `auth?.tenant.id` here would miss webhook-route errors,
    // which is exactly the case where operators most need the tenantId
    // to triage (an Apple/Google webhook handler crashing for a known
    // tenant).
    const tenantId = c.get("tenantId");
    const described = describeError(err, opts.isProduction);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "unhandled_error",
        requestId,
        tenantId: tenantId ?? null,
        errorClass: described.name,
        error: described.message,
        stack: described.stack,
      }),
    );

    return jsonResponse(
      {
        valid: false,
        error: ErrorCodes.INTERNAL_ERROR,
        message: "An internal error occurred",
      },
      500,
      version,
    );
  };
}

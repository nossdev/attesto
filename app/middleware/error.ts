import type { ErrorHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

export interface ErrorHandlerOptions {
  isProduction: boolean;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
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
  return (err, c) => {
    if (err instanceof AppError) {
      return jsonResponse(err.toResponseBody(), err.status, headersForError(err));
    }

    const requestId = c.get("requestId");
    const auth = c.get("auth");
    const described = describeError(err, opts.isProduction);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "unhandled_error",
        requestId,
        tenantId: auth?.tenant.id ?? null,
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
    );
  };
}

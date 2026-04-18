import type { ErrorHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

export interface ErrorHandlerOptions {
  isProduction: boolean;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
      return jsonResponse(err.toResponseBody(), err.status);
    }

    const requestId = c.get("requestId");
    const described = describeError(err, opts.isProduction);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "unhandled_error",
        requestId,
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

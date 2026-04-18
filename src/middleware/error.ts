import type { ErrorHandler } from "@hono/hono";
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

export function createErrorHandler(opts: ErrorHandlerOptions): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) {
      return jsonResponse(err.toResponseBody(), err.status);
    }

    const requestId = c.get("requestId") as string | undefined;
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "unhandled_error",
        requestId,
        error: err instanceof Error ? err.message : String(err),
        stack: !opts.isProduction && err instanceof Error ? err.stack : undefined,
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

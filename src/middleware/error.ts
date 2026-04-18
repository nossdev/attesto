import type { ErrorHandler } from "@hono/hono";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return jsonResponse(err.toResponseBody(), err.status);
  }

  const requestId = c.get("requestId") as string | undefined;
  const isProd = (Deno.env.get("NODE_ENV") ?? "development") === "production";
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "unhandled_error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: !isProd && err instanceof Error ? err.stack : undefined,
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

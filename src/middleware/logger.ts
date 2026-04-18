import type { MiddlewareHandler } from "@hono/hono";

/**
 * Minimal structured access logger. Phase 6 will replace this with a proper
 * level-aware logger + redaction; for now we emit JSON lines to stdout.
 */
export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - start);
  const requestId = c.get("requestId") as string | undefined;

  const entry = {
    ts: new Date().toISOString(),
    level: "info",
    msg: "request",
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs,
    requestId,
  };
  console.log(JSON.stringify(entry));
};

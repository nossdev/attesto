import type { MiddlewareHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";

/**
 * Minimal structured access logger. Phase 6 will replace this with a proper
 * level-aware logger + redaction; for now we emit JSON lines to stdout.
 */
export const accessLog: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const start = performance.now();
  // try/finally guarantees we emit a request log even when downstream
  // middleware throws (e.g. auth 401, rate-limit 429). Without it Hono's
  // onError short-circuit skips the post-await branch entirely, blinding
  // operators to the most interesting failure cases.
  try {
    await next();
  } finally {
    const durationMs = Math.round(performance.now() - start);
    const requestId = c.get("requestId");
    // Canonical key — see `HonoEnv.Variables.tenantId` JSDoc for who sets it.
    const tenantId = c.get("tenantId");

    const entry = {
      ts: new Date().toISOString(),
      level: "info",
      msg: "request",
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs,
      requestId,
      tenantId: tenantId ?? null,
    };
    console.log(JSON.stringify(entry));
  }
};

import type { MiddlewareHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { ATTESTO_VERSION_HEADER, VERSION } from "@/lib/version.ts";

/**
 * Tags every response with `X-Attesto-Version: <build version>`.
 *
 * Set BEFORE `await next()` (mirrors the request-id middleware) so the header
 * is in the context's pending headers and merges onto whatever response comes
 * back — a handler's `c.json()`, a raw `new Response()` (the `/ready` route),
 * the built-in 404, or the error handler's response.
 *
 * Informational only — see `lib/version.ts`. Integrators must not branch on it.
 */
export function versionHeader(version: string = VERSION): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    c.header(ATTESTO_VERSION_HEADER, version);
    await next();
  };
}

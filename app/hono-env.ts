import type { AuthContext } from "@/middleware/auth.ts";

/**
 * Shared Hono env: the `Variables` typed map makes `c.get("auth")` and
 * `c.get("requestId")` strongly typed. All app factories + middleware use
 * `Hono<HonoEnv>` and `MiddlewareHandler<HonoEnv>`.
 *
 * `tenantId` is a separate, denormalized context key for cross-cutting
 * consumers (the access logger, future tracing). It's set by the auth
 * middleware (when an authenticated request resolves to a tenant) AND
 * by the inbound webhook routes (which derive tenantId from the URL
 * path, since Apple/Google don't carry an API key). Keeping it
 * distinct from `auth` decouples "I need to know which tenant" from
 * "I need the full auth context."
 */
export interface HonoEnv {
  Variables: {
    requestId: string;
    auth: AuthContext;
    tenantId: string | undefined;
  };
}

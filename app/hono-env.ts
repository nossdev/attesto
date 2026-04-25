import type { AuthContext } from "@/middleware/auth.ts";

/**
 * Shared Hono env: the `Variables` typed map makes `c.get("auth")` and
 * `c.get("requestId")` strongly typed. All app factories + middleware use
 * `Hono<HonoEnv>` and `MiddlewareHandler<HonoEnv>`.
 */
export interface HonoEnv {
  Variables: {
    requestId: string;
    auth: AuthContext;
  };
}

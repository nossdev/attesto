import type { Context, MiddlewareHandler } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import type { Database } from "@/db/client.ts";
import { findActiveKeyByHash, touchLastUsed } from "@/db/queries/api-keys.ts";
import { getTenantById } from "@/db/queries/tenants.ts";
import { hashApiKey } from "@/services/tenants/api-keys.ts";
import type { ApiKey, Tenant } from "@/db/schema.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

export interface AuthContext {
  tenant: Tenant;
  apiKey: ApiKey;
}

export interface AuthMiddlewareOptions {
  db: Database;
  /**
   * Update api_keys.last_used_at on every successful auth. Defaults to true.
   * Tests often disable this for determinism.
   */
  touchLastUsedAt?: boolean;
}

const BEARER = "Bearer ";

function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  if (!authorization.startsWith(BEARER)) return null;
  const raw = authorization.slice(BEARER.length).trim();
  return raw.length > 0 ? raw : null;
}

export function createAuthMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler<HonoEnv> {
  const touch = opts.touchLastUsedAt ?? true;

  return async (c, next) => {
    const raw = extractBearer(c.req.header("Authorization"));
    if (!raw) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, "Missing or malformed Authorization header");
    }

    const keyHash = await hashApiKey(raw);
    const apiKey = await findActiveKeyByHash(opts.db, keyHash);
    if (!apiKey) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, "Invalid or revoked API key");
    }

    const tenant = await getTenantById(opts.db, apiKey.tenantId);
    if (!tenant || !tenant.isActive) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, "Tenant not found or inactive");
    }

    c.set("auth", { tenant, apiKey });

    if (touch) {
      // Awaited: the update latches onto the request lifecycle, so errors
      // surface in logs and the pg client is guaranteed to flush before the
      // process can shut down mid-request. The update is scoped to active
      // keys (see touchLastUsed) so it can't stamp a concurrently-revoked row.
      try {
        await touchLastUsed(opts.db, apiKey.id);
      } catch (err) {
        // Don't fail the request for an audit-signal write — but log so
        // consistent failures are visible in ops.
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "auth:touch_last_used_failed",
            tenantId: apiKey.tenantId,
            keyId: apiKey.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    await next();
  };
}

export function requireAuth(c: Context<HonoEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, "requireAuth called without auth middleware");
  }
  return auth;
}

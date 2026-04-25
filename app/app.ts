import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { requestId } from "@/middleware/request-id.ts";
import { accessLog } from "@/middleware/logger.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createHealthRoutes, type HealthDeps } from "@/routes/health.ts";
import { type AppleRouteDeps, createAppleRoutes } from "@/routes/apple.ts";
import { createGoogleRoutes, type GoogleRouteDeps } from "@/routes/google.ts";
import { createWebhookRoutes, type WebhookRouteDeps } from "@/routes/webhooks.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createRateLimiter } from "@/middleware/rate-limit.ts";
import type { Database } from "@/db/client.ts";

export interface CreateAppOptions extends HealthDeps {
  isProduction?: boolean;
  /**
   * When supplied, mounts the `/v1/*` authenticated verification routes.
   * Omit for the health-only bootstrap path (tests that don't need auth).
   */
  authenticated?: {
    db: Database;
    apple?: AppleRouteDeps;
    google?: GoogleRouteDeps;
    /**
     * If provided, mounts a token-bucket rate limiter on the authenticated
     * verify routes. Buckets are per-tenant, in-memory, per-process.
     */
    rateLimit?: {
      refillPerSecond: number;
      burst: number;
    };
  };
  /**
   * Inbound webhooks from Apple/Google. Mounted OUTSIDE the API-key auth
   * middleware — Apple/Google don't send an API key. Origin authentication
   * is cryptographic: JWS signature verification (Apple, via
   * `@apple/app-store-server-library`) or OIDC JWT (Google Pub/Sub push,
   * via Google JWKS).
   */
  webhooks?: WebhookRouteDeps;
}

export function createApp(opts: CreateAppOptions = {}) {
  const app = new Hono<HonoEnv>();

  app.use("*", requestId);
  app.use("*", accessLog);
  app.onError(createErrorHandler({ isProduction: opts.isProduction ?? false }));

  app.route("/", createHealthRoutes(opts));

  if (opts.authenticated) {
    const authed = new Hono<HonoEnv>();
    authed.use("*", createAuthMiddleware({ db: opts.authenticated.db }));
    if (opts.authenticated.rateLimit) {
      const limiter = createRateLimiter({
        refillPerSecond: opts.authenticated.rateLimit.refillPerSecond,
        burst: opts.authenticated.rateLimit.burst,
      });
      authed.use("*", limiter.middleware);
    }
    if (opts.authenticated.apple) {
      authed.route("/", createAppleRoutes(opts.authenticated.apple));
    }
    if (opts.authenticated.google) {
      authed.route("/", createGoogleRoutes(opts.authenticated.google));
    }
    app.route("/", authed);
  }

  if (opts.webhooks) {
    app.route("/", createWebhookRoutes(opts.webhooks));
  }

  return app;
}

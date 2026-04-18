import { Hono } from "@hono/hono";
import { requestId } from "@/middleware/request-id.ts";
import { accessLog } from "@/middleware/logger.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createHealthRoutes, type HealthDeps } from "@/routes/health.ts";

export interface CreateAppOptions extends HealthDeps {
  isProduction?: boolean;
}

export function createApp(opts: CreateAppOptions = {}) {
  const app = new Hono();

  app.use("*", requestId);
  app.use("*", accessLog);
  app.onError(createErrorHandler({ isProduction: opts.isProduction ?? false }));

  app.route("/", createHealthRoutes(opts));

  return app;
}

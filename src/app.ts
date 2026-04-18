import { Hono } from "@hono/hono";
import { requestId } from "@/middleware/request-id.ts";
import { accessLog } from "@/middleware/logger.ts";
import { errorHandler } from "@/middleware/error.ts";
import { createHealthRoutes, type HealthDeps } from "@/routes/health.ts";

export type AppDeps = HealthDeps;

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();

  app.use("*", requestId);
  app.use("*", accessLog);
  app.onError(errorHandler);

  app.route("/", createHealthRoutes(deps));

  return app;
}

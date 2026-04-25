import { Hono } from "@hono/hono";
import type { DbHandle } from "@/db/client.ts";

export interface HealthDeps {
  db?: DbHandle;
  decryptionKeyOk?: () => boolean;
}

export function createHealthRoutes(deps: HealthDeps = {}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (_c) => {
    const checks: Record<string, "ok" | "fail"> = {};

    if (deps.db) {
      try {
        await deps.db.sql`SELECT 1`;
        checks.db = "ok";
      } catch {
        checks.db = "fail";
      }
    }

    if (deps.decryptionKeyOk) {
      checks.encryption = deps.decryptionKeyOk() ? "ok" : "fail";
    }

    const checkValues = Object.values(checks);
    const allOk = checkValues.length > 0 && checkValues.every((v) => v === "ok");
    const body = JSON.stringify({ status: allOk ? "ok" : "degraded", checks });
    return new Response(body, {
      status: allOk ? 200 : 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  });

  return app;
}

import { Hono } from "@hono/hono";
import type { DbHandle } from "@/db/client.ts";
import { VERSION } from "@/lib/version.ts";

export interface HealthDeps {
  db?: DbHandle;
  decryptionKeyOk?: () => boolean;
  /**
   * Build version reported in the `/health` and `/ready` bodies (the
   * `X-Attesto-Version` header is set independently by the version
   * middleware). Defaults to {@link VERSION} (`"dev"` for un-tagged builds).
   */
  version?: string;
}

export function createHealthRoutes(deps: HealthDeps = {}) {
  const app = new Hono();
  const version = deps.version ?? VERSION;

  app.get("/health", (c) => c.json({ status: "ok", version }));

  app.get("/ready", async (c) => {
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
    // c.json (not a raw Response) so the shared response middleware — request-id,
    // X-Attesto-Version — actually lands on this body too.
    return c.json({ status: allOk ? "ok" : "degraded", version, checks }, allOk ? 200 : 503);
  });

  return app;
}

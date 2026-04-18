import { assertEquals } from "@std/assert";
import { createDb } from "@/db/client.ts";
import { createApp } from "@/app.ts";
import { runMigrations } from "@/db/migrate.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const skip = !DATABASE_URL;
const reason = skip
  ? "skipping integration test: DATABASE_URL not set (run `mise run db:up` then re-run tests)"
  : "";

Deno.test({
  name: "integration: createDb can run SELECT 1 against real Postgres",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    const handle = createDb(DATABASE_URL!);
    try {
      const rows = await handle.sql`SELECT 1 AS one`;
      assertEquals(rows[0]?.one, 1);
    } finally {
      await handle.close();
    }
  },
});

Deno.test({
  name: "integration: /ready returns 200 with db:ok when Postgres reachable",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    const handle = createDb(DATABASE_URL!);
    try {
      const app = createApp({ db: handle, decryptionKeyOk: () => true });
      const res = await app.request("/ready");
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "ok");
      assertEquals(body.checks.db, "ok");
      assertEquals(body.checks.encryption, "ok");
    } finally {
      await handle.close();
    }
  },
});

Deno.test({
  name: "integration: /ready reports db:fail when DB unreachable",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    // Point at a port that is guaranteed not to have Postgres.
    const handle = createDb("postgres://attesto:attesto@127.0.0.1:1/attesto");
    try {
      const app = createApp({ db: handle, decryptionKeyOk: () => true });
      const res = await app.request("/ready");
      assertEquals(res.status, 503);
      const body = await res.json();
      assertEquals(body.checks.db, "fail");
    } finally {
      await handle.close();
    }
  },
});

Deno.test({
  name: "integration: runMigrations skips cleanly when no migrations present",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    // Phase 1 ships with no .sql files (only .gitkeep); runMigrations should
    // log a skip and return rather than throwing Drizzle's missing-journal
    // error. This proves the docker-compose migrate sidecar won't block
    // attesto startup in a fresh deployment before Phase 2 generates schema.
    await runMigrations(DATABASE_URL!);

    // Confirm no tracking schema was created (since migrate was skipped).
    const handle = createDb(DATABASE_URL!);
    try {
      const rows = await handle.sql`
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
      `;
      assertEquals(rows.length, 0, "drizzle schema should not exist when skipped");
    } finally {
      await handle.close();
    }
  },
});

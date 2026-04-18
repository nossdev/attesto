import { assertEquals } from "@std/assert";
import { createDb } from "@/db/client.ts";
import { createApp } from "@/app.ts";
import { DATABASE_URL, ensureMigrated, shouldSkipIntegration } from "./_helpers.ts";

const skip = shouldSkipIntegration;
const reason = "DATABASE_URL not set — run `mise run db:up` then re-run tests";

Deno.test({
  name: "integration: createDb can run SELECT 1 against real Postgres",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    await ensureMigrated();
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
    await ensureMigrated();
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
  name: "integration: migrations created tenants and api_keys tables",
  ignore: skip,
  async fn() {
    if (skip) throw new Error(reason);
    await ensureMigrated();
    const handle = createDb(DATABASE_URL!);
    try {
      const rows = await handle.sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('tenants', 'api_keys')
        ORDER BY table_name
      `;
      assertEquals(rows.map((r) => r.table_name), ["api_keys", "tenants"]);
    } finally {
      await handle.close();
    }
  },
});

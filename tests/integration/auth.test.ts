import { assert, assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import type { DbHandle } from "@/db/client.ts";
import { createTenant, deactivateTenant } from "@/db/queries/tenants.ts";
import { insertApiKey, revokeApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { apiKeys } from "@/db/schema.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

function buildAuthedApp(handle: DbHandle, touchLastUsedAt = false): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", createAuthMiddleware({ db: handle.db, touchLastUsedAt }));
  app.get("/whoami", (c) => {
    const auth = c.get("auth");
    return c.json({ tenantId: auth.tenant.id, keyId: auth.apiKey.id });
  });
  return app;
}

Deno.test({
  name: "auth: valid key authenticates and attaches tenant to context",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const key = await generateApiKey("test");
      const stored = await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });

      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami", {
        headers: { Authorization: `Bearer ${key.raw}` },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body, { tenantId: tenant.id, keyId: stored.id });
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: missing Authorization header → 401 UNAUTHENTICATED",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami");
      assertEquals(res.status, 401);
      const body = await res.json();
      assertEquals(body.error, "UNAUTHENTICATED");
      assertEquals(body.valid, false);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: malformed Authorization header (no Bearer prefix) → 401",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami", {
        headers: { Authorization: "Basic abc" },
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: Bearer with empty token → 401",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami", {
        headers: { Authorization: "Bearer " },
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: unknown key → 401",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami", {
        headers: { Authorization: "Bearer attesto_test_deadbeef" },
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: revoked key → 401",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const key = await generateApiKey("test");
      const stored = await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });
      const revoked = await revokeApiKey(handle.db, stored.id);
      if (!revoked) throw new Error("revokeApiKey returned null for just-inserted key");

      const app = buildAuthedApp(handle);
      const res = await app.request("/whoami", {
        headers: { Authorization: `Bearer ${key.raw}` },
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: inactive tenant → 401 even if key is valid",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Paused Corp" });
      const key = await generateApiKey("test");
      const inserted = await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });
      const deactivated = await deactivateTenant(handle.db, tenant.id);
      assertEquals(deactivated, true);

      // touchLastUsedAt is ON so we can also assert the side-effect is skipped.
      const app = buildAuthedApp(handle, true);
      const res = await app.request("/whoami", {
        headers: { Authorization: `Bearer ${key.raw}` },
      });
      assertEquals(res.status, 401);

      // Auth failed before touch — lastUsedAt must remain null.
      const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.id, inserted.id));
      assertEquals(row?.lastUsedAt, null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: duplicate key_hash insert is rejected by partial unique index",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const key = await generateApiKey("test");
      await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });
      let threw = false;
      try {
        await insertApiKey(handle.db, {
          tenantId: tenant.id,
          keyHash: key.hash,
          keyPrefix: key.keyPrefix,
        });
      } catch {
        threw = true;
      }
      assertEquals(threw, true, "expected unique-index violation on duplicate active hash");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: touchLastUsed=true stamps last_used_at on success",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const key = await generateApiKey("test");
      const stored = await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });

      const app = buildAuthedApp(handle, true);
      const res = await app.request("/whoami", {
        headers: { Authorization: `Bearer ${key.raw}` },
      });
      assertEquals(res.status, 200);

      const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.id, stored.id));
      assert(row?.lastUsedAt !== null);
      // The timestamp should be within the last few seconds.
      const drift = Date.now() - (row?.lastUsedAt?.getTime() ?? 0);
      assert(drift >= 0 && drift < 5000, `expected recent lastUsedAt, drift=${drift}ms`);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "auth: touchLastUsed race-safe — revoking after lookup does NOT stamp",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const key = await generateApiKey("test");
      const stored = await insertApiKey(handle.db, {
        tenantId: tenant.id,
        keyHash: key.hash,
        keyPrefix: key.keyPrefix,
      });
      // Revoke first so that even though findActiveKeyByHash would (in a race)
      // have returned a row, the touch query's `isNull(revoked_at)` guard
      // prevents stamping. We simulate the race by calling touchLastUsed
      // directly after revocation.
      await revokeApiKey(handle.db, stored.id);
      const { touchLastUsed } = await import("@/db/queries/api-keys.ts");
      await touchLastUsed(handle.db, stored.id);

      const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.id, stored.id));
      assertEquals(row?.lastUsedAt, null);
    } finally {
      await teardown();
    }
  },
});

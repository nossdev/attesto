import { assert, assertEquals } from "@std/assert";
import { count, eq, sql } from "drizzle-orm";
import { purgeTenantData } from "@/db/queries/tenant-purge.ts";
import { createTenant, getTenantById } from "@/db/queries/tenants.ts";
import { insertApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { upsertAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { upsertGoogleCredentials } from "@/db/queries/google-credentials.ts";
import {
  enqueueWebhookDelivery,
  insertWebhookEventIdempotent,
  upsertWebhookConfig,
} from "@/db/queries/webhooks.ts";
import { recordChainLink } from "@/services/webhooks/google-chain.ts";
import {
  apiKeys,
  appleCredentials,
  googleCredentials,
  googlePurchaseChains,
  validationAudit,
  webhookConfigs,
  webhookDeliveries,
  webhookEvents,
} from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";
import type { DbHandle } from "@/db/client.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

const ENC = new Uint8Array(16).fill(3);

/** Give a tenant one row in every table that references it. */
async function seedEverything(handle: DbHandle, name: string): Promise<string> {
  const tenant = await createTenant(handle.db, { name });
  const key = await generateApiKey("test");
  await insertApiKey(handle.db, {
    tenantId: tenant.id,
    keyHash: key.hash,
    keyPrefix: key.keyPrefix,
  });
  await upsertAppleCredentials(handle.db, {
    tenantId: tenant.id,
    bundleId: "com.example.app",
    keyId: "ABC1234567",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    privateKeyEnc: ENC,
    environment: "sandbox",
    appAppleId: null,
  });
  await upsertGoogleCredentials(handle.db, {
    tenantId: tenant.id,
    packageName: "com.example.app",
    serviceAccountEnc: ENC,
  });
  await upsertWebhookConfig(handle.db, {
    tenantId: tenant.id,
    callbackUrl: "https://example.test/hook",
    secretEnc: ENC,
  });
  const { event } = await insertWebhookEventIdempotent(handle.db, {
    tenantId: tenant.id,
    source: "apple",
    externalId: `evt-${name}`,
    eventType: "subscription.renewed",
    rawPayload: { signedPayload: "x" },
    decodedPayload: { notificationType: "DID_RENEW" },
  });
  await enqueueWebhookDelivery(handle.db, {
    eventId: event.id,
    tenantId: tenant.id,
    callbackUrl: "https://example.test/hook",
  });
  await recordChainLink(handle.db, {
    tenantId: tenant.id,
    currentToken: `cur-${name}`,
    previousToken: `prev-${name}`,
  });
  await handle.db.insert(validationAudit).values({
    id: makeId.audit(),
    tenantId: tenant.id,
    source: "apple",
    identifierHash: `hash-${name}`,
    valid: true,
    latencyMs: 10,
  });
  return tenant.id;
}

async function countFor(
  handle: DbHandle,
  // deno-lint-ignore no-explicit-any
  table: any,
  // deno-lint-ignore no-explicit-any
  tenantColumn: any,
  tenantId: string,
): Promise<number> {
  const rows = await handle.db
    .select({ n: count() })
    .from(table)
    .where(eq(tenantColumn, tenantId));
  return Number(rows[0]?.n ?? 0);
}

/** Every per-tenant row that exists anywhere, for one tenant. */
async function totalRowsFor(handle: DbHandle, tenantId: string): Promise<number> {
  const counts = await Promise.all([
    countFor(handle, apiKeys, apiKeys.tenantId, tenantId),
    countFor(handle, appleCredentials, appleCredentials.tenantId, tenantId),
    countFor(handle, googleCredentials, googleCredentials.tenantId, tenantId),
    countFor(handle, webhookConfigs, webhookConfigs.tenantId, tenantId),
    countFor(handle, webhookEvents, webhookEvents.tenantId, tenantId),
    countFor(handle, webhookDeliveries, webhookDeliveries.tenantId, tenantId),
    countFor(handle, googlePurchaseChains, googlePurchaseChains.tenantId, tenantId),
    countFor(handle, validationAudit, validationAudit.tenantId, tenantId),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

Deno.test({
  name: "tenant purge: a dry run reports every table and deletes nothing",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await seedEverything(handle, "Dry");

      const counts = await purgeTenantData(handle.db, tenantId, { dryRun: true });

      assertEquals(counts.apiKeys, 1);
      assertEquals(counts.appleCredentials, 1);
      assertEquals(counts.googleCredentials, 1);
      assertEquals(counts.webhookConfigs, 1);
      assertEquals(counts.webhookEvents, 1);
      assertEquals(counts.webhookDeliveries, 1);
      assertEquals(counts.googlePurchaseChains, 1);
      assertEquals(counts.validationAudit, 1);
      assertEquals(counts.tenant, 1);

      assertEquals(await totalRowsFor(handle, tenantId), 8);
      assert(await getTenantById(handle.db, tenantId) !== null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "tenant purge: removes every row for the tenant, including validation_audit",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await seedEverything(handle, "Gone");

      const counts = await purgeTenantData(handle.db, tenantId);

      assertEquals(counts.validationAudit, 1);
      assertEquals(counts.tenant, 1);
      // validation_audit has no foreign key to tenants, so nothing cascades
      // to it — a purge that only deleted the tenant row would leave this
      // tenant's identifier HMACs behind forever.
      assertEquals(await totalRowsFor(handle, tenantId), 0);
      assertEquals(await getTenantById(handle.db, tenantId), null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "tenant purge: leaves every other tenant's data untouched",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const doomed = await seedEverything(handle, "Doomed");
      const keeper = await seedEverything(handle, "Keeper");

      await purgeTenantData(handle.db, doomed);

      assertEquals(await totalRowsFor(handle, doomed), 0);
      assertEquals(await totalRowsFor(handle, keeper), 8);
      assert(await getTenantById(handle.db, keeper) !== null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "tenant purge: an unknown tenant reports nothing rather than failing",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const counts = await purgeTenantData(handle.db, "tenant_01ARZ3NDEKTSV4RRFFQ69G5FAV");

      assertEquals(counts.tenant, 0);
      assertEquals(counts.validationAudit, 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "tenant purge: audit rows of a tenant whose row is already gone are still removed",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      // The realistic shape of the gap: someone deleted the tenant row by
      // hand, and the audit rows outlived it because nothing cascades.
      const tenantId = await seedEverything(handle, "Orphan");
      await handle.db.delete(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
      await handle.db.delete(webhookEvents).where(eq(webhookEvents.tenantId, tenantId));
      await handle.db.delete(googlePurchaseChains).where(
        eq(googlePurchaseChains.tenantId, tenantId),
      );
      await handle.db.delete(webhookConfigs).where(eq(webhookConfigs.tenantId, tenantId));
      await handle.db.delete(appleCredentials).where(eq(appleCredentials.tenantId, tenantId));
      await handle.db.delete(googleCredentials).where(eq(googleCredentials.tenantId, tenantId));
      await handle.db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));
      const { tenants } = await import("@/db/schema.ts");
      await handle.db.delete(tenants).where(eq(tenants.id, tenantId));

      const counts = await purgeTenantData(handle.db, tenantId);

      assertEquals(counts.tenant, 0);
      assertEquals(counts.validationAudit, 1);
      assertEquals(await countFor(handle, validationAudit, validationAudit.tenantId, tenantId), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "tenant purge: every table with a tenant_id is either cascaded or purged explicitly",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      // The failure this guards against is exactly how validation_audit
      // became a problem: a table grows a `tenant_id` with no foreign key,
      // the purge is not updated, and nothing fails — the rows just stay.
      // Asking the database rather than a hand-kept list means the next
      // such table breaks this test instead of leaking quietly.
      const tables = await handle.db.execute(sql`
        select c.table_name
        from information_schema.columns c
        where c.table_schema = 'public'
          and c.column_name = 'tenant_id'
        order by c.table_name
      `) as unknown as Array<{ table_name: string }>;

      const cascading = await handle.db.execute(sql`
        select distinct cl.relname as table_name
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_class ref on ref.oid = con.confrelid
        where con.contype = 'f'
          and ref.relname = 'tenants'
          and con.confdeltype = 'c'
      `) as unknown as Array<{ table_name: string }>;

      const cascaded = new Set(cascading.map((r) => r.table_name));
      // Tables the purge deletes explicitly because nothing cascades to them.
      const explicit = new Set(["validation_audit"]);

      const orphans = tables
        .map((r) => r.table_name)
        .filter((t) => !cascaded.has(t) && !explicit.has(t));

      assertEquals(
        orphans,
        [],
        `these tables carry tenant_id but are neither cascaded from tenants nor purged ` +
          `explicitly — add them to purgeTenantData and to this test's \`explicit\` set: ` +
          orphans.join(", "),
      );
      // Sanity: the query found the tables at all.
      assert(tables.length >= 8, `expected the tenant-scoped tables, saw ${tables.length}`);
      assert(!cascaded.has("validation_audit"), "validation_audit must have no cascade");
    } finally {
      await teardown();
    }
  },
});

import { assertEquals } from "@std/assert";
import { count, eq } from "drizzle-orm";
import { purgeOnce, type RetentionPolicy } from "@/services/retention/purge.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import {
  googlePurchaseChains,
  validationAudit,
  webhookDeliveries,
  webhookEvents,
} from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";
import type { DbHandle } from "@/db/client.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

const NO_PURGE: RetentionPolicy = {
  webhookEventDays: null,
  validationAuditDays: null,
  googleChainDays: null,
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function seedEvent(
  handle: DbHandle,
  tenantId: string,
  externalId: string,
  receivedAt: Date,
): Promise<string> {
  const id = makeId.event();
  await handle.db.insert(webhookEvents).values({
    id,
    tenantId,
    source: "apple",
    externalId,
    eventType: "subscription.renewed",
    rawPayload: { signedPayload: "x" },
    decodedPayload: { notificationType: "DID_RENEW" },
    receivedAt,
  });
  await handle.db.insert(webhookDeliveries).values({
    id: makeId.delivery(),
    eventId: id,
    tenantId,
    callbackUrl: "https://example.test/hook",
    createdAt: receivedAt,
  });
  return id;
}

async function rowCount(
  handle: DbHandle,
  // deno-lint-ignore no-explicit-any
  table: any,
): Promise<number> {
  const rows = await handle.db.select({ n: count() }).from(table);
  return Number(rows[0]?.n ?? 0);
}

Deno.test({
  name: "purge: removes webhook events past the retention window, with their deliveries",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await seedEvent(handle, tenant.id, "old", daysAgo(120));
      const fresh = await seedEvent(handle, tenant.id, "fresh", daysAgo(3));

      const result = await purgeOnce(handle.db, { ...NO_PURGE, webhookEventDays: 90 });

      assertEquals(result.webhookEvents, 1);
      assertEquals(result.webhookDeliveries, 1);
      assertEquals(await rowCount(handle, webhookEvents), 1);
      assertEquals(await rowCount(handle, webhookDeliveries), 1);
      const left = await handle.db
        .select({ id: webhookEvents.id })
        .from(webhookEvents);
      assertEquals(left[0]?.id, fresh);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: a null retention leaves a table alone entirely",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await seedEvent(handle, tenant.id, "ancient", daysAgo(4000));

      const result = await purgeOnce(handle.db, NO_PURGE);

      assertEquals(result.webhookEvents, 0);
      assertEquals(await rowCount(handle, webhookEvents), 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: removes validation_audit rows past the retention window",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      for (const [age, hash] of [[60, "old"], [2, "new"]] as const) {
        await handle.db.insert(validationAudit).values({
          id: makeId.audit(),
          tenantId: tenant.id,
          source: "apple",
          identifierHash: hash,
          valid: true,
          latencyMs: 10,
          createdAt: daysAgo(age),
        });
      }

      const result = await purgeOnce(handle.db, { ...NO_PURGE, validationAuditDays: 30 });

      assertEquals(result.validationAudit, 1);
      const left = await handle.db
        .select({ h: validationAudit.identifierHash })
        .from(validationAudit);
      assertEquals(left.map((r) => r.h), ["new"]);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: removes google purchase-chain links past the retention window",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await handle.db.insert(googlePurchaseChains).values([
        {
          tenantId: tenant.id,
          currentToken: "new-token",
          previousToken: "older-token",
          createdAt: daysAgo(5),
        },
        {
          tenantId: tenant.id,
          currentToken: "stale-token",
          previousToken: "ancient-token",
          createdAt: daysAgo(400),
        },
      ]);

      const result = await purgeOnce(handle.db, { ...NO_PURGE, googleChainDays: 365 });

      assertEquals(result.googlePurchaseChains, 1);
      const left = await handle.db
        .select({ t: googlePurchaseChains.currentToken })
        .from(googlePurchaseChains);
      assertEquals(left.map((r) => r.t), ["new-token"]);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: a window that covers nothing deletes nothing",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await seedEvent(handle, tenant.id, "recent", daysAgo(1));

      const result = await purgeOnce(handle.db, { ...NO_PURGE, webhookEventDays: 90 });

      assertEquals(result.webhookEvents, 0);
      assertEquals(await rowCount(handle, webhookEvents), 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: every table can be swept in one pass",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await seedEvent(handle, tenant.id, "old", daysAgo(120));
      await handle.db.insert(validationAudit).values({
        id: makeId.audit(),
        tenantId: tenant.id,
        source: "google",
        identifierHash: "old",
        valid: false,
        latencyMs: 5,
        createdAt: daysAgo(60),
      });
      await handle.db.insert(googlePurchaseChains).values({
        tenantId: tenant.id,
        currentToken: "stale",
        previousToken: "older",
        createdAt: daysAgo(400),
      });

      const result = await purgeOnce(handle.db, {
        webhookEventDays: 90,
        validationAuditDays: 30,
        googleChainDays: 365,
      });

      assertEquals(result.webhookEvents, 1);
      assertEquals(result.webhookDeliveries, 1);
      assertEquals(result.validationAudit, 1);
      assertEquals(result.googlePurchaseChains, 1);
      assertEquals(await rowCount(handle, webhookEvents), 0);
      assertEquals(await rowCount(handle, validationAudit), 0);
      assertEquals(await rowCount(handle, googlePurchaseChains), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: deliveries go before events, so the foreign key never blocks the sweep",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Several deliveries hanging off one old event — the FK would reject
      // deleting the event first.
      const eventId = await seedEvent(handle, tenant.id, "multi", daysAgo(200));
      for (let i = 0; i < 3; i++) {
        await handle.db.insert(webhookDeliveries).values({
          id: makeId.delivery(),
          eventId,
          tenantId: tenant.id,
          callbackUrl: "https://example.test/hook",
          createdAt: daysAgo(200),
        });
      }

      const result = await purgeOnce(handle.db, { ...NO_PURGE, webhookEventDays: 30 });

      assertEquals(result.webhookEvents, 1);
      assertEquals(result.webhookDeliveries, 4);
      assertEquals(await rowCount(handle, webhookDeliveries), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "purge: a delivery still pending for a retained event survives",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const keep = await seedEvent(handle, tenant.id, "keep", daysAgo(1));
      await seedEvent(handle, tenant.id, "drop", daysAgo(200));

      await purgeOnce(handle.db, { ...NO_PURGE, webhookEventDays: 30 });

      const left = await handle.db
        .select({ eventId: webhookDeliveries.eventId })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, keep));
      assertEquals(left.length, 1);
    } finally {
      await teardown();
    }
  },
});

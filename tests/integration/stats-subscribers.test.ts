import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import { insertWebhookEventIdempotent } from "@/db/queries/webhooks.ts";
import { getSubscriberStats } from "@/db/queries/stats.ts";
import { webhookEvents } from "@/db/schema.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

// Integration-level tests for the stats query layer. They need a real
// Postgres (schema + indexes), gated on DATABASE_URL like the rest of
// tests/integration/. Live here rather than tests/unit/ because the
// fixture is `freshDb`, not a mock.

const NOW = new Date("2026-05-08T12:00:00.000Z");
const nowFn = () => NOW;
// Trailing-30-days for "month" → 2026-04-08T12:00:00Z
const MONTH_START = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

async function createSampleTenant(handle: DbHandle, name: string): Promise<string> {
  const t = await createTenant(handle.db, { name });
  return t.id;
}

interface SeedEventInput {
  tenantId: string;
  source?: "apple" | "google";
  externalId: string;
  eventType: string;
  subjectKey?: string | null;
  receivedAt?: Date;
}

async function seedEvent(handle: DbHandle, input: SeedEventInput): Promise<void> {
  // `??` would coerce explicit-null to the default; we want null to flow
  // through so tests can exercise the IS NOT NULL filter in the query.
  const subjectKey = input.subjectKey === undefined ? "txn-default" : input.subjectKey;
  await insertWebhookEventIdempotent(handle.db, {
    tenantId: input.tenantId,
    source: input.source ?? "apple",
    externalId: input.externalId,
    eventType: input.eventType,
    subjectKey,
    rawPayload: {},
    decodedPayload: {},
  });
  // insertWebhookEventIdempotent uses defaultNow() for received_at. To pin
  // events to specific times for boundary testing, override post-insert.
  if (input.receivedAt) {
    await handle.db
      .update(webhookEvents)
      .set({ receivedAt: input.receivedAt })
      .where(eq(webhookEvents.externalId, input.externalId));
  }
}

Deno.test({
  name: "getSubscriberStats: empty table → all zeros",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Empty");
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      assertEquals(stats.newInPeriod, 0);
      assertEquals(stats.activeInPeriod, 0);
      assertEquals(stats.lifetime, 0);
      assertEquals(stats.periodEnd.toISOString(), NOW.toISOString());
      assertEquals(stats.periodStart.toISOString(), MONTH_START.toISOString());
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: same subject_key repeated counts once (DISTINCT)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Dup");
      // Three purchase events, same subject — represents the user's app
      // re-verifying / Apple resending the same notification.
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-1",
        eventType: "subscription.purchased",
        subjectKey: "txn-A",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-2",
        eventType: "subscription.purchased",
        subjectKey: "txn-A",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-3",
        eventType: "subscription.purchased",
        subjectKey: "txn-A",
      });
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      assertEquals(stats.newInPeriod, 1);
      assertEquals(stats.activeInPeriod, 1);
      assertEquals(stats.lifetime, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: subject_key NULL is excluded",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Null");
      // One real purchase with a subject_key, plus a "test" event with null
      // subject (TEST notifications, refunds — see normalize.ts).
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-real",
        eventType: "subscription.purchased",
        subjectKey: "txn-A",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-test",
        eventType: "subscription.purchased",
        subjectKey: null,
      });
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      assertEquals(stats.newInPeriod, 1);
      assertEquals(stats.lifetime, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: period boundary — row at periodStart included; row before excluded",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Boundary");
      // Just inside the window (periodStart itself, GTE).
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-inside",
        eventType: "subscription.purchased",
        subjectKey: "txn-inside",
        receivedAt: MONTH_START,
      });
      // 1ms before periodStart — outside the window.
      await seedEvent(handle, {
        tenantId,
        externalId: "evt-outside",
        eventType: "subscription.purchased",
        subjectKey: "txn-outside",
        receivedAt: new Date(MONTH_START.getTime() - 1),
      });
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      // newInPeriod and activeInPeriod respect the window
      assertEquals(stats.newInPeriod, 1);
      assertEquals(stats.activeInPeriod, 1);
      // lifetime ignores period — both counted
      assertEquals(stats.lifetime, 2);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "getSubscriberStats: activeInPeriod aggregates purchased + renewed + recovered, not other types",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Active");
      // 4 distinct subjects, one event each:
      //   - purchased   → counted in active + new
      //   - renewed     → counted in active only
      //   - recovered   → counted in active only
      //   - expired     → NOT counted in active (revoke event, not billing)
      await seedEvent(handle, {
        tenantId,
        externalId: "e-pur",
        eventType: "subscription.purchased",
        subjectKey: "txn-pur",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-ren",
        eventType: "subscription.renewed",
        subjectKey: "txn-ren",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-rec",
        eventType: "subscription.recovered",
        subjectKey: "txn-rec",
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-exp",
        eventType: "subscription.expired",
        subjectKey: "txn-exp",
      });
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      assertEquals(stats.newInPeriod, 1, "only `purchased` counts as new");
      assertEquals(
        stats.activeInPeriod,
        3,
        "purchased + renewed + recovered count as active",
      );
      assertEquals(stats.lifetime, 1, "lifetime is purchased-only");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: lifetime spans events outside period",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Lifetime");
      const longAgo = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
      // One purchase a year ago (well outside trailing-30-days window),
      // one yesterday.
      await seedEvent(handle, {
        tenantId,
        externalId: "e-old",
        eventType: "subscription.purchased",
        subjectKey: "txn-old",
        receivedAt: longAgo,
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-new",
        eventType: "subscription.purchased",
        subjectKey: "txn-new",
        receivedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      });
      const stats = await getSubscriberStats(handle.db, tenantId, "month", nowFn);
      assertEquals(stats.newInPeriod, 1, "only the recent one is in the trailing 30d");
      assertEquals(stats.lifetime, 2, "both counted toward lifetime");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: tenant isolation — A's events not counted for B",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantA = await createSampleTenant(handle, "Tenant A");
      const tenantB = await createSampleTenant(handle, "Tenant B");
      await seedEvent(handle, {
        tenantId: tenantA,
        externalId: "e-A1",
        eventType: "subscription.purchased",
        subjectKey: "txn-A1",
      });
      await seedEvent(handle, {
        tenantId: tenantA,
        externalId: "e-A2",
        eventType: "subscription.purchased",
        subjectKey: "txn-A2",
      });
      await seedEvent(handle, {
        tenantId: tenantB,
        externalId: "e-B1",
        eventType: "subscription.purchased",
        subjectKey: "txn-B1",
      });
      const statsA = await getSubscriberStats(handle.db, tenantA, "month", nowFn);
      const statsB = await getSubscriberStats(handle.db, tenantB, "month", nowFn);
      assertEquals(statsA.lifetime, 2);
      assertEquals(statsB.lifetime, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "getSubscriberStats: period flag changes window length",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await createSampleTenant(handle, "Period");
      // Three purchases at: 12h ago, 5d ago, 60d ago.
      const t1 = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
      const t2 = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
      const t3 = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
      await seedEvent(handle, {
        tenantId,
        externalId: "e-12h",
        eventType: "subscription.purchased",
        subjectKey: "txn-12h",
        receivedAt: t1,
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-5d",
        eventType: "subscription.purchased",
        subjectKey: "txn-5d",
        receivedAt: t2,
      });
      await seedEvent(handle, {
        tenantId,
        externalId: "e-60d",
        eventType: "subscription.purchased",
        subjectKey: "txn-60d",
        receivedAt: t3,
      });
      // day window — only 12h-ago event qualifies
      assertEquals(
        (await getSubscriberStats(handle.db, tenantId, "day", nowFn)).newInPeriod,
        1,
      );
      // week window — 12h + 5d (60d still excluded)
      assertEquals(
        (await getSubscriberStats(handle.db, tenantId, "week", nowFn)).newInPeriod,
        2,
      );
      // year window — all three
      assertEquals(
        (await getSubscriberStats(handle.db, tenantId, "year", nowFn)).newInPeriod,
        3,
      );
    } finally {
      await teardown();
    }
  },
});

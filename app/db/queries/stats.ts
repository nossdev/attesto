/**
 * Stats queries — operator-facing analytics over webhook event history.
 *
 * Source of truth: `webhook_events`. We answer "how many subscribers does
 * this tenant have?" by counting distinct `subject_key` values across the
 * unified `subscription.*` event vocabulary (see
 * `app/services/webhooks/normalize.ts`):
 *
 *   - `newInPeriod`     → count of unique `subject_key` for
 *                         `event_type = 'subscription.purchased'` in the
 *                         trailing-N-days period. Net-new paying users.
 *   - `activeInPeriod`  → count of unique `subject_key` across
 *                         `purchased ∪ renewed ∪ recovered` in the period.
 *                         Approximates "users who hit a billing event".
 *   - `lifetime`        → count of unique `subject_key` across all
 *                         `subscription.purchased` events ever recorded
 *                         for this tenant. Total paying users Attesto
 *                         has seen for them.
 *
 * Caveats:
 *   - Only tenants with webhook delivery configured produce
 *     `webhook_events` rows; sync-verify-only tenants are invisible to
 *     these counts. To extend later, query `validation_audit` (gated by
 *     `ENABLE_VALIDATION_AUDIT_LOG`).
 *   - `subject_key` is the chain-resolved root token (Apple
 *     `originalTransactionId`, Google root `purchaseToken`), so an
 *     upgrade/downgrade chain on Google still counts as one subscriber.
 *   - Rows with `subject_key = NULL` (Apple TEST, Google testNotification,
 *     refunds) are excluded from all three counts.
 */

import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { webhookEvents } from "@/db/schema.ts";

export type StatsPeriod = "day" | "week" | "month" | "year";

const PERIOD_DAYS: Record<StatsPeriod, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const ACTIVE_EVENT_TYPES = [
  "subscription.purchased",
  "subscription.renewed",
  "subscription.recovered",
] as const;

export interface SubscriberStats {
  newInPeriod: number;
  activeInPeriod: number;
  lifetime: number;
  /** Inclusive lower bound of the period window. */
  periodStart: Date;
  /** Exclusive upper bound — equals the `now` snapshot used for the query. */
  periodEnd: Date;
}

/**
 * Compute subscriber counts for a tenant over a trailing-N-days period.
 *
 * The `now` parameter is injected so tests can pin the time axis without
 * monkey-patching `Date`. Defaults to `new Date()`.
 *
 * Three independent COUNT(DISTINCT subject_key) queries dispatched via
 * `Promise.all`. At current scale (single onboarded tenant, low row
 * count), separate queries are simpler than a single CTE and the planner
 * uses `webhook_events_tenant_received_idx` for all three.
 */
export async function getSubscriberStats(
  db: Database,
  tenantId: string,
  period: StatsPeriod,
  now: () => Date = () => new Date(),
): Promise<SubscriberStats> {
  const periodEnd = now();
  const periodStart = new Date(
    periodEnd.getTime() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000,
  );

  // `count(distinct ...)` via raw SQL fragment: drizzle's `countDistinct`
  // helper exists in newer versions but the project pins drizzle-orm@0.36
  // which only ships `count` (always-distinct on a single column is what
  // we want anyway). `::int` cast keeps the JS-side number small —
  // postgres returns BIGINT by default, which drizzle hands back as
  // string.
  const distinctSubjects = sql<number>`COUNT(DISTINCT ${webhookEvents.subjectKey})::int`;

  const [newInPeriodRows, activeInPeriodRows, lifetimeRows] = await Promise.all([
    db
      .select({ n: distinctSubjects })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.tenantId, tenantId),
          eq(webhookEvents.eventType, "subscription.purchased"),
          isNotNull(webhookEvents.subjectKey),
          gte(webhookEvents.receivedAt, periodStart),
        ),
      ),
    db
      .select({ n: distinctSubjects })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.tenantId, tenantId),
          inArray(webhookEvents.eventType, [...ACTIVE_EVENT_TYPES]),
          isNotNull(webhookEvents.subjectKey),
          gte(webhookEvents.receivedAt, periodStart),
        ),
      ),
    db
      .select({ n: distinctSubjects })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.tenantId, tenantId),
          eq(webhookEvents.eventType, "subscription.purchased"),
          isNotNull(webhookEvents.subjectKey),
        ),
      ),
  ]);

  return {
    newInPeriod: newInPeriodRows[0]?.n ?? 0,
    activeInPeriod: activeInPeriodRows[0]?.n ?? 0,
    lifetime: lifetimeRows[0]?.n ?? 0,
    periodStart,
    periodEnd,
  };
}

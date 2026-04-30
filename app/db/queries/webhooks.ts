import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import {
  type WebhookConfig,
  webhookConfigs,
  webhookDeliveries,
  type WebhookDelivery,
  type WebhookEvent,
  webhookEvents,
} from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";
import { clampLimit } from "@/lib/list-utils.ts";

// ─── webhook_configs ──────────────────────────────────────────────────────────

export interface UpsertWebhookConfigInput {
  tenantId: string;
  callbackUrl: string;
  secretEnc: Uint8Array;
  isActive?: boolean;
}

export async function upsertWebhookConfig(
  db: Database,
  input: UpsertWebhookConfigInput,
): Promise<WebhookConfig> {
  const [row] = await db
    .insert(webhookConfigs)
    .values({
      tenantId: input.tenantId,
      callbackUrl: input.callbackUrl,
      secretEnc: input.secretEnc,
      isActive: input.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: webhookConfigs.tenantId,
      set: {
        callbackUrl: input.callbackUrl,
        secretEnc: input.secretEnc,
        isActive: input.isActive ?? true,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsertWebhookConfig: no row returned");
  return row;
}

export async function getWebhookConfig(
  db: Database,
  tenantId: string,
): Promise<WebhookConfig | null> {
  const rows = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, tenantId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── webhook_events ───────────────────────────────────────────────────────────

export interface InsertWebhookEventInput {
  tenantId: string;
  source: "apple" | "google";
  externalId: string;
  eventType: string;
  rawPayload: Record<string, unknown>;
  decodedPayload: Record<string, unknown>;
}

export interface InsertWebhookEventResult {
  event: WebhookEvent;
  /** False if a row with the same (tenant, source, externalId) already existed. */
  isNew: boolean;
}

/**
 * Insert a webhook event idempotently. If the (tenant, source, externalId)
 * triple already exists, returns the existing row with `isNew = false`.
 * Caller uses `isNew` to decide whether to enqueue a new delivery.
 *
 * PostgreSQL's unique constraint serializes concurrent inserts against the
 * partial unique index — the second INSERT blocks on the first's xid lock
 * until commit/rollback. So by the time our follow-up SELECT runs, the
 * winning row is visible. Belt-and-braces: we retry the SELECT once on
 * empty (theoretical scenarios like PITR/replication lag) and only then
 * surface the idempotent outcome without the row if it's still missing.
 */
export async function insertWebhookEventIdempotent(
  db: Database,
  input: InsertWebhookEventInput,
): Promise<InsertWebhookEventResult> {
  const id = makeId.event();
  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      id,
      tenantId: input.tenantId,
      source: input.source,
      externalId: input.externalId,
      eventType: input.eventType,
      rawPayload: input.rawPayload,
      decodedPayload: input.decodedPayload,
    })
    .onConflictDoNothing({
      target: [webhookEvents.tenantId, webhookEvents.source, webhookEvents.externalId],
    })
    .returning();

  if (inserted) return { event: inserted, isNew: true };

  async function findExisting(): Promise<WebhookEvent | undefined> {
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.tenantId, input.tenantId),
          eq(webhookEvents.source, input.source),
          eq(webhookEvents.externalId, input.externalId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  let existing = await findExisting();
  if (!existing) {
    // Only reachable if the winning tx is somehow invisible to us — race
    // between onConflict and SELECT across replicas, or snapshot anomalies.
    // Retry once; if still missing, log and degrade gracefully.
    await new Promise((r) => setTimeout(r, 50));
    existing = await findExisting();
  }
  if (!existing) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "webhook_idempotent_insert_race_degraded",
        tenantId: input.tenantId,
        source: input.source,
        externalId: input.externalId,
      }),
    );
    // Return a minimal sentinel with isNew=false so the caller skips
    // enqueueing a duplicate delivery. The upstream sender (Apple/Google)
    // will retry and on the next attempt we'll see the committed row.
    return {
      isNew: false,
      event: {
        id,
        tenantId: input.tenantId,
        source: input.source,
        externalId: input.externalId,
        eventType: input.eventType,
        rawPayload: input.rawPayload,
        decodedPayload: input.decodedPayload,
        receivedAt: new Date(),
      },
    };
  }
  return { event: existing, isNew: false };
}

// ─── webhook_deliveries ───────────────────────────────────────────────────────

export interface EnqueueWebhookDeliveryInput {
  eventId: string;
  tenantId: string;
  callbackUrl: string;
  nextAttemptAt?: Date;
}

export async function enqueueWebhookDelivery(
  db: Database,
  input: EnqueueWebhookDeliveryInput,
): Promise<WebhookDelivery> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      id: makeId.delivery(),
      eventId: input.eventId,
      tenantId: input.tenantId,
      callbackUrl: input.callbackUrl,
      nextAttemptAt: input.nextAttemptAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error("enqueueWebhookDelivery: no row returned");
  return row;
}

export async function claimPendingDeliveries(
  db: Database,
  now: Date,
  limit: number,
): Promise<WebhookDelivery[]> {
  // Claim-style select: pick pending deliveries whose `next_attempt_at` has
  // passed. We don't lock here (simpler for a single-instance worker). If we
  // scale to multiple dispatcher instances, wrap in a transaction with
  // `FOR UPDATE SKIP LOCKED`.
  return await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit);
}

export interface UpdateDeliveryAttemptInput {
  id: string;
  responseCode: number | null;
  responseBody: string | null;
  /** If present, schedules another attempt. If absent, marks delivered or failed. */
  nextAttemptAt?: Date;
  outcome: "delivered" | "retry" | "failed";
}

export async function updateDeliveryAttempt(
  db: Database,
  input: UpdateDeliveryAttemptInput,
): Promise<WebhookDelivery | null> {
  const now = new Date();
  const update: Record<string, unknown> = {
    attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
    lastAttemptAt: now,
    lastResponseCode: input.responseCode,
    lastResponseBody: input.responseBody,
  };
  if (input.outcome === "delivered") {
    update.status = "delivered";
    update.deliveredAt = now;
  } else if (input.outcome === "failed") {
    update.status = "failed";
    update.failedAt = now;
  } else {
    update.nextAttemptAt = input.nextAttemptAt;
  }

  const [row] = await db
    .update(webhookDeliveries)
    .set(update)
    .where(eq(webhookDeliveries.id, input.id))
    .returning();
  return row ?? null;
}

// ─── Listing for ops/diagnostics (CLI inspection) ─────────────────────────────

/**
 * Recent webhook_events for a tenant, most recent first. Caps at `limit` rows
 * (default 20, hard ceiling 500). Used by `attesto webhook:list-events` to
 * surface just enough metadata to triage delivery flow without exposing raw
 * payload contents (which can be large).
 */
export async function listWebhookEventsByTenant(
  db: Database,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<WebhookEvent[]> {
  const limit = clampLimit(opts.limit, 20);
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.tenantId, tenantId))
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(limit);
  return rows;
}

/**
 * Recent webhook_deliveries for a tenant, most recent first. Caps at `limit`
 * (default 10, hard ceiling 500). Used by `attesto webhook:list-deliveries`.
 */
export async function listWebhookDeliveriesByTenant(
  db: Database,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<WebhookDelivery[]> {
  const limit = clampLimit(opts.limit, 10);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.tenantId, tenantId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
  return rows;
}

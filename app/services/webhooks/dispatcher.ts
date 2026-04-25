/**
 * Poll-and-drain dispatcher that owns the outbound webhook delivery loop.
 * Single-instance design: the main process runs one dispatcher, queries
 * pending deliveries on a tick, and processes up to `concurrency` in
 * parallel. If scaling to multiple instances later, swap to a
 * `FOR UPDATE SKIP LOCKED` claim or an external queue.
 */

import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client.ts";
import type { EncryptionService } from "@/services/crypto/encryption.ts";
import { webhookEvents } from "@/db/schema.ts";
import {
  claimPendingDeliveries,
  getWebhookConfig,
  updateDeliveryAttempt,
} from "@/db/queries/webhooks.ts";
import { attemptDelivery, type DeliveryAttemptOutcome } from "@/services/webhooks/delivery.ts";
import type { FetchLike } from "@/lib/http-utils.ts";

export const WEBHOOK_SECRET_ENC_CONTEXT = "webhook_configs.secret";

export interface DispatcherOptions {
  db: DbHandle;
  encryption: EncryptionService;
  intervalMs?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  /** One-shot tick — exposed for tests + admin hooks. */
  tick(limit?: number): Promise<TickResult>;
}

export interface TickResult {
  claimed: number;
  outcomes: DeliveryAttemptOutcome[];
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const intervalMs = opts.intervalMs ?? 10_000;
  const concurrency = opts.concurrency ?? 10;
  const now = opts.now ?? (() => new Date());
  let timer: number | undefined;
  let running = false;
  /**
   * Serialize ticks: if one is running, the next tick waits. Prevents a
   * single dispatcher from claiming the same delivery row twice when a tick
   * takes longer than `intervalMs`. For multi-instance deploys, swap this
   * for `FOR UPDATE SKIP LOCKED` on `claimPendingDeliveries`.
   */
  let currentTick: Promise<unknown> | null = null;

  async function processOne(
    delivery: import("@/db/schema.ts").WebhookDelivery,
  ): Promise<DeliveryAttemptOutcome> {
    // Re-fetch event and config at attempt time — tenant may have rotated
    // their HMAC secret since the delivery was enqueued, and we always
    // sign with the current secret. (Callback URL is snapshotted on the
    // delivery row, so that's unchanged.)
    const [event] = await opts.db.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, delivery.eventId))
      .limit(1);
    if (!event) {
      // Orphaned delivery (event was deleted) — mark failed; cascades should
      // have prevented this but be defensive.
      const outcome: DeliveryAttemptOutcome = {
        outcome: "failed",
        responseCode: null,
        responseBody: "event_deleted",
      };
      await updateDeliveryAttempt(opts.db.db, { id: delivery.id, ...outcome });
      return outcome;
    }

    const config = await getWebhookConfig(opts.db.db, delivery.tenantId);
    if (!config || !config.isActive) {
      // Tenant has no config (or deactivated) — abandon this delivery chain.
      const outcome: DeliveryAttemptOutcome = {
        outcome: "failed",
        responseCode: null,
        responseBody: "no_active_webhook_config",
      };
      await updateDeliveryAttempt(opts.db.db, { id: delivery.id, ...outcome });
      return outcome;
    }

    const secret = await opts.encryption.decryptString(
      config.secretEnc,
      WEBHOOK_SECRET_ENC_CONTEXT,
    );

    const outcome = await attemptDelivery({
      delivery,
      event,
      secret,
      fetchImpl: opts.fetchImpl,
      now,
    });

    await updateDeliveryAttempt(opts.db.db, {
      id: delivery.id,
      outcome: outcome.outcome,
      responseCode: outcome.responseCode,
      responseBody: outcome.responseBody,
      nextAttemptAt: outcome.nextAttemptAt,
    });
    return outcome;
  }

  async function tick(limit?: number): Promise<TickResult> {
    const claimed = await claimPendingDeliveries(opts.db.db, now(), limit ?? concurrency);
    if (claimed.length === 0) return { claimed: 0, outcomes: [] };

    // Bounded concurrency — don't spawn unbounded promises for large queues.
    const outcomes: DeliveryAttemptOutcome[] = [];
    for (let i = 0; i < claimed.length; i += concurrency) {
      const chunk = claimed.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((d) => processOne(d)));
      outcomes.push(...chunkResults);
    }
    return { claimed: claimed.length, outcomes };
  }

  async function runTickAndReschedule(): Promise<void> {
    if (!running) return;
    currentTick = tick().catch((err) => {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "webhook_dispatcher_tick_failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    try {
      await currentTick;
    } finally {
      currentTick = null;
    }
    if (running) {
      timer = setTimeout(runTickAndReschedule, intervalMs) as unknown as number;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    // Fire first tick immediately, then the loop reschedules itself only
    // after each tick completes — ticks never overlap.
    void runTickAndReschedule();
  }

  async function stop(): Promise<void> {
    running = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (currentTick) await currentTick;
  }

  return { start, stop, tick };
}

/**
 * Built-in TTL purge for everything Attesto stores per purchase.
 *
 * Before this existed, `docs/self-host/maintenance.md` shipped manual
 * pruning SQL and a warning that two tables grow unbounded — which makes
 * "we don't keep it" a promise the operator has to remember to keep. This
 * runs the sweep in-process on a timer instead.
 *
 * **Off by default.** Every window is null unless the operator sets one, so
 * an existing deployment's retention does not silently change on upgrade.
 *
 * Tables swept:
 *   - `webhook_events` (+ their `webhook_deliveries`, deleted first because
 *     of the foreign key)
 *   - `validation_audit`
 *   - `google_purchase_chains` — the one table that holds purchase tokens
 *     in plaintext at rest, so bounding it bounds that exposure
 */

import { inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import {
  googlePurchaseChains,
  validationAudit,
  webhookDeliveries,
  webhookEvents,
} from "@/db/schema.ts";

/** A null window means "keep forever" — that table is not swept at all. */
export interface RetentionPolicy {
  webhookEventDays: number | null;
  validationAuditDays: number | null;
  googleChainDays: number | null;
}

export interface PurgeResult {
  webhookEvents: number;
  webhookDeliveries: number;
  validationAudit: number;
  googlePurchaseChains: number;
}

/** True when at least one window is set — i.e. the purger is worth running. */
export function policyIsActive(policy: RetentionPolicy): boolean {
  return policy.webhookEventDays !== null ||
    policy.validationAuditDays !== null ||
    policy.googleChainDays !== null;
}

function cutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Run one sweep. Safe to call concurrently with live traffic: every delete
 * is bounded by a timestamp in the past, so it never races a row being
 * written now.
 */
export async function purgeOnce(
  db: Database,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const result: PurgeResult = {
    webhookEvents: 0,
    webhookDeliveries: 0,
    validationAudit: 0,
    googlePurchaseChains: 0,
  };

  if (policy.webhookEventDays !== null) {
    const before = cutoff(policy.webhookEventDays, now);
    // Collect ids first: `webhook_deliveries` references `webhook_events`,
    // so the children must go before the parents. Doing it by id (rather
    // than a correlated subquery inside the delete) keeps the two
    // statements consistent even if a row ages past the cutoff between them.
    const doomed = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(lt(webhookEvents.receivedAt, before));
    const ids = doomed.map((r) => r.id);
    if (ids.length > 0) {
      const deliveries = await db
        .delete(webhookDeliveries)
        .where(inArray(webhookDeliveries.eventId, ids))
        .returning({ id: webhookDeliveries.id });
      result.webhookDeliveries = deliveries.length;
      const events = await db
        .delete(webhookEvents)
        .where(inArray(webhookEvents.id, ids))
        .returning({ id: webhookEvents.id });
      result.webhookEvents = events.length;
    }
  }

  if (policy.validationAuditDays !== null) {
    const rows = await db
      .delete(validationAudit)
      .where(lt(validationAudit.createdAt, cutoff(policy.validationAuditDays, now)))
      .returning({ id: validationAudit.id });
    result.validationAudit = rows.length;
  }

  if (policy.googleChainDays !== null) {
    const rows = await db
      .delete(googlePurchaseChains)
      .where(lt(googlePurchaseChains.createdAt, cutoff(policy.googleChainDays, now)))
      .returning({ currentToken: googlePurchaseChains.currentToken });
    result.googlePurchaseChains = rows.length;
  }

  return result;
}

export interface CreatePurgerOptions {
  db: Database;
  policy: RetentionPolicy;
  /** How often to sweep. */
  intervalMs: number;
}

export interface Purger {
  start(): void;
  stop(): Promise<void>;
  /** Exposed for tests and for a future `attesto purge` subcommand. */
  runOnce(): Promise<PurgeResult>;
}

/**
 * Timer-driven purger, shaped like the webhook dispatcher: `start` is
 * non-blocking, `stop` awaits any sweep already in flight.
 */
export function createPurger(opts: CreatePurgerOptions): Purger {
  let timer: number | undefined;
  let inFlight: Promise<unknown> | null = null;

  async function runOnce(): Promise<PurgeResult> {
    const result = await purgeOnce(opts.db, opts.policy);
    const total = result.webhookEvents + result.webhookDeliveries +
      result.validationAudit + result.googlePurchaseChains;
    if (total > 0) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "retention_purge",
        ...result,
      }));
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (inFlight) return; // never overlap sweeps
    const run = runOnce().catch((err) => {
      // A failed sweep is an operational problem, not a request-path one:
      // log and try again next tick rather than crashing the process.
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "retention_purge_failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      if (!policyIsActive(opts.policy)) return; // nothing configured
      timer = setInterval(() => void tick(), opts.intervalMs);
      // Sweep once at boot so a long interval doesn't leave stale rows
      // sitting for a full cycle after a restart.
      void tick();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (inFlight) await inFlight;
    },
    runOnce,
  };
}

/** Re-exported so callers can build a policy without importing drizzle. */
export const RETENTION_SQL_NOW = sql`now()`;

/**
 * Built-in TTL purge for the rows Attesto accumulates per purchase.
 *
 * Before this existed, `docs/self-host/maintenance.md` shipped manual
 * pruning SQL and a warning that two tables grow unbounded — which makes
 * "we don't keep it" a promise the operator has to remember to keep. This
 * runs the sweep in-process on a timer instead.
 *
 * **Off by default.** Every window is null unless the operator sets one, so
 * an existing deployment's retention does not change on upgrade.
 *
 * Tables swept:
 *   - `webhook_events` — holds the identifiers in `subject_key`,
 *     `app_user_id` and `decoded_payload` (and, unless
 *     `WEBHOOK_PERSIST_RAW_PAYLOAD=false`, `raw_payload` too)
 *   - `webhook_deliveries` — the attempt history for those events
 *   - `validation_audit` — identifier HMACs, never raw identifiers
 *   - `google_purchase_chains` — `current_token` / `previous_token` in
 *     plaintext
 *
 * ### Why every delete is batched
 *
 * The obvious implementation — `SELECT` the doomed ids, then `DELETE …
 * WHERE id IN (…)` — emits one bind parameter per id, and the Postgres
 * wire protocol caps a Bind message at 65534 of them. It therefore throws
 * on the **first** sweep of any deployment with more than ~65k expired
 * rows: precisely the deployment that has been accumulating for a year and
 * has just set a window for the first time. Worse, it never recovers, since
 * the next tick re-issues the same oversized statement.
 *
 * So each delete instead drives a bounded `LIMIT` subquery — two bind
 * parameters, whatever the backlog — and loops until a short batch says the
 * table is drained. That also keeps each statement's locks short, and means
 * a crash mid-sweep loses only the current batch.
 */

import { eq, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import {
  googlePurchaseChains,
  validationAudit,
  webhookDeliveries,
  webhookEvents,
} from "@/db/schema.ts";
import { scrubbedErrorMessage } from "@/lib/log-redaction.ts";

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

/** Rows removed per statement. Small enough to keep locks brief. */
export const PURGE_BATCH_SIZE = 5_000;

/**
 * Hard stop on the batch loop. At the default batch size this is 50M rows
 * in one sweep — far past any real backlog, and there only so a bug that
 * stops making progress cannot spin forever.
 */
const MAX_BATCHES = 10_000;

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
 * Run `deleteBatch` until it reports a short batch, returning the total.
 *
 * `deleteBatch` must delete at most `PURGE_BATCH_SIZE` rows and return how
 * many it actually deleted.
 */
async function deleteInBatches(deleteBatch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < PURGE_BATCH_SIZE) return total;
  }
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    level: "warn",
    msg: "retention_purge_batch_cap_reached",
    note: "sweep stopped at the batch cap; the remainder goes on the next tick",
    deleted: total,
  }));
  return total;
}

/** Rows affected by a delete, without materializing them. */
async function deletedCount(query: Promise<unknown>): Promise<number> {
  const result = await query as { count?: number } | undefined;
  return result?.count ?? 0;
}

/**
 * Delete rows of `table` whose `idColumn` falls in a bounded window of the
 * rows matching `predicate`. One statement, two bind parameters.
 */
function batchedDeleteBy(
  db: Database,
  // deno-lint-ignore no-explicit-any
  table: any,
  // deno-lint-ignore no-explicit-any
  idColumn: any,
  predicate: SQL | undefined,
): () => Promise<number> {
  return () =>
    deletedCount(
      db.delete(table).where(
        inArray(
          idColumn,
          db.select({ id: idColumn }).from(table).where(predicate).limit(PURGE_BATCH_SIZE),
        ),
      ),
    );
}

async function purgeWebhookEvents(db: Database, before: Date): Promise<{
  events: number;
  deliveries: number;
}> {
  // `webhook_deliveries.event_id` is ON DELETE CASCADE, so deleting the
  // events alone would be enough. We delete the deliveries explicitly first
  // only so the sweep can report how many went — a cascade is silent.
  const deliveries = await deleteInBatches(() =>
    deletedCount(
      db.delete(webhookDeliveries).where(
        inArray(
          webhookDeliveries.id,
          db
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .innerJoin(webhookEvents, eq(webhookDeliveries.eventId, webhookEvents.id))
            .where(lt(webhookEvents.receivedAt, before))
            .limit(PURGE_BATCH_SIZE),
        ),
      ),
    )
  );

  const events = await deleteInBatches(
    batchedDeleteBy(db, webhookEvents, webhookEvents.id, lt(webhookEvents.receivedAt, before)),
  );

  return { events, deliveries };
}

/**
 * `google_purchase_chains` has a composite primary key, so there is no
 * single id column to drive a `LIMIT` subquery. Postgres' `ctid` gives us a
 * per-row handle that serves the same purpose.
 */
function purgeGoogleChains(db: Database, before: Date): Promise<number> {
  return deleteInBatches(() =>
    deletedCount(
      // `before` is bound as an ISO string with an explicit cast: the
      // driver does not accept a bare Date through a raw template.
      db.execute(sql`
        delete from ${googlePurchaseChains}
        where ctid in (
          select ctid from ${googlePurchaseChains}
          where ${googlePurchaseChains.createdAt} < ${before.toISOString()}::timestamptz
          limit ${PURGE_BATCH_SIZE}
        )
      `),
    )
  );
}

/**
 * Run one sweep.
 *
 * Each window is independent: a failure in one table still leaves the
 * others swept, because each is awaited separately and the caller logs
 * whatever completed.
 */
export async function purgeOnce(
  db: Database,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<PurgeResult> {
  let webhookEventCount = 0;
  let webhookDeliveryCount = 0;
  let validationAuditCount = 0;
  let googleChainCount = 0;

  if (policy.webhookEventDays !== null) {
    const { events, deliveries } = await purgeWebhookEvents(
      db,
      cutoff(policy.webhookEventDays, now),
    );
    webhookEventCount = events;
    webhookDeliveryCount = deliveries;
  }

  if (policy.validationAuditDays !== null) {
    validationAuditCount = await deleteInBatches(
      batchedDeleteBy(
        db,
        validationAudit,
        validationAudit.id,
        lt(validationAudit.createdAt, cutoff(policy.validationAuditDays, now)),
      ),
    );
  }

  if (policy.googleChainDays !== null) {
    googleChainCount = await purgeGoogleChains(db, cutoff(policy.googleChainDays, now));
  }

  return {
    webhookEvents: webhookEventCount,
    webhookDeliveries: webhookDeliveryCount,
    validationAudit: validationAuditCount,
    googlePurchaseChains: googleChainCount,
  };
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
  /**
   * Run a sweep now. Shares the overlap guard with the timer, so an
   * out-of-band call can never run concurrently with a scheduled one.
   */
  runOnce(): Promise<PurgeResult | null>;
}

const EMPTY_RESULT: PurgeResult = {
  webhookEvents: 0,
  webhookDeliveries: 0,
  validationAudit: 0,
  googlePurchaseChains: 0,
};

/**
 * Timer-driven purger, shaped like the webhook dispatcher: `start` is
 * non-blocking, `stop` awaits any sweep already in flight.
 */
export function createPurger(opts: CreatePurgerOptions): Purger {
  let timer: number | undefined;
  let inFlight: Promise<PurgeResult | null> | null = null;

  async function sweep(): Promise<PurgeResult | null> {
    try {
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
    } catch (err) {
      // A failed sweep is an operational problem, not a request-path one:
      // log and try again on the next tick rather than crashing.
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "retention_purge_failed",
        error: scrubbedErrorMessage(err),
      }));
      return null;
    }
  }

  function runGuarded(): Promise<PurgeResult | null> {
    // Never overlap sweeps — a slow one must not stack behind the timer.
    if (inFlight) return inFlight;
    const run = sweep().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  return {
    start() {
      if (timer !== undefined) return;
      if (!policyIsActive(opts.policy)) return; // nothing configured
      timer = setInterval(() => void runGuarded(), opts.intervalMs);
      // Sweep once at boot so a long interval doesn't leave expired rows
      // sitting for a full cycle after every restart.
      void runGuarded();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (inFlight) await inFlight;
    },
    runOnce() {
      if (!policyIsActive(opts.policy)) return Promise.resolve({ ...EMPTY_RESULT });
      return runGuarded();
    },
  };
}

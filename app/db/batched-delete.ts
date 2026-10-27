/**
 * Bounded deletes, shared by the retention sweep and the tenant purge.
 *
 * Both face the same two problems with a large table:
 *
 *   - **The wire protocol.** Collecting ids and passing them to `IN (...)`
 *     emits one bind parameter per id, and Postgres caps a Bind message at
 *     65534. A delete written that way throws on the first run against any
 *     real backlog — the exact case these features exist for.
 *   - **Lock and WAL duration.** One statement deleting millions of rows
 *     holds locks for its whole run, bursts the WAL, and loses everything
 *     if it is interrupted.
 *
 * Driving a `LIMIT` subquery instead keeps every statement to two bind
 * parameters whatever the backlog, keeps each one short, and means an
 * interrupted run loses only the current batch.
 */

import { inArray, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client.ts";

/** Rows removed per statement. Small enough to keep locks brief. */
export const DELETE_BATCH_SIZE = 5_000;

/**
 * Hard stop on a batch loop. At the default batch size this is 50M rows in
 * one call — far past any real backlog, and there only so a bug that stops
 * making progress cannot spin forever.
 */
const MAX_BATCHES = 10_000;

/** Rows affected by a delete, without materializing them. */
export async function deletedCount(query: Promise<unknown>): Promise<number> {
  const result = await query as { count?: number } | undefined;
  return result?.count ?? 0;
}

/**
 * Run `deleteBatch` until it reports a short batch, returning the total.
 *
 * `deleteBatch` must delete at most `DELETE_BATCH_SIZE` rows and return how
 * many it actually deleted.
 */
export async function deleteInBatches(
  deleteBatch: () => Promise<number>,
  onCapReached?: (deleted: number) => void,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) return total;
  }
  onCapReached?.(total);
  return total;
}

/**
 * A batch deleter for a table with a single-column key: deletes the rows
 * matching `predicate`, `DELETE_BATCH_SIZE` at a time.
 */
export function batchedDeleteBy(
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
          db.select({ id: idColumn }).from(table).where(predicate).limit(DELETE_BATCH_SIZE),
        ),
      ),
    );
}

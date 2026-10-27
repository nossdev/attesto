/**
 * Hard erasure of everything Attesto holds for one tenant.
 *
 * This is the companion to `tenant:set-audit-log`: that decides whether
 * anything is kept going forward, this answers "delete what you already
 * have". `deactivateTenant` is the soft option — it flips `is_active` and
 * keeps every row.
 *
 * ### Why this cannot be a single DELETE on `tenants`
 *
 * Most tables cascade from `tenants`, so deleting the tenant row removes
 * them. **`validation_audit` does not.** It stores `tenant_id` as a plain
 * column with no foreign key, deliberately, so the audit trail can outlive
 * the tenant row. The consequence is that a purge which only deleted the
 * tenant would leave behind an HMAC of every identifier that tenant ever
 * looked up, plus the timing of each lookup, indefinitely.
 *
 * So the audit rows are deleted explicitly, and they are deleted even when
 * the tenant row is already gone — which is exactly the state a hand-rolled
 * "delete the tenant" leaves behind.
 *
 * ### Order matters, and it is not the obvious one
 *
 * The audit rows go **last**, after the tenant row.
 *
 * Authentication reads `tenants` and `api_keys` on every request with no
 * cache, and the audit write is fire-and-forget in a `finally`. Delete the
 * audit rows first and a request already in flight — or any request
 * arriving in the gap — still authenticates and inserts a new row behind
 * the delete, because `validation_audit` has no foreign key to stop it. A
 * purge run under load would then leave exactly the rows it exists to
 * erase, and report a count lower than what remains. Deleting `tenants`
 * first cascades `api_keys`, so every subsequent request 401s before it can
 * record anything.
 *
 * The large child tables are batch-deleted before that, to keep any single
 * statement short; the cascade then mops up whatever arrived in between.
 *
 * ### Not a transaction, deliberately
 *
 * A tenant with millions of rows would make one transaction a very long
 * one. The order above makes partial failure safe instead: the tenant is
 * either still fully present (nothing irreversible happened) or already
 * unable to authenticate, with at most some audit rows left that a re-run
 * removes. The command is idempotent — running it twice is the fix.
 */

import { count, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { batchedDeleteBy, deletedCount, deleteInBatches } from "@/db/batched-delete.ts";
import {
  apiKeys,
  appleCredentials,
  googleCredentials,
  googlePurchaseChains,
  tenants,
  validationAudit,
  webhookConfigs,
  webhookDeliveries,
  webhookEvents,
} from "@/db/schema.ts";

/** Rows removed (or, for a dry run, rows that would be removed). */
export interface TenantPurgeCounts {
  apiKeys: number;
  appleCredentials: number;
  googleCredentials: number;
  webhookConfigs: number;
  webhookEvents: number;
  webhookDeliveries: number;
  googlePurchaseChains: number;
  validationAudit: number;
  /** 1 when the tenant row itself existed, 0 when it was already gone. */
  tenant: number;
}

export interface PurgeTenantOptions {
  /** Count what would go without deleting anything. */
  dryRun?: boolean;
}

// deno-lint-ignore no-explicit-any
type Table = any;

async function countRows(db: Database, table: Table, column: Table, id: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(table).where(eq(column, id));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Count, then delete, every row belonging to `tenantId`.
 *
 * Counting first is what makes the report accurate: most of these tables
 * are removed by the cascade when the tenant row goes, and a cascade
 * reports nothing.
 */
export async function purgeTenantData(
  db: Database,
  tenantId: string,
  opts: PurgeTenantOptions = {},
): Promise<TenantPurgeCounts> {
  const counts: TenantPurgeCounts = {
    apiKeys: await countRows(db, apiKeys, apiKeys.tenantId, tenantId),
    appleCredentials: await countRows(
      db,
      appleCredentials,
      appleCredentials.tenantId,
      tenantId,
    ),
    googleCredentials: await countRows(
      db,
      googleCredentials,
      googleCredentials.tenantId,
      tenantId,
    ),
    webhookConfigs: await countRows(db, webhookConfigs, webhookConfigs.tenantId, tenantId),
    webhookEvents: await countRows(db, webhookEvents, webhookEvents.tenantId, tenantId),
    webhookDeliveries: await countRows(
      db,
      webhookDeliveries,
      webhookDeliveries.tenantId,
      tenantId,
    ),
    googlePurchaseChains: await countRows(
      db,
      googlePurchaseChains,
      googlePurchaseChains.tenantId,
      tenantId,
    ),
    validationAudit: await countRows(db, validationAudit, validationAudit.tenantId, tenantId),
    tenant: await countRows(db, tenants, tenants.id, tenantId),
  };

  if (opts.dryRun) return counts;

  // 1. The big children, batched, so no single statement runs long.
  counts.webhookDeliveries = await deleteInBatches(
    batchedDeleteBy(
      db,
      webhookDeliveries,
      webhookDeliveries.id,
      eq(webhookDeliveries.tenantId, tenantId),
    ),
  );
  counts.webhookEvents = await deleteInBatches(
    batchedDeleteBy(db, webhookEvents, webhookEvents.id, eq(webhookEvents.tenantId, tenantId)),
  );
  // Composite primary key, so there is no single id column to drive the
  // LIMIT subquery — these are few per tenant, so one statement is fine.
  counts.googlePurchaseChains = await deletedCount(
    db.delete(googlePurchaseChains).where(eq(googlePurchaseChains.tenantId, tenantId)),
  );

  // 2. The tenant row. Cascades api_keys, the credentials and the webhook
  //    config — all small — and anything that arrived during step 1. From
  //    here on no request for this tenant can authenticate.
  counts.tenant = await deletedCount(db.delete(tenants).where(eq(tenants.id, tenantId)));

  // 3. The audit rows, last and batched. Nothing cascades to them, and
  //    doing this before step 2 would race in-flight requests still able
  //    to authenticate and write new ones.
  counts.validationAudit = await deleteInBatches(
    batchedDeleteBy(
      db,
      validationAudit,
      validationAudit.id,
      eq(validationAudit.tenantId, tenantId),
    ),
  );

  return counts;
}

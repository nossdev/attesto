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
 */

import { count, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
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

  // `validation_audit` first and explicitly — nothing cascades to it, and
  // it must go even when the tenant row no longer exists.
  await db.delete(validationAudit).where(eq(validationAudit.tenantId, tenantId));
  // Everything else hangs off `tenants` with ON DELETE CASCADE.
  await db.delete(tenants).where(eq(tenants.id, tenantId));

  return counts;
}

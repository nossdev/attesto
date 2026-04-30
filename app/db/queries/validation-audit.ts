import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { type ValidationAudit, validationAudit } from "@/db/schema.ts";
import { clampLimit } from "@/lib/list-utils.ts";

/**
 * Recent validation_audit rows for a tenant, most recent first. Caps at
 * `limit` (default 20, hard ceiling 500). Used by `attesto audit:list` to
 * surface verify-call activity for triage. Only present when the operator
 * has set ENABLE_VALIDATION_AUDIT_LOG=true; otherwise the table is empty.
 *
 * Note: the `identifier_hash` column is HMAC-SHA256-keyed by the master
 * encryption key, so an operator with DB read but no master key cannot
 * recover the raw transactionId/purchaseToken from these rows. Callers
 * that surface this list to operators should NOT publish identifierHash
 * (it's reversible-by-the-key-holder only and adds no triage value).
 */
export async function listValidationAuditByTenant(
  db: Database,
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<ValidationAudit[]> {
  const limit = clampLimit(opts.limit, 20);
  return await db
    .select()
    .from(validationAudit)
    .where(eq(validationAudit.tenantId, tenantId))
    .orderBy(desc(validationAudit.createdAt))
    .limit(limit);
}

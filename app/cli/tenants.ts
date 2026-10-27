/**
 * Tenant subcommands: create, list, audit-log setting, deactivate, purge.
 *
 * See `shared.ts` for the handler contract these all follow.
 */
import {
  type AdminContext,
  type CliIO,
  defaultIo,
  parseArgs,
  reportZodIssues,
  TenantId,
} from "@/cli/shared.ts";
import { purgeTenantData, type TenantPurgeResult } from "@/db/queries/tenant-purge.ts";
import {
  createTenant,
  deactivateTenant,
  getTenantById,
  listTenants,
  setTenantAuditLog,
} from "@/db/queries/tenants.ts";
import { z } from "zod";

const TenantName = z.string().trim().min(1).max(200);

// ─── Subcommand runners ───────────────────────────────────────────────────────

const TenantCreateArgs = z.object({ name: TenantName });

export async function runTenantCreate(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { flags } = parseArgs(args);
  const parsed = TenantCreateArgs.safeParse(flags);
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto tenant:create --name <name>", parsed.error);
  }
  const tenant = await createTenant(ctx.db.db, { name: parsed.data.name });
  io.write(JSON.stringify({ id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }));
  return 0;
}

const TenantSetAuditLogArgs = z.object({
  tenantId: TenantId,
  // "default" clears the override so the tenant follows
  // ENABLE_VALIDATION_AUDIT_LOG again.
  enabled: z.enum(["true", "false", "default"]),
});

export async function runTenantSetAuditLog(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = TenantSetAuditLogArgs.safeParse({ tenantId: positional[0], ...flags });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto tenant:set-audit-log <tenant_id> --enabled true|false|default",
      parsed.error,
    );
  }
  const enabled = parsed.data.enabled === "default" ? null : parsed.data.enabled === "true";
  const updated = await setTenantAuditLog(ctx.db.db, parsed.data.tenantId, enabled);
  if (!updated) {
    io.err(`No such tenant: ${parsed.data.tenantId}`);
    return 1;
  }
  io.write(JSON.stringify({
    id: parsed.data.tenantId,
    auditLogEnabled: enabled,
    note: enabled === null
      ? "follows ENABLE_VALIDATION_AUDIT_LOG"
      : enabled
      ? "audit rows written for this tenant"
      : "no audit rows written for this tenant, whatever the deployment default",
  }));
  return 0;
}

export async function runTenantList(
  ctx: AdminContext,
  _args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const tenants = await listTenants(ctx.db.db);
  for (const t of tenants) {
    io.write(
      JSON.stringify({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        createdAt: t.createdAt,
      }),
    );
  }
  return 0;
}

const TenantPurgeArgs = z.object({
  tenantId: TenantId,
  // Retyping the id is the guard. This is irreversible and there is no
  // undo, so a mistyped argument must not be enough to erase a tenant.
  confirm: z.string().optional(),
  dryRun: z.enum(["true", "false"]).optional(),
});

/**
 * Flags this command accepts.
 *
 * Checked explicitly rather than left to Zod, which STRIPS unknown keys.
 * Silently discarding `--dryrun` or `--dry_run` would turn a command the
 * operator believes is a preview into a real erasure, and the only hint
 * would be `"dryRun": false` printed after the rows were gone.
 */
const KNOWN_PURGE_FLAGS = new Set(["confirm", "dry-run", "dryRun"]);

export async function runTenantPurge(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const usage = "Usage: attesto tenant:purge <tenant_id> --confirm <tenant_id> [--dry-run]\n" +
    "       --dry-run takes no value and must follow the tenant id.\n" +
    "       Irreversible. Deletes the tenant and every row referencing it,\n" +
    "       including validation_audit (which no cascade reaches).";
  const { positional, flags } = parseArgs(args);

  const unknown = Object.keys(flags).filter((f) => !KNOWN_PURGE_FLAGS.has(f));
  if (unknown.length > 0) {
    io.err(`Unrecognized flag(s): ${unknown.map((f) => `--${f}`).join(", ")}`);
    io.err(usage);
    return 2;
  }
  if (positional.length > 1) {
    // Catches `-n` (parseArgs only treats `--` as a flag) and a stray
    // second id — both of which would otherwise be ignored.
    io.err(`Expected exactly one tenant id, got: ${positional.join(" ")}`);
    io.err(usage);
    return 2;
  }

  const parsed = TenantPurgeArgs.safeParse({
    tenantId: positional[0],
    confirm: flags.confirm,
    dryRun: flags.dryRun ?? flags["dry-run"],
  });
  if (!parsed.success) {
    return reportZodIssues(io, usage, parsed.error);
  }
  const { tenantId, confirm } = parsed.data;
  const dryRun = parsed.data.dryRun === "true";

  if (!dryRun) {
    if (!confirm) {
      io.err(`Refusing to purge ${tenantId} without --confirm.`);
      io.err(usage);
      return 2;
    }
    if (confirm !== tenantId) {
      io.err(`--confirm does not match the tenant id (got "${confirm}").`);
      return 2;
    }
  }

  // Read the name BEFORE deleting. Counts alone look plausible for any id;
  // the name is what tells an operator they pasted the wrong customer.
  const tenant = await getTenantById(ctx.db.db, tenantId);
  const result = await purgeTenantData(ctx.db.db, tenantId, { dryRun });
  return reportPurge(io, { tenantId, name: tenant?.name ?? null, dryRun, result });
}

export interface PurgeReportInput {
  tenantId: string;
  name: string | null;
  dryRun: boolean;
  result: TenantPurgeResult;
}

/**
 * Turn a purge result into operator output and an exit code.
 *
 * Pure apart from `io`, and exported, so the incomplete-sweep branch can
 * be tested without threading a test-only hook through the handler's
 * public signature.
 */
export function reportPurge(io: CliIO, input: PurgeReportInput): number {
  const { remainingByTable, remaining, complete, ...deleted } = input.result;
  const counts = {
    apiKeys: deleted.apiKeys,
    appleCredentials: deleted.appleCredentials,
    googleCredentials: deleted.googleCredentials,
    webhookConfigs: deleted.webhookConfigs,
    webhookEvents: deleted.webhookEvents,
    webhookDeliveries: deleted.webhookDeliveries,
    googlePurchaseChains: deleted.googlePurchaseChains,
    validationAudit: deleted.validationAudit,
    tenant: deleted.tenant,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // An incomplete sweep outranks "nothing to purge": a row that landed
  // during the sweep would otherwise be reported as nothing found.
  if (complete === false) {
    io.write(JSON.stringify({
      id: input.tenantId,
      name: input.name,
      dryRun: input.dryRun,
      deleted: counts,
      remaining,
      remainingByTable,
      complete,
    }));
    // The sweep is not transactional, so "no error" is not "nothing left".
    // Say so loudly and exit non-zero: an erasure reported as done when it
    // half-finished is the failure that matters here.
    const leftovers = Object.entries(remainingByTable ?? {})
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${table}=${n}`)
      .join(", ");
    io.err(`Purge incomplete — ${remaining} row(s) still present: ${leftovers}`);
    io.err("Re-run the same command; the purge is idempotent.");
    return 3;
  }

  if (total === 0) {
    io.err(`No data found for ${input.tenantId} — nothing to purge.`);
    return 1;
  }

  io.write(JSON.stringify({
    id: input.tenantId,
    name: input.name,
    dryRun: input.dryRun,
    deleted: counts,
    remaining,
    remainingByTable,
    complete,
  }));
  return 0;
}

const TenantDeactivateArgs = z.object({ tenantId: TenantId });

export async function runTenantDeactivate(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = TenantDeactivateArgs.safeParse({ tenantId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto tenant:deactivate <tenant_id>", parsed.error);
  }
  // Look up first so we can distinguish "not found" from "already inactive".
  const existing = await getTenantById(ctx.db.db, parsed.data.tenantId);
  if (!existing) {
    io.err(`Tenant not found: ${parsed.data.tenantId}`);
    return 1;
  }
  if (!existing.isActive) {
    io.err(`Tenant already deactivated: ${parsed.data.tenantId}`);
    return 1;
  }
  const ok = await deactivateTenant(ctx.db.db, parsed.data.tenantId);
  if (!ok) {
    // Race: someone else deactivated/deleted the row between SELECT and UPDATE.
    io.err(`Tenant not found or could not be deactivated: ${parsed.data.tenantId}`);
    return 1;
  }
  io.write(
    JSON.stringify({
      id: parsed.data.tenantId,
      isActive: false,
      deactivatedAt: new Date().toISOString(),
    }),
  );
  return 0;
}

import { assert, assertEquals } from "@std/assert";
import { getTableColumns, isTable } from "drizzle-orm";
import * as schema from "@/db/schema.ts";
import type { TenantPurgeCounts } from "@/db/queries/tenant-purge.ts";

/**
 * The keys `purgeTenantData` reports. Kept here as a literal so adding a
 * field to `TenantPurgeCounts` without covering a table is a type error
 * rather than a silent gap.
 */
const REPORTED: Record<keyof TenantPurgeCounts, true> = {
  apiKeys: true,
  appleCredentials: true,
  googleCredentials: true,
  webhookConfigs: true,
  webhookEvents: true,
  webhookDeliveries: true,
  googlePurchaseChains: true,
  validationAudit: true,
  tenant: true,
};

Deno.test("tenant purge: every tenant-scoped table is counted by the purge", () => {
  // The failure this guards is how validation_audit became a problem: a
  // table grows a tenant_id, the purge is not updated, and nothing fails.
  // It matters more now than it did — the CLI affirmatively prints
  // "complete": true and exits 0, so an uncovered table would turn a
  // half-done erasure into a confident claim that it finished.
  const tenantScoped: string[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!isTable(value)) continue;
    const columns = Object.keys(getTableColumns(value));
    if (exportName === "tenants" || columns.includes("tenantId")) {
      tenantScoped.push(exportName);
    }
  }

  assert(tenantScoped.length >= 9, `expected the tenant-scoped tables, saw ${tenantScoped}`);

  // `tenants` is reported as `tenant`; every other table maps by name.
  const reportedKeys = new Set(Object.keys(REPORTED));
  const uncovered = tenantScoped.filter((t) =>
    !(t === "tenants" ? reportedKeys.has("tenant") : reportedKeys.has(t))
  );

  assertEquals(
    uncovered,
    [],
    `these tables carry tenant_id but purgeTenantData does not count them — ` +
      `add them to TenantPurgeCounts, countAll, and the deletes: ${uncovered.join(", ")}`,
  );
});

Deno.test("tenant purge: the purge reports nothing that is not a real table", () => {
  const tableNames = new Set(
    Object.entries(schema).filter(([, v]) => isTable(v)).map(([k]) => k),
  );
  for (const key of Object.keys(REPORTED)) {
    const expected = key === "tenant" ? "tenants" : key;
    assert(tableNames.has(expected), `${key} does not correspond to a schema table`);
  }
});

import { assert, assertEquals } from "@std/assert";
import { type CliIO } from "@/cli/shared.ts";
import { reportPurge } from "@/cli/tenants.ts";
import type { TenantPurgeCounts, TenantPurgeResult } from "@/db/queries/tenant-purge.ts";

function captureIo(): { io: CliIO; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return { io: { write: (l) => out.push(l), err: (l) => errs.push(l) }, out, errs };
}

const ZERO: TenantPurgeCounts = {
  apiKeys: 0,
  appleCredentials: 0,
  googleCredentials: 0,
  webhookConfigs: 0,
  webhookEvents: 0,
  webhookDeliveries: 0,
  googlePurchaseChains: 0,
  validationAudit: 0,
  tenant: 0,
};

function result(over: Partial<TenantPurgeResult> = {}): TenantPurgeResult {
  return {
    ...ZERO,
    remainingByTable: { ...ZERO },
    remaining: 0,
    complete: true,
    ...over,
  };
}

const INPUT = { tenantId: "tenant_01HXY", name: "Acme", dryRun: false };

Deno.test("purge report: a clean sweep exits 0 and reports complete", () => {
  const { io, out, errs } = captureIo();

  const code = reportPurge(io, { ...INPUT, result: result({ tenant: 1, apiKeys: 2 }) });

  assertEquals(code, 0);
  assertEquals(errs.length, 0);
  const body = JSON.parse(out[0]!);
  assertEquals(body.complete, true);
  assertEquals(body.remaining, 0);
  assertEquals(body.name, "Acme");
  assertEquals(body.deleted.apiKeys, 2);
});

Deno.test("purge report: surviving rows exit 3 and name the tables", () => {
  const { io, errs } = captureIo();

  const code = reportPurge(io, {
    ...INPUT,
    result: result({
      tenant: 1,
      complete: false,
      remaining: 3,
      remainingByTable: { ...ZERO, validationAudit: 3 },
    }),
  });

  assertEquals(code, 3);
  assert(errs.some((e) => e.includes("Purge incomplete")));
  assert(errs.some((e) => e.includes("validationAudit=3")));
  assert(errs.some((e) => e.toLowerCase().includes("idempotent")));
});

Deno.test("purge report: an incomplete sweep outranks 'nothing to purge'", () => {
  // Every count zero but a row landed during the sweep. Reporting
  // "nothing found" there would hide a real leftover.
  const { io, errs } = captureIo();

  const code = reportPurge(io, {
    ...INPUT,
    result: result({
      complete: false,
      remaining: 1,
      remainingByTable: { ...ZERO, validationAudit: 1 },
    }),
  });

  assertEquals(code, 3);
  assert(!errs.some((e) => e.includes("nothing to purge")));
});

Deno.test("purge report: nothing found at all exits 1", () => {
  const { io, errs } = captureIo();

  const code = reportPurge(io, { ...INPUT, result: result() });

  assertEquals(code, 1);
  assert(errs.some((e) => e.includes("nothing to purge")));
});

Deno.test("purge report: remainingByTable reaches stdout, as the docs promise", () => {
  const { io, out } = captureIo();

  reportPurge(io, { ...INPUT, result: result({ tenant: 1 }) });

  assert("remainingByTable" in JSON.parse(out[0]!));
});

Deno.test("purge report: a dry run reports its nulls without claiming completeness", () => {
  const { io, out } = captureIo();

  const code = reportPurge(io, {
    tenantId: "tenant_01HXY",
    name: "Acme",
    dryRun: true,
    result: { ...ZERO, tenant: 1, remainingByTable: null, remaining: null, complete: null },
  });

  assertEquals(code, 0);
  const body = JSON.parse(out[0]!);
  assertEquals(body.dryRun, true);
  assertEquals(body.complete, null);
});

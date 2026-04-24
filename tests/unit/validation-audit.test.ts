import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createValidationAuditRecorder } from "@/services/audit/validation-audit.ts";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import type { Database } from "@/db/client.ts";
import type { ValidationAudit } from "@/db/schema.ts";

const TEST_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=";
const encryption = createEncryptionService(TEST_KEY);

interface InsertCapture {
  values?: ValidationAudit;
  didInsert: boolean;
}

function fakeDb(capture: InsertCapture, opts: { failInsert?: boolean } = {}): Database {
  const insertChain = {
    values: (v: ValidationAudit) => {
      capture.values = v;
      capture.didInsert = true;
      if (opts.failInsert) {
        return Promise.reject(new Error("simulated DB outage"));
      }
      return Promise.resolve([v]);
    },
  };
  return { insert: () => insertChain } as unknown as Database;
}

Deno.test("validation-audit: returns a no-op recorder when disabled", async () => {
  const capture: InsertCapture = { didInsert: false };
  const recorder = createValidationAuditRecorder({
    db: fakeDb(capture),
    encryption,
    enabled: false,
  });
  await recorder.record({
    tenantId: "tenant_x",
    source: "apple",
    identifier: "2000000123456789",
    valid: true,
    latencyMs: 42,
  });
  assertEquals(capture.didInsert, false);
});

Deno.test("validation-audit: identifier is HMACed (never stored raw)", async () => {
  const capture: InsertCapture = { didInsert: false };
  const recorder = createValidationAuditRecorder({
    db: fakeDb(capture),
    encryption,
    enabled: true,
  });
  await recorder.record({
    tenantId: "tenant_x",
    source: "apple",
    identifier: "2000000123456789",
    valid: true,
    latencyMs: 42,
  });
  assertEquals(capture.didInsert, true);
  assert(capture.values);
  const row = capture.values;
  // Raw identifier MUST NOT appear anywhere in the stored row.
  assertEquals(
    Object.values(row).some((v) => typeof v === "string" && v.includes("2000000123456789")),
    false,
    "raw identifier leaked into audit row",
  );
  assert(/^[0-9a-f]{64}$/.test(row.identifierHash));
  assertEquals(row.source, "apple");
  assertEquals(row.tenantId, "tenant_x");
  assertEquals(row.valid, true);
  assertEquals(row.latencyMs, 42);
});

Deno.test("validation-audit: same identifier under same tenant+source → same hash", async () => {
  const c1: InsertCapture = { didInsert: false };
  const c2: InsertCapture = { didInsert: false };
  const r1 = createValidationAuditRecorder({ db: fakeDb(c1), encryption, enabled: true });
  const r2 = createValidationAuditRecorder({ db: fakeDb(c2), encryption, enabled: true });
  await r1.record({
    tenantId: "t",
    source: "apple",
    identifier: "id-1",
    valid: true,
    latencyMs: 1,
  });
  await r2.record({
    tenantId: "t",
    source: "apple",
    identifier: "id-1",
    valid: true,
    latencyMs: 1,
  });
  assertEquals(c1.values?.identifierHash, c2.values?.identifierHash);
});

Deno.test("validation-audit: same identifier under DIFFERENT tenants → different hashes", async () => {
  // The audit hash must defeat cross-tenant correlation. Tenant A and B both
  // querying the SAME transactionId should produce distinct stored hashes so
  // an operator reading the column can't link traffic across tenants.
  const cA: InsertCapture = { didInsert: false };
  const cB: InsertCapture = { didInsert: false };
  const r = createValidationAuditRecorder({ db: fakeDb(cA), encryption, enabled: true });
  const r2 = createValidationAuditRecorder({ db: fakeDb(cB), encryption, enabled: true });
  await r.record({
    tenantId: "tenant_a",
    source: "apple",
    identifier: "shared-txn",
    valid: true,
    latencyMs: 1,
  });
  await r2.record({
    tenantId: "tenant_b",
    source: "apple",
    identifier: "shared-txn",
    valid: true,
    latencyMs: 1,
  });
  assertNotEquals(cA.values?.identifierHash, cB.values?.identifierHash);
});

Deno.test("validation-audit: same identifier under DIFFERENT sources → different hashes", async () => {
  const cApple: InsertCapture = { didInsert: false };
  const cGoogle: InsertCapture = { didInsert: false };
  const r = createValidationAuditRecorder({ db: fakeDb(cApple), encryption, enabled: true });
  const r2 = createValidationAuditRecorder({ db: fakeDb(cGoogle), encryption, enabled: true });
  await r.record({ tenantId: "t", source: "apple", identifier: "same", valid: true, latencyMs: 1 });
  await r2.record({
    tenantId: "t",
    source: "google",
    identifier: "same",
    valid: true,
    latencyMs: 1,
  });
  assertNotEquals(cApple.values?.identifierHash, cGoogle.values?.identifierHash);
});

Deno.test("validation-audit: HMAC needs the master key — different keys produce different hashes", async () => {
  // Proves the hash is keyed (HMAC) rather than unkeyed (SHA-256) — an
  // operator with DB read but no master-key access can't offline-brute
  // identifiers by rebuilding the hash table themselves.
  const other = createEncryptionService("b3RoZXItZW5jcnlwdGlvbi1rZXktMzItYnl0ZXMteHg=");
  const c1: InsertCapture = { didInsert: false };
  const c2: InsertCapture = { didInsert: false };
  const r1 = createValidationAuditRecorder({ db: fakeDb(c1), encryption, enabled: true });
  const r2 = createValidationAuditRecorder({ db: fakeDb(c2), encryption: other, enabled: true });
  await r1.record({ tenantId: "t", source: "apple", identifier: "x", valid: true, latencyMs: 1 });
  await r2.record({ tenantId: "t", source: "apple", identifier: "x", valid: true, latencyMs: 1 });
  assertNotEquals(c1.values?.identifierHash, c2.values?.identifierHash);
});

Deno.test("validation-audit: swallows DB errors when fireAndForget=true (default)", async () => {
  const capture: InsertCapture = { didInsert: false };
  const recorder = createValidationAuditRecorder({
    db: fakeDb(capture, { failInsert: true }),
    encryption,
    enabled: true,
  });
  await recorder.record({
    tenantId: "t",
    source: "google",
    identifier: "tok",
    valid: false,
    errorCode: "PURCHASE_NOT_FOUND",
    latencyMs: 100,
  });
});

Deno.test("validation-audit: propagates DB errors when fireAndForget=false", async () => {
  const capture: InsertCapture = { didInsert: false };
  const recorder = createValidationAuditRecorder({
    db: fakeDb(capture, { failInsert: true }),
    encryption,
    enabled: true,
    fireAndForget: false,
  });
  let threw = false;
  try {
    await recorder.record({
      tenantId: "t",
      source: "google",
      identifier: "tok",
      valid: false,
      errorCode: "PURCHASE_NOT_FOUND",
      latencyMs: 100,
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected fireAndForget=false to propagate");
});

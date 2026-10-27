import { assertEquals, assertRejects } from "@std/assert";
import { withAudit } from "@/routes/shared.ts";
import type {
  ValidationAuditRecord,
  ValidationAuditRecorder,
} from "@/services/audit/validation-audit.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

function recording(): { recorder: ValidationAuditRecorder; rows: ValidationAuditRecord[] } {
  const rows: ValidationAuditRecord[] = [];
  return {
    rows,
    recorder: {
      record(input) {
        rows.push(input);
        return Promise.resolve();
      },
    },
  };
}

const CTX = {
  tenantId: "tenant_1",
  source: "apple" as const,
  identifier: "2000000000123456",
  tenantAuditLogEnabled: null,
  defaultEnabled: true,
};

Deno.test("withAudit: a successful lookup records valid=true with no error code", async () => {
  const { recorder, rows } = recording();

  await withAudit({ ...CTX, recorder }, () => Promise.resolve({ valid: true as const }));

  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.valid, true);
  assertEquals(rows[0]?.errorCode, null);
  assertEquals(rows[0]?.identifier, "2000000000123456");
  assertEquals(rows[0]?.source, "apple");
});

Deno.test("withAudit: a domain failure records its own error string", async () => {
  const { recorder, rows } = recording();

  await withAudit(
    { ...CTX, recorder },
    () => Promise.resolve({ valid: false as const, error: "SUBSCRIPTION_NOT_FOUND" }),
  );

  assertEquals(rows[0]?.valid, false);
  assertEquals(rows[0]?.errorCode, "SUBSCRIPTION_NOT_FOUND");
});

Deno.test("withAudit: an AppError's code wins over the domain error", async () => {
  // This is the precedence that matters: if the AppError code were lost,
  // every upstream fault would collapse to errorCode null and operators
  // would be unable to tell a credentials problem from a missing purchase.
  const { recorder, rows } = recording();

  await assertRejects(
    () =>
      withAudit({ ...CTX, recorder }, () => {
        throw new AppError(ErrorCodes.CREDENTIALS_MISSING, "no creds");
      }),
    AppError,
  );

  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.valid, false);
  assertEquals(rows[0]?.errorCode, ErrorCodes.CREDENTIALS_MISSING);
});

Deno.test("withAudit: an unclassified throw records INTERNAL_ERROR", async () => {
  const { recorder, rows } = recording();

  await assertRejects(
    () => withAudit({ ...CTX, recorder }, () => Promise.reject(new Error("boom"))),
    Error,
  );

  assertEquals(rows[0]?.errorCode, ErrorCodes.INTERNAL_ERROR);
  assertEquals(rows[0]?.valid, false);
});

Deno.test("withAudit: re-throws the original error unchanged", async () => {
  const { recorder } = recording();
  const original = new AppError(ErrorCodes.APPLE_API_ERROR, "Apple API request failed");

  const thrown = await assertRejects(
    () => withAudit({ ...CTX, recorder }, () => Promise.reject(original)),
    AppError,
  );

  assertEquals(thrown, original);
});

Deno.test("withAudit: records nothing when no recorder is configured", async () => {
  const result = await withAudit(CTX, () => Promise.resolve({ valid: true as const }));

  assertEquals(result.valid, true);
});

Deno.test("withAudit: a recorder that rejects cannot take the request down", async () => {
  // The recorder is a DI seam: nothing in its type stops it rejecting, and
  // the concrete one awaits an HMAC *outside* its own try/catch. An
  // unhandled rejection terminates the Deno process, so one audit hiccup
  // would become an outage for every tenant.
  const recorder: ValidationAuditRecorder = {
    record: () => Promise.reject(new Error("audit backend down")),
  };

  const result = await withAudit(
    { ...CTX, recorder },
    () => Promise.resolve({ valid: true as const }),
  );

  assertEquals(result.valid, true);
  // Give the rejected promise a turn to surface: Deno's test runner fails
  // the test if it goes unhandled.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("withAudit: a tenant opted out gets no audit row even with a recorder wired", async () => {
  const { recorder, rows } = recording();

  await withAudit(
    { ...CTX, recorder, tenantAuditLogEnabled: false, defaultEnabled: true },
    () => Promise.resolve({ valid: true as const }),
  );

  assertEquals(rows.length, 0);
});

Deno.test("withAudit: a tenant opted in gets a row even when the default is off", async () => {
  const { recorder, rows } = recording();

  await withAudit(
    { ...CTX, recorder, tenantAuditLogEnabled: true, defaultEnabled: false },
    () => Promise.resolve({ valid: true as const }),
  );

  assertEquals(rows.length, 1);
});

Deno.test("withAudit: no preference and a default of off writes nothing", async () => {
  const { recorder, rows } = recording();

  await withAudit(
    { ...CTX, recorder, tenantAuditLogEnabled: null, defaultEnabled: false },
    () => Promise.resolve({ valid: true as const }),
  );

  assertEquals(rows.length, 0);
});

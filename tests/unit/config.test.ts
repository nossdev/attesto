import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "@/config.ts";

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  // 32 bytes base64-encoded (openssl rand -base64 32)
  ATTESTO_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=",
};

Deno.test("loadConfig applies defaults when only required vars are set", () => {
  const config = loadConfig(VALID_ENV);
  assertEquals(config.PORT, 8080);
  assertEquals(config.LOG_LEVEL, "info");
  assertEquals(config.NODE_ENV, "development");
  assertEquals(config.RATE_LIMIT_PER_SECOND, 100);
  assertEquals(config.ENABLE_VALIDATION_AUDIT_LOG, false);
});

Deno.test("loadConfig throws on missing DATABASE_URL", () => {
  assertThrows(
    () => loadConfig({ ATTESTO_ENCRYPTION_KEY: "x" }),
    Error,
    "DATABASE_URL",
  );
});

Deno.test("loadConfig throws on missing ATTESTO_ENCRYPTION_KEY", () => {
  assertThrows(
    () => loadConfig({ DATABASE_URL: "postgres://u:p@h/d" }),
    Error,
    "ATTESTO_ENCRYPTION_KEY",
  );
});

Deno.test("loadConfig coerces numeric and boolean strings", () => {
  const config = loadConfig({
    ...VALID_ENV,
    PORT: "9090",
    RATE_LIMIT_PER_SECOND: "250",
    ENABLE_VALIDATION_AUDIT_LOG: "true",
  });
  assertEquals(config.PORT, 9090);
  assertEquals(config.RATE_LIMIT_PER_SECOND, 250);
  assertEquals(config.ENABLE_VALIDATION_AUDIT_LOG, true);
});

Deno.test("loadConfig rejects invalid LOG_LEVEL", () => {
  assertThrows(
    () => loadConfig({ ...VALID_ENV, LOG_LEVEL: "LOUD" }),
    Error,
    "LOG_LEVEL",
  );
});

Deno.test("loadConfig rejects ATTESTO_ENCRYPTION_KEY that is not 32 decoded bytes", () => {
  assertThrows(
    () =>
      loadConfig({
        DATABASE_URL: VALID_ENV.DATABASE_URL,
        ATTESTO_ENCRYPTION_KEY: "dG9vLXNob3J0",
      }),
    Error,
    "ATTESTO_ENCRYPTION_KEY",
  );
});

Deno.test("loadConfig rejects ATTESTO_ENCRYPTION_KEY that is not valid base64", () => {
  assertThrows(
    () =>
      loadConfig({
        DATABASE_URL: VALID_ENV.DATABASE_URL,
        ATTESTO_ENCRYPTION_KEY: "not-base64-!!!",
      }),
    Error,
    "ATTESTO_ENCRYPTION_KEY",
  );
});

// ─── Retention + payload persistence ─────────────────────────────────────────

Deno.test("loadConfig: retention is off by default, so an upgrade changes nothing", () => {
  const config = loadConfig(VALID_ENV);

  assertEquals(config.WEBHOOK_EVENT_RETENTION_DAYS, null);
  assertEquals(config.VALIDATION_AUDIT_RETENTION_DAYS, null);
  assertEquals(config.GOOGLE_CHAIN_RETENTION_DAYS, null);
  assertEquals(config.WEBHOOK_PERSIST_RAW_PAYLOAD, true);
  assertEquals(config.RETENTION_PURGE_INTERVAL_HOURS, 24);
});

Deno.test("loadConfig: retention windows are read as day counts", () => {
  const config = loadConfig({
    ...VALID_ENV,
    WEBHOOK_EVENT_RETENTION_DAYS: "90",
    VALIDATION_AUDIT_RETENTION_DAYS: "30",
    GOOGLE_CHAIN_RETENTION_DAYS: "365",
    RETENTION_PURGE_INTERVAL_HOURS: "6",
  });

  assertEquals(config.WEBHOOK_EVENT_RETENTION_DAYS, 90);
  assertEquals(config.VALIDATION_AUDIT_RETENTION_DAYS, 30);
  assertEquals(config.GOOGLE_CHAIN_RETENTION_DAYS, 365);
  assertEquals(config.RETENTION_PURGE_INTERVAL_HOURS, 6);
});

Deno.test("loadConfig: a zero or negative retention window is rejected, not read as off", () => {
  // "0 days" would be an easy way to mean "delete everything immediately".
  // Fail at boot rather than silently wiping a table.
  assertThrows(() => loadConfig({ ...VALID_ENV, WEBHOOK_EVENT_RETENTION_DAYS: "0" }), Error);
  assertThrows(() => loadConfig({ ...VALID_ENV, VALIDATION_AUDIT_RETENTION_DAYS: "-1" }), Error);
});

Deno.test("loadConfig: raw webhook payload persistence can be switched off", () => {
  const config = loadConfig({ ...VALID_ENV, WEBHOOK_PERSIST_RAW_PAYLOAD: "false" });

  assertEquals(config.WEBHOOK_PERSIST_RAW_PAYLOAD, false);
});

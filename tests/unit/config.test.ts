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

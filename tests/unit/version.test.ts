import { assert, assertEquals } from "@std/assert";
import { ATTESTO_VERSION_HEADER, VERSION } from "@/lib/version.ts";

Deno.test("ATTESTO_VERSION_HEADER is the canonical header name", () => {
  assertEquals(ATTESTO_VERSION_HEADER, "X-Attesto-Version");
});

Deno.test("VERSION is a non-empty string (defaults to 'dev' without the env var)", () => {
  assert(typeof VERSION === "string" && VERSION.length > 0);
  // The test runner does not set ATTESTO_VERSION, so it falls back to "dev".
  assertEquals(VERSION, "dev");
});

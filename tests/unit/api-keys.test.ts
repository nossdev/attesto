import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  API_KEY_PREFIXES,
  generateApiKey,
  hashApiKey,
  parseApiKeyEnvironment,
} from "@/services/tenants/api-keys.ts";

Deno.test("generateApiKey(live) returns attesto_live_<base64url>, unique each call", async () => {
  const a = await generateApiKey("live");
  const b = await generateApiKey("live");
  assert(a.raw.startsWith("attesto_live_"));
  assert(b.raw.startsWith("attesto_live_"));
  assertNotEquals(a.raw, b.raw);
});

Deno.test("generateApiKey(test) uses the test prefix", async () => {
  const key = await generateApiKey("test");
  assert(key.raw.startsWith("attesto_test_"));
});

Deno.test("generateApiKey produces ≥ 32 bytes of entropy in the random suffix", async () => {
  const key = await generateApiKey("live");
  const suffix = key.raw.slice(API_KEY_PREFIXES.live.length);
  // base64url of 32 bytes is 43 chars (no padding).
  assertEquals(suffix.length, 43);
  // Only base64url alphabet.
  assert(/^[A-Za-z0-9_-]{43}$/.test(suffix));
});

Deno.test("generateApiKey hashes match what hashApiKey returns", async () => {
  const key = await generateApiKey("live");
  const h = await hashApiKey(key.raw);
  assertEquals(h, key.hash);
});

Deno.test("generateApiKey prefix is first 8 chars of suffix (for UI identification)", async () => {
  const key = await generateApiKey("live");
  const suffix = key.raw.slice(API_KEY_PREFIXES.live.length);
  assertEquals(key.keyPrefix, suffix.slice(0, 8));
});

Deno.test("hashApiKey is deterministic and 64 hex chars (SHA-256)", async () => {
  const a = await hashApiKey("attesto_live_abcdef");
  const b = await hashApiKey("attesto_live_abcdef");
  assertEquals(a, b);
  assert(/^[0-9a-f]{64}$/.test(a));
});

Deno.test("hashApiKey differs for different inputs", async () => {
  const a = await hashApiKey("attesto_live_aaa");
  const b = await hashApiKey("attesto_live_bbb");
  assertNotEquals(a, b);
});

Deno.test("parseApiKeyEnvironment identifies live / test / unknown", () => {
  assertEquals(parseApiKeyEnvironment("attesto_live_abc"), "live");
  assertEquals(parseApiKeyEnvironment("attesto_test_abc"), "test");
  assertEquals(parseApiKeyEnvironment("bearer_abc"), null);
  assertEquals(parseApiKeyEnvironment(""), null);
});

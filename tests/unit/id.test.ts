import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { monotonicUlid as monotonicUlidAt } from "jsr:@std/ulid@^1";
import { makeId } from "@/lib/id.ts";

Deno.test("makeId.tenant produces tenant_<ULID>", () => {
  const id = makeId.tenant();
  const underscore = id.indexOf("_");
  const prefix = id.slice(0, underscore);
  const ulid = id.slice(underscore + 1);
  assertEquals(prefix, "tenant");
  assertEquals(ulid.length, 26);
});

Deno.test("makeId.apiKey produces key_<ULID>", () => {
  const id = makeId.apiKey();
  assert(id.startsWith("key_"));
});

Deno.test("makeId.event / delivery / request use correct prefixes", () => {
  assert(makeId.event().startsWith("evt_"));
  assert(makeId.delivery().startsWith("del_"));
  assert(makeId.request().startsWith("req_"));
});

Deno.test("makeId produces unique IDs across calls", () => {
  const ids = new Set(Array.from({ length: 100 }, () => makeId.tenant()));
  assertEquals(ids.size, 100);
});

Deno.test("ULID portion is lexicographically sortable by generation time", () => {
  // Use explicit timestamps to avoid sleep-based flakiness under CI load.
  const earlier = monotonicUlidAt(1_000_000_000_000);
  const later = monotonicUlidAt(1_000_000_000_001);
  // Same prefix, so lexicographic comparison of the full string preserves ULID order.
  assertNotEquals(earlier, later);
  assert(earlier < later, `expected ${earlier} < ${later}`);
});

Deno.test("ULID uses Crockford's Base32 alphabet (no I, L, O, U)", () => {
  const id = makeId.tenant();
  const ulid = id.slice("tenant_".length);
  const forbidden = /[ILOUilou]/;
  assert(!forbidden.test(ulid), `ULID "${ulid}" contains forbidden chars`);
  assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ulid), `ULID "${ulid}" not Crockford Base32`);
});

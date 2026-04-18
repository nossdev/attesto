import { assert, assertEquals } from "@std/assert";
import { createTtlCache } from "@/lib/ttl-cache.ts";

Deno.test("ttl-cache: set/get within TTL returns value", () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  cache.set("k", 42);
  assertEquals(cache.get("k"), 42);
});

Deno.test("ttl-cache: get past TTL returns undefined and evicts", () => {
  let t = 0;
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => t });
  cache.set("k", 42);
  t = 1001;
  assertEquals(cache.get("k"), undefined);
  assertEquals(cache.size(), 0);
});

Deno.test("ttl-cache: loadOrFetch uses cache on hit, fetch on miss", async () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  let fetches = 0;
  const loader = () => {
    fetches++;
    return Promise.resolve(7);
  };
  assertEquals(await cache.loadOrFetch("k", loader), 7);
  assertEquals(await cache.loadOrFetch("k", loader), 7);
  assertEquals(fetches, 1);
});

Deno.test("ttl-cache: loadOrFetch dedupes concurrent misses (one loader call)", async () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  let fetches = 0;
  let resolve: (v: number) => void = () => {};
  const loader = () => {
    fetches++;
    return new Promise<number>((r) => {
      resolve = r;
    });
  };
  const p1 = cache.loadOrFetch("k", loader);
  const p2 = cache.loadOrFetch("k", loader);
  const p3 = cache.loadOrFetch("k", loader);
  resolve(99);
  assertEquals(await p1, 99);
  assertEquals(await p2, 99);
  assertEquals(await p3, 99);
  assertEquals(fetches, 1);
});

Deno.test("ttl-cache: failed fetch is not cached (next call retries)", async () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  let attempts = 0;
  const loader = () => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error("transient"));
    return Promise.resolve(3);
  };
  let threw = false;
  try {
    await cache.loadOrFetch("k", loader);
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(await cache.loadOrFetch("k", loader), 3);
  assertEquals(attempts, 2);
});

Deno.test("ttl-cache: delete removes key", () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  cache.set("k", 1);
  cache.delete("k");
  assertEquals(cache.get("k"), undefined);
});

Deno.test("ttl-cache: clear empties everything", () => {
  const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 100 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assertEquals(cache.size(), 0);
});

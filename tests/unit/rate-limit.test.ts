import { assert, assertEquals, assertRejects } from "@std/assert";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { createRateLimiter } from "@/middleware/rate-limit.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { AppError } from "@/lib/errors.ts";
import type { AuthContext } from "@/middleware/auth.ts";
import type { ApiKey, Tenant } from "@/db/schema.ts";

function fakeAuth(tenantId: string): AuthContext {
  return {
    tenant: {
      id: tenantId,
      name: "t",
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: true,
    } as Tenant,
    apiKey: {
      id: "key_x",
      tenantId,
      keyHash: "",
      keyPrefix: "",
      name: null,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    } as ApiKey,
  };
}

function buildApp(refillPerSecond: number, burst: number, now: () => number, tenantId: string) {
  const limiter = createRateLimiter({ refillPerSecond, burst, now });
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", async (c, next) => {
    c.set("auth", fakeAuth(tenantId));
    await next();
  });
  app.use("*", limiter.middleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  return { app, limiter };
}

Deno.test("rate-limit: first burst of requests all pass", async () => {
  const { app } = buildApp(10, 5, () => 1_000_000_000_000, "tenant_a");
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/ping");
    assertEquals(res.status, 200);
  }
});

Deno.test("rate-limit: depleting the bucket returns 429 with Retry-After", async () => {
  const t = 1_000_000_000_000;
  const { app } = buildApp(10, 3, () => t, "tenant_a");
  // Consume the burst.
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/ping");
    assertEquals(res.status, 200);
  }
  // Next request should be rate-limited (no time elapsed → no refill).
  const res = await app.request("/ping");
  assertEquals(res.status, 429);
  const retry = res.headers.get("Retry-After");
  assert(retry !== null);
  const retrySec = Number(retry);
  assert(retrySec >= 1, `Retry-After should be ≥ 1, got ${retry}`);
  const body = await res.json();
  assertEquals(body.error, "RATE_LIMITED");
});

Deno.test("rate-limit: bucket refills over time", async () => {
  let t = 1_000_000_000_000;
  const { app } = buildApp(10, 3, () => t, "tenant_a");
  for (let i = 0; i < 3; i++) await app.request("/ping");
  // Empty now. Wait 200ms worth of refill at 10/s = 2 tokens.
  t += 200;
  const r1 = await app.request("/ping");
  const r2 = await app.request("/ping");
  const r3 = await app.request("/ping");
  assertEquals(r1.status, 200);
  assertEquals(r2.status, 200);
  assertEquals(r3.status, 429);
});

Deno.test("rate-limit: burst cap prevents unbounded accumulation", async () => {
  let t = 1_000_000_000_000;
  const { app, limiter } = buildApp(10, 5, () => t, "tenant_a");
  // Let 10 seconds pass before the first call — refill would mathematically
  // give 100 tokens, but cap is 5.
  t += 10_000;
  await app.request("/ping");
  const bucket = limiter.peek("tenant_a");
  assert(bucket);
  assert(bucket.tokens <= 5, `expected ≤ burst=5, got ${bucket.tokens}`);
});

Deno.test("rate-limit: separate tenants have separate buckets", async () => {
  const t = 1_000_000_000_000;
  const limiter = createRateLimiter({ refillPerSecond: 10, burst: 2, now: () => t });
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  let currentTenant = "tenant_a";
  app.use("*", async (c, next) => {
    c.set("auth", fakeAuth(currentTenant));
    await next();
  });
  app.use("*", limiter.middleware);
  app.get("/ping", (c) => c.json({ ok: true }));

  // Tenant A burns their bucket.
  for (let i = 0; i < 2; i++) await app.request("/ping");
  const limitedA = await app.request("/ping");
  assertEquals(limitedA.status, 429);

  // Tenant B starts fresh.
  currentTenant = "tenant_b";
  const okB = await app.request("/ping");
  assertEquals(okB.status, 200);
});

Deno.test("rate-limit: missing auth context throws INTERNAL_ERROR (misrouted)", async () => {
  const limiter = createRateLimiter({ refillPerSecond: 10, burst: 5, now: () => 0 });
  // Middleware expects Hono env with `auth`. Call the handler directly with
  // no auth set to exercise the fail-closed path.
  const c = {
    get: (_key: string) => undefined,
    header: (_k: string, _v: string) => {},
    req: {},
    res: { headers: new Headers() },
  } as unknown as Parameters<typeof limiter.middleware>[0];
  await assertRejects(
    () =>
      (limiter.middleware as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
        c,
        () => Promise.resolve(),
      ),
    AppError,
    "auth context",
  );
});

// ─── Per-route cost ───────────────────────────────────────────────────────────

function buildCostApp(
  refillPerSecond: number,
  burst: number,
  now: () => number,
  costFor: (path: string) => number,
) {
  const limiter = createRateLimiter({ refillPerSecond, burst, now, costFor });
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", async (c, next) => {
    c.set("auth", fakeAuth("tenant_cost"));
    await next();
  });
  app.use("*", limiter.middleware);
  app.get("/cheap", (c) => c.json({ ok: true }));
  app.get("/expensive", (c) => c.json({ ok: true }));
  return { app, limiter };
}

const costly = (path: string) => path.endsWith("/expensive") ? 10 : 1;

Deno.test("rate-limit: an expensive route consumes its full cost in one request", async () => {
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 20, () => t, costly);

  assertEquals((await app.request("/expensive")).status, 200);

  // 20 burst - 10 = 10 left, not 19.
  assertEquals(limiter.peek("tenant_cost")?.tokens, 10);
});

Deno.test("rate-limit: a cheap route still costs one token", async () => {
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 20, () => t, costly);

  await app.request("/cheap");

  assertEquals(limiter.peek("tenant_cost")?.tokens, 19);
});

Deno.test("rate-limit: a bucket that cannot cover the cost is refused, not overdrawn", async () => {
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 15, () => t, costly);

  assertEquals((await app.request("/expensive")).status, 200); // 15 -> 5
  const res = await app.request("/expensive"); // needs 10, has 5

  assertEquals(res.status, 429);
  // Refused, so the tokens are untouched — a rejected request must not
  // leave the bucket emptier than it found it.
  assertEquals(limiter.peek("tenant_cost")?.tokens, 5);
});

Deno.test("rate-limit: Retry-After reflects the cost, not a single token", async () => {
  const t = 1_000_000_000_000;
  const { app } = buildCostApp(1, 15, () => t, costly);

  await app.request("/expensive"); // 15 -> 5
  const res = await app.request("/expensive"); // short by 5, refilling 1/s

  assertEquals(res.status, 429);
  assertEquals(Number(res.headers.get("Retry-After")), 5);
});

Deno.test("rate-limit: a cost above the burst is clamped so the route stays reachable", async () => {
  // A misconfigured cost larger than the bucket could never be paid, and
  // the route would 429 forever. Clamp instead of bricking it.
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 4, () => t, costly);

  assertEquals((await app.request("/expensive")).status, 200);

  assertEquals(limiter.peek("tenant_cost")?.tokens, 0);
});

Deno.test("rate-limit: with no costFor, every route costs one token", async () => {
  const t = 1_000_000_000_000;
  const { app, limiter } = buildApp(10, 5, () => t, "tenant_a");

  await app.request("/ping");

  assertEquals(limiter.peek("tenant_a")?.tokens, 4);
});

// ─── Cost keyed on the path the router matched ───────────────────────────────

/** Mirrors the real app: a sub-app mounted at /v1, limiter on /google/*. */
function buildMountedApp(burst: number, costFor: (path: string) => number) {
  const t = 1_000_000_000_000;
  const limiter = createRateLimiter({ refillPerSecond: 1, burst, now: () => t, costFor });
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  const sub = new Hono<HonoEnv>();
  sub.use("/google/*", async (c, next) => {
    c.set("auth", fakeAuth("tenant_path"));
    await next();
  });
  sub.use("/google/*", limiter.middleware);
  sub.post("/google/purchase-voided", (c) => c.json({ ok: true }));
  app.route("/v1", sub);
  return { app, limiter };
}

const scanCost = (path: string) => path === "/v1/google/purchase-voided" ? 25 : 1;

Deno.test("rate-limit: the expensive route is charged its cost through a mounted sub-app", async () => {
  const { app, limiter } = buildMountedApp(100, scanCost);

  const res = await app.request("/v1/google/purchase-voided", { method: "POST" });

  assertEquals(res.status, 200);
  assertEquals(limiter.peek("tenant_path")?.tokens, 75);
});

Deno.test("rate-limit: a percent-encoded path cannot dodge the cost", async () => {
  // Hono's router percent-decodes before matching, so this reaches the
  // same handler. Pricing off the undecoded URL would charge 1 token for
  // a 25-token route — an authenticated caller could write %2D for the
  // hyphen and get ~25x the upstream fan-out their rate allows.
  const { app, limiter } = buildMountedApp(100, scanCost);

  const res = await app.request("/v1/google/purchase%2Dvoided", { method: "POST" });

  assertEquals(res.status, 200, "the request still reaches the handler");
  assertEquals(limiter.peek("tenant_path")?.tokens, 75, "so it must still cost 25");
});

// ─── Hostile cost functions ──────────────────────────────────────────────────

Deno.test("rate-limit: a NaN cost cannot poison the bucket forever", async () => {
  // Math.max(1, NaN) is NaN; `tokens < NaN` is false, so the request would
  // pass AND write NaN into the bucket, after which every comparison is
  // false and the tenant is unlimited for the life of the process.
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 5, () => t, () => Number.NaN);

  for (let i = 0; i < 6; i++) await app.request("/cheap");

  const tokens = limiter.peek("tenant_cost")?.tokens ?? Number.NaN;
  assert(Number.isFinite(tokens), `bucket poisoned: ${tokens}`);
  assertEquals((await app.request("/cheap")).status, 429);
});

Deno.test("rate-limit: an Infinity cost does not brick the route", async () => {
  const t = 1_000_000_000_000;
  const { app, limiter } = buildCostApp(10, 5, () => t, () => Number.POSITIVE_INFINITY);

  assertEquals((await app.request("/cheap")).status, 200);
  assert(Number.isFinite(limiter.peek("tenant_cost")?.tokens ?? Number.NaN));
});

Deno.test("rate-limit: a burst below one still denies rather than allowing everything", async () => {
  // Clamping cost to a sub-1 burst would make `tokens < cost` false and
  // turn the limiter into a no-op — the opposite of its job.
  const t = 1_000_000_000_000;
  const { app } = buildCostApp(10, 0.5, () => t, () => 1);

  assertEquals((await app.request("/cheap")).status, 429);
});

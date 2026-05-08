import { assert, assertEquals } from "@std/assert";
import { createApp } from "@/app.ts";
import type { Database } from "@/db/client.ts";

type Captured = Record<string, unknown>;

async function captureStdout<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; entries: Captured[] }> {
  const entries: Captured[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const raw = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    try {
      entries.push(JSON.parse(raw));
    } catch {
      // non-JSON log lines (should not happen in Attesto) — record the raw
      entries.push({ raw });
    }
  };
  try {
    const result = await fn();
    return { result, entries };
  } finally {
    console.log = original;
  }
}

function findRequestEntry(entries: Captured[]): Captured {
  const entry = entries.find((e) => e.msg === "request");
  if (!entry) throw new Error("expected an access-log 'request' entry, found none");
  return entry;
}

Deno.test("accessLog: emits structured JSON with method, path, status, duration", async () => {
  const app = createApp();
  const { entries } = await captureStdout(() => app.request("/health"));
  const entry = findRequestEntry(entries);
  assertEquals(entry.level, "info");
  assertEquals(entry.method, "GET");
  assertEquals(entry.path, "/health");
  assertEquals(entry.status, 200);
  assert(typeof entry.durationMs === "number");
  assert(typeof entry.ts === "string" && !isNaN(Date.parse(entry.ts as string)));
});

Deno.test("accessLog: includes request id on every entry", async () => {
  const app = createApp();
  const { entries } = await captureStdout(() =>
    app.request("/health", { headers: { "X-Request-Id": "trace-42" } })
  );
  const entry = findRequestEntry(entries);
  assertEquals(entry.requestId, "trace-42");
});

Deno.test("accessLog: logs 4xx on unknown route", async () => {
  const app = createApp();
  const { entries } = await captureStdout(() => app.request("/nope"));
  const entry = findRequestEntry(entries);
  assertEquals(entry.status, 404);
  assertEquals(entry.path, "/nope");
});

Deno.test("accessLog: path does not include querystring or fragment", async () => {
  const app = createApp();
  const { entries } = await captureStdout(() => app.request("/health?x=1"));
  const entry = findRequestEntry(entries);
  assertEquals(entry.path, "/health");
});

Deno.test("accessLog: tenantId is null on unauthenticated routes", async () => {
  const app = createApp();
  const { entries } = await captureStdout(() => app.request("/health"));
  const entry = findRequestEntry(entries);
  assertEquals(entry.tenantId, null);
});

Deno.test("accessLog: emits a request entry on auth-failure 401", async () => {
  // Reaches the auth middleware (which throws before touching the DB),
  // so the stub Database is never called. The regression we're guarding
  // is that without try/finally Hono's onError short-circuit skipped
  // the post-await branch in accessLog and emitted no log line at all.
  const stubDb = {} as Database;
  const app = createApp({ authenticated: { db: stubDb } });
  const { entries } = await captureStdout(() => app.request("/v1/apple/probe"));
  const entry = findRequestEntry(entries);
  assertEquals(entry.status, 401);
  assertEquals(entry.path, "/v1/apple/probe");
  assertEquals(entry.tenantId, null);
});

Deno.test("accessLog: tenantId is captured on inbound webhook routes from URL path", async () => {
  // Inbound webhook routes don't go through API-key auth — Apple/Google
  // sign their requests cryptographically. Without explicit context
  // wiring the access log would show `tenantId: null` even though the
  // tenant ID is right there in the URL. Regression locks down the fix.
  //
  // The stub deps mean this request will fail at the DB lookup
  // (`assertActiveTenant`) — that's fine. `c.set("tenantId", ...)` runs
  // BEFORE the lookup, so the access log captures the attempted tenant
  // even on a 404/500 response. That ordering is intentional, see the
  // inline comment in `app/routes/webhooks.ts`.
  const stubDb = {} as Database;
  const app = createApp({
    webhooks: {
      db: stubDb,
      // deno-lint-ignore no-explicit-any
      appleVerifierCache: {} as any,
      // deno-lint-ignore no-explicit-any
      googleOidcVerifier: {} as any,
    },
  });
  const validTenantId = "tenant_01KQE0VSMK488KMK3JS4CFSP1D";
  const { entries } = await captureStdout(() =>
    app.request(`/v1/webhooks/apple/${validTenantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  const entry = findRequestEntry(entries);
  assertEquals(entry.path, `/v1/webhooks/apple/${validTenantId}`);
  assertEquals(entry.tenantId, validTenantId);
});

Deno.test("accessLog: tenantId is captured on Google webhook routes too", async () => {
  // Symmetric coverage with the Apple webhook test above. Catches the
  // case where someone removes `c.set("tenantId", ...)` from one
  // handler but not the other.
  const stubDb = {} as Database;
  const app = createApp({
    webhooks: {
      db: stubDb,
      // deno-lint-ignore no-explicit-any
      appleVerifierCache: {} as any,
      // deno-lint-ignore no-explicit-any
      googleOidcVerifier: {} as any,
    },
  });
  const validTenantId = "tenant_01KQE0VSMK488KMK3JS4CFSP1D";
  const { entries } = await captureStdout(() =>
    app.request(`/v1/webhooks/google/${validTenantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  const entry = findRequestEntry(entries);
  assertEquals(entry.path, `/v1/webhooks/google/${validTenantId}`);
  assertEquals(entry.tenantId, validTenantId);
});

Deno.test("accessLog: tenantId stays null when webhook tenant_id format is invalid", async () => {
  // Format check runs BEFORE c.set("tenantId", ...). A malformed
  // tenantId produces a 400 with no tenant context in the log — the
  // attacker-supplied path segment doesn't get promoted into a
  // first-class log field.
  const stubDb = {} as Database;
  const app = createApp({
    webhooks: {
      db: stubDb,
      // deno-lint-ignore no-explicit-any
      appleVerifierCache: {} as any,
      // deno-lint-ignore no-explicit-any
      googleOidcVerifier: {} as any,
    },
  });
  const { entries } = await captureStdout(() =>
    app.request("/v1/webhooks/apple/not-a-tenant-id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  );
  const entry = findRequestEntry(entries);
  assertEquals(entry.status, 400);
  assertEquals(entry.path, "/v1/webhooks/apple/not-a-tenant-id");
  assertEquals(entry.tenantId, null);
});

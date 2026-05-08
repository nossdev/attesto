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

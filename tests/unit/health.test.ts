import { assertEquals } from "@std/assert";
import { createApp } from "@/app.ts";

Deno.test("GET /health returns 200 and status ok", async () => {
  const app = createApp();
  const res = await app.request("/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { status: "ok" });
});

Deno.test("GET /health sets X-Request-Id header", async () => {
  const app = createApp();
  const res = await app.request("/health");
  const reqId = res.headers.get("X-Request-Id");
  if (!reqId) throw new Error("expected X-Request-Id header to be set");
  if (reqId.length < 10) throw new Error(`request id suspiciously short: "${reqId}"`);
});

Deno.test("GET /health propagates incoming X-Request-Id", async () => {
  const app = createApp();
  const res = await app.request("/health", {
    headers: { "X-Request-Id": "test-req-123" },
  });
  assertEquals(res.headers.get("X-Request-Id"), "test-req-123");
});

Deno.test("GET /ready fails closed when no dependencies are wired", async () => {
  const app = createApp();
  const res = await app.request("/ready");
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
  assertEquals(body.checks, {});
});

Deno.test("GET /ready returns ok when decryption key check passes", async () => {
  const app = createApp({ decryptionKeyOk: () => true });
  const res = await app.request("/ready");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.checks.encryption, "ok");
});

Deno.test("GET /ready returns degraded when decryption key check fails", async () => {
  const app = createApp({ decryptionKeyOk: () => false });
  const res = await app.request("/ready");
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
  assertEquals(body.checks.encryption, "fail");
});

Deno.test("unknown route returns 404", async () => {
  const app = createApp();
  const res = await app.request("/does-not-exist");
  assertEquals(res.status, 404);
});

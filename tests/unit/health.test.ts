import { assert, assertEquals } from "@std/assert";
import { createApp } from "@/app.ts";
import { ATTESTO_VERSION_HEADER } from "@/lib/version.ts";

Deno.test("GET /health returns 200, status ok, and the build version", async () => {
  const app = createApp({ version: "v9.9.9" });
  const res = await app.request("/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok", version: "v9.9.9" });
  assertEquals(res.headers.get(ATTESTO_VERSION_HEADER), "v9.9.9");
});

Deno.test("GET /health defaults the version to 'dev' when none is supplied", async () => {
  const app = createApp();
  const res = await app.request("/health");
  const body = await res.json();
  assertEquals(body.version, "dev");
  assertEquals(res.headers.get(ATTESTO_VERSION_HEADER), "dev");
});

Deno.test("GET /health sets X-Request-Id header", async () => {
  const app = createApp();
  const res = await app.request("/health");
  const reqId = res.headers.get("X-Request-Id");
  assert(reqId, "expected X-Request-Id header to be set");
  assert(reqId.length >= 10, `request id suspiciously short: "${reqId}"`);
});

Deno.test("GET /health propagates incoming X-Request-Id", async () => {
  const app = createApp();
  const res = await app.request("/health", {
    headers: { "X-Request-Id": "test-req-123" },
  });
  assertEquals(res.headers.get("X-Request-Id"), "test-req-123");
});

Deno.test("GET /ready fails closed when no dependencies are wired", async () => {
  const app = createApp({ version: "v1.2.3" });
  const res = await app.request("/ready");
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
  assertEquals(body.version, "v1.2.3");
  assertEquals(body.checks, {});
  assertEquals(res.headers.get(ATTESTO_VERSION_HEADER), "v1.2.3");
});

Deno.test("GET /ready returns ok (with version) when decryption key check passes", async () => {
  const app = createApp({ version: "v1.2.3", decryptionKeyOk: () => true });
  const res = await app.request("/ready");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.version, "v1.2.3");
  assertEquals(body.checks.encryption, "ok");
  assertEquals(res.headers.get(ATTESTO_VERSION_HEADER), "v1.2.3");
});

Deno.test("GET /ready returns degraded when decryption key check fails", async () => {
  const app = createApp({ decryptionKeyOk: () => false });
  const res = await app.request("/ready");
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
  assertEquals(body.checks.encryption, "fail");
});

Deno.test("unknown route returns 404 and still carries X-Attesto-Version", async () => {
  const app = createApp({ version: "v0.0.0" });
  const res = await app.request("/does-not-exist");
  assertEquals(res.status, 404);
  assertEquals(res.headers.get(ATTESTO_VERSION_HEADER), "v0.0.0");
});

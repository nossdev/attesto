import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createApp } from "@/app.ts";
import { isSafeRequestId, REQUEST_ID_HEADER } from "@/middleware/request-id.ts";

// ─── Regex-level tests ────────────────────────────────────────────────────────
// These validate the security policy directly. HTTP layer already rejects some
// of the nastiest inputs (CRLF, unicode) before they reach middleware; these
// tests prove we'd reject them anyway if an adversary bypassed the HTTP parser.

Deno.test("isSafeRequestId: accepts ULID-like value", () => {
  assert(isSafeRequestId("req_01HY7NGCYCZNQWV2KXQ0Z5EDNN"));
});

Deno.test("isSafeRequestId: accepts [A-Za-z0-9_-] only", () => {
  for (const ok of ["abc", "A-Z_0-9", "trace-42", "--_-_", "x".repeat(128)]) {
    assert(isSafeRequestId(ok), `should accept "${ok}"`);
  }
});

Deno.test("isSafeRequestId: rejects empty and undefined", () => {
  assert(!isSafeRequestId(""));
  assert(!isSafeRequestId(undefined));
});

Deno.test("isSafeRequestId: rejects CRLF (log-injection vector)", () => {
  assert(!isSafeRequestId("normal\r\ninjected"));
  assert(!isSafeRequestId("\n"));
  assert(!isSafeRequestId("\r"));
});

Deno.test("isSafeRequestId: rejects ANSI escapes", () => {
  assert(!isSafeRequestId("\u001b[31mred\u001b[0m"));
});

Deno.test("isSafeRequestId: rejects non-ASCII", () => {
  assert(!isSafeRequestId("unicode-☃"));
  assert(!isSafeRequestId("café"));
});

Deno.test("isSafeRequestId: rejects spaces, dots, slashes, and other punctuation", () => {
  for (const bad of ["a b c", "has.dot", "has/slash", "has#hash", "semi;colon", "a:b"]) {
    assert(!isSafeRequestId(bad), `should reject "${bad}"`);
  }
});

Deno.test("isSafeRequestId: rejects values longer than 128 chars", () => {
  assert(!isSafeRequestId("a".repeat(129)));
  assert(isSafeRequestId("a".repeat(128)));
});

// ─── End-to-end middleware tests ──────────────────────────────────────────────
// These use HTTP-valid but policy-invalid headers to exercise the middleware
// through a real Hono request cycle.

async function getRequestId(headers: HeadersInit = {}): Promise<string> {
  const app = createApp();
  const res = await app.request("/health", { headers });
  const id = res.headers.get(REQUEST_ID_HEADER);
  if (!id) throw new Error("missing request id header");
  return id;
}

Deno.test("request-id middleware: mints req_<ULID> when header missing", async () => {
  const id = await getRequestId();
  assert(id.startsWith("req_"), `expected req_ prefix, got "${id}"`);
  assertEquals(id.length, "req_".length + 26);
});

Deno.test("request-id middleware: passes through safe incoming header", async () => {
  const safe = "trace-abc_123-XYZ";
  const id = await getRequestId({ [REQUEST_ID_HEADER]: safe });
  assertEquals(id, safe);
});

Deno.test("request-id middleware: rejects HTTP-valid-but-policy-invalid chars", async () => {
  // These are valid HTTP header bytes (printable ASCII) but violate our regex.
  for (const bad of ["a b c", "has.dot", "has/slash", "has#hash", "semi;colon"]) {
    const id = await getRequestId({ [REQUEST_ID_HEADER]: bad });
    assertNotEquals(id, bad);
    assert(id.startsWith("req_"), `expected mint for "${bad}", got "${id}"`);
  }
});

Deno.test("request-id middleware: rejects header longer than 128 chars", async () => {
  const tooLong = "a".repeat(129);
  const id = await getRequestId({ [REQUEST_ID_HEADER]: tooLong });
  assert(id.startsWith("req_"));
  assertNotEquals(id, tooLong);
});

Deno.test("request-id middleware: rejects empty header and mints new id", async () => {
  const id = await getRequestId({ [REQUEST_ID_HEADER]: "" });
  assert(id.startsWith("req_"));
});

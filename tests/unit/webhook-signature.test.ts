import { assert, assertEquals } from "@std/assert";
import {
  ATTESTO_SIGNATURE_HEADER,
  signWebhook,
  verifyWebhookSignature,
} from "@/services/webhooks/signature.ts";

Deno.test("signWebhook produces t=<ts>,v1=<hex> header", async () => {
  const { headerValue, timestamp, signature } = await signWebhook({
    secret: "shh",
    body: "{}",
    timestamp: 1_700_000_000,
  });
  assertEquals(timestamp, 1_700_000_000);
  assert(/^[0-9a-f]{64}$/.test(signature), `expected 64-hex signature, got ${signature}`);
  assertEquals(headerValue, `t=1700000000,v1=${signature}`);
});

Deno.test("signWebhook: same input → same signature; different timestamps → different", async () => {
  const a = await signWebhook({ secret: "s", body: "b", timestamp: 100 });
  const b = await signWebhook({ secret: "s", body: "b", timestamp: 100 });
  const c = await signWebhook({ secret: "s", body: "b", timestamp: 101 });
  assertEquals(a.signature, b.signature);
  assert(a.signature !== c.signature);
});

Deno.test("signWebhook: different secret → different signature", async () => {
  const a = await signWebhook({ secret: "s1", body: "b", timestamp: 100 });
  const b = await signWebhook({ secret: "s2", body: "b", timestamp: 100 });
  assert(a.signature !== b.signature);
});

Deno.test("verifyWebhookSignature: accepts matching signature within skew window", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_000 });
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: signed.headerValue,
    nowMs: 1_700_000_010 * 1000,
  });
  assertEquals(r, { valid: true });
});

Deno.test("verifyWebhookSignature: rejects missing header", async () => {
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: undefined,
  });
  assertEquals(r.valid, false);
  assertEquals(r.reason, "missing_header");
});

Deno.test("verifyWebhookSignature: rejects malformed header (missing v1)", async () => {
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: "t=1700000000",
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "malformed_header");
});

Deno.test("verifyWebhookSignature: rejects malformed header (non-numeric timestamp)", async () => {
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: "t=abc,v1=1234",
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "malformed_header");
});

Deno.test("verifyWebhookSignature: rejects non-hex v1", async () => {
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: "t=1700000000,v1=ZZZZ",
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "malformed_header");
});

Deno.test("verifyWebhookSignature: rejects timestamp more than 5 minutes old", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_000 });
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: signed.headerValue,
    nowMs: (1_700_000_000 + 301) * 1000, // +5:01
  });
  assertEquals(r.reason, "timestamp_out_of_window");
});

Deno.test("verifyWebhookSignature: rejects future timestamp beyond skew", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_301 });
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: signed.headerValue,
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "timestamp_out_of_window");
});

Deno.test("verifyWebhookSignature: rejects on body tamper", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_000 });
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: '{"tampered":true}',
    headerValue: signed.headerValue,
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "signature_mismatch");
});

Deno.test("verifyWebhookSignature: rejects on secret mismatch", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_000 });
  const r = await verifyWebhookSignature({
    secret: "different",
    body: "{}",
    headerValue: signed.headerValue,
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.reason, "signature_mismatch");
});

Deno.test("verifyWebhookSignature: case-insensitive hex on v1", async () => {
  const signed = await signWebhook({ secret: "shh", body: "{}", timestamp: 1_700_000_000 });
  const uppercased = signed.headerValue.replace(
    /v1=([0-9a-f]+)/,
    (_, hex) => `v1=${hex.toUpperCase()}`,
  );
  const r = await verifyWebhookSignature({
    secret: "shh",
    body: "{}",
    headerValue: uppercased,
    nowMs: 1_700_000_000 * 1000,
  });
  assertEquals(r.valid, true);
});

Deno.test("header constant exported for clients", () => {
  assertEquals(ATTESTO_SIGNATURE_HEADER, "X-Attesto-Signature");
});

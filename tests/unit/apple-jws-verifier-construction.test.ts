import { assert, assertEquals, assertRejects } from "@std/assert";
import { createAppleJwsVerifierCache } from "@/services/apple/jws-verifier.ts";

// Construction-only tests for the SignedDataVerifier wrapper:
//   - SDK requires appAppleId when env=production (throws "appAppleId is required")
//   - SDK ignores appAppleId for env=sandbox (no throw without it)
//   - Our cache key includes appAppleId so a tenant moving null → number gets
//     a fresh verifier (not the cached one constructed without it)
//
// Pass empty rootCertsOverride to skip on-disk cert loading — these tests
// exercise the construction path, not actual JWS verification.

const BUNDLE = "com.example.app";

Deno.test("apple jws cache: sandbox verifier constructs without appAppleId", async () => {
  const cache = createAppleJwsVerifierCache({
    enableOnlineChecks: false,
    rootCertsOverride: [],
  });
  const verifier = await cache.get(BUNDLE, "sandbox");
  assert(verifier !== undefined);
  assert(typeof verifier.verifyTransaction === "function");
});

Deno.test("apple jws cache: production verifier WITHOUT appAppleId throws", async () => {
  const cache = createAppleJwsVerifierCache({
    enableOnlineChecks: false,
    rootCertsOverride: [],
  });
  await assertRejects(
    () => cache.get(BUNDLE, "production"),
    Error,
    "appAppleId is required when the environment is Production",
  );
});

Deno.test("apple jws cache: production verifier WITH appAppleId constructs", async () => {
  const cache = createAppleJwsVerifierCache({
    enableOnlineChecks: false,
    rootCertsOverride: [],
  });
  const verifier = await cache.get(BUNDLE, "production", 1234567890);
  assert(verifier !== undefined);
  assert(typeof verifier.verifyTransaction === "function");
});

Deno.test("apple jws cache: same (bundle, env, appAppleId) returns same instance", async () => {
  const cache = createAppleJwsVerifierCache({
    enableOnlineChecks: false,
    rootCertsOverride: [],
  });
  const a = await cache.get(BUNDLE, "production", 1234567890);
  const b = await cache.get(BUNDLE, "production", 1234567890);
  assertEquals(a, b);
});

Deno.test("apple jws cache: different appAppleId values produce different instances", async () => {
  const cache = createAppleJwsVerifierCache({
    enableOnlineChecks: false,
    rootCertsOverride: [],
  });
  const a = await cache.get(BUNDLE, "production", 1234567890);
  const b = await cache.get(BUNDLE, "production", 9876543210);
  assert(a !== b, "verifier cache must key on appAppleId");
});

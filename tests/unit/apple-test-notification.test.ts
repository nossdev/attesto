import { assert, assertEquals, assertRejects } from "@std/assert";
import { AppleApiError } from "@/services/apple/client.ts";
import { requestAppleTestNotification } from "@/services/apple/test-notification.ts";
import type { AppleCredentialMaterial } from "@/services/apple/types.ts";

// We re-generate a throwaway P-256 .p8 per test rather than checking in a
// fixture key — see `apple-jwt-signer.test.ts` for the rationale. Since the
// real Apple endpoint is stubbed here, the JWT signature isn't validated, but
// we still need a valid PKCS#8 PEM so signAppStoreConnectJwt doesn't reject.
async function generateTestP8Pem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let raw = "";
  for (const byte of pkcs8) raw += String.fromCharCode(byte);
  const encoded = btoa(raw).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
}

async function makeMaterial(): Promise<AppleCredentialMaterial> {
  return {
    bundleId: "com.example.app",
    keyId: "ABC1234567",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    privateKeyPem: await generateTestP8Pem(),
    appAppleId: null,
  };
}

Deno.test("requestAppleTestNotification: hits sandbox URL with bearer JWT", async () => {
  const material = await makeMaterial();
  let capturedUrl: string | undefined;
  let capturedAuth: string | undefined;
  let capturedMethod: string | undefined;

  const fetchImpl: typeof fetch = (input, init) => {
    capturedUrl = typeof input === "string" ? input : (input as URL).toString();
    capturedMethod = init?.method;
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return Promise.resolve(
      new Response(JSON.stringify({ testNotificationToken: "tok_sandbox_abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const result = await requestAppleTestNotification({
    material,
    env: "sandbox",
    fetchImpl,
  });

  assertEquals(result.testNotificationToken, "tok_sandbox_abc");
  assertEquals(
    capturedUrl,
    "https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/test",
  );
  assertEquals(capturedMethod, "POST");
  assert(capturedAuth?.startsWith("Bearer "), "Authorization header must be a bearer token");
  // JWT shape: three base64url segments separated by '.'
  const token = capturedAuth!.slice("Bearer ".length);
  assertEquals(token.split(".").length, 3);
});

Deno.test("requestAppleTestNotification: production env routes to production host", async () => {
  const material = await makeMaterial();
  let capturedUrl: string | undefined;
  const fetchImpl: typeof fetch = (input) => {
    capturedUrl = typeof input === "string" ? input : (input as URL).toString();
    return Promise.resolve(
      new Response(JSON.stringify({ testNotificationToken: "tok_prod" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  await requestAppleTestNotification({ material, env: "production", fetchImpl });
  assertEquals(capturedUrl, "https://api.storekit.itunes.apple.com/inApps/v1/notifications/test");
});

Deno.test("requestAppleTestNotification: surfaces Apple errorCode on non-2xx JSON", async () => {
  const material = await makeMaterial();
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ errorCode: 4040007, errorMessage: "AccountNotFoundError" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

  const err = await assertRejects(
    () => requestAppleTestNotification({ material, env: "sandbox", fetchImpl }),
    AppleApiError,
  );
  assertEquals(err.status, 404);
  assertEquals(err.appleErrorCode, 4040007);
  assert(err.message.includes("4040007"), `expected errorCode in message, got: ${err.message}`);
});

Deno.test("requestAppleTestNotification: 401 with non-JSON body still throws AppleApiError", async () => {
  const material = await makeMaterial();
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response("Unauthorized", { status: 401 }));

  const err = await assertRejects(
    () => requestAppleTestNotification({ material, env: "sandbox", fetchImpl }),
    AppleApiError,
  );
  assertEquals(err.status, 401);
  assertEquals(err.appleErrorCode, undefined);
});

Deno.test("requestAppleTestNotification: missing testNotificationToken in 2xx body throws", async () => {
  const material = await makeMaterial();
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  const err = await assertRejects(
    () => requestAppleTestNotification({ material, env: "sandbox", fetchImpl }),
    AppleApiError,
  );
  assert(err.message.includes("missing testNotificationToken"));
});

Deno.test("requestAppleTestNotification: network error becomes AppleApiError(status=0)", async () => {
  const material = await makeMaterial();
  const fetchImpl: typeof fetch = () => Promise.reject(new Error("network unreachable"));
  const err = await assertRejects(
    () => requestAppleTestNotification({ material, env: "sandbox", fetchImpl }),
    AppleApiError,
  );
  assertEquals(err.status, 0);
  assert(err.message.includes("network unreachable"));
});

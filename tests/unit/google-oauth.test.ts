import { assert, assertEquals, assertRejects } from "@std/assert";
import { createAccessTokenProvider, GoogleOAuthError } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";

async function generateSa(): Promise<GoogleServiceAccount> {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let b64 = "";
  for (const byte of pkcs8) b64 += String.fromCharCode(byte);
  const encoded = btoa(b64).match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
  return {
    type: "service_account",
    project_id: "test",
    private_key_id: "kid",
    private_key: pem,
    client_email: "svc@test.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

interface FakeFetchCall {
  url: string;
  body: string;
}

function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
  calls: FakeFetchCall[],
): typeof fetch {
  return ((url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, body });
    const r = responses.shift();
    if (!r) throw new Error("fakeFetch: no more responses queued");
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

Deno.test("google oauth: first call fetches a token, subsequent calls hit cache", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [{ status: 200, body: { access_token: "tok-1", expires_in: 3600 } }],
    calls,
  );
  const provider = createAccessTokenProvider({ fetchImpl, now: () => 1_000_000_000_000 });

  assertEquals(await provider.getAccessToken("tenant_x", sa), "tok-1");
  assertEquals(await provider.getAccessToken("tenant_x", sa), "tok-1");
  assertEquals(calls.length, 1);
});

Deno.test("google oauth: refreshes when the cached token is within the skew window of expiry", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [
      { status: 200, body: { access_token: "tok-1", expires_in: 3600 } },
      { status: 200, body: { access_token: "tok-2", expires_in: 3600 } },
    ],
    calls,
  );
  let currentTime = 1_000_000_000_000;
  const provider = createAccessTokenProvider({ fetchImpl, now: () => currentTime });

  assertEquals(await provider.getAccessToken("tenant_x", sa), "tok-1");
  // Advance time past (expires_in - REFRESH_SKEW_SECONDS=60). The exact
  // boundary: at t + (3540 * 1000) the token is still fresh; at +1ms past
  // that it's stale and must refresh. Use a conservative +5s past the
  // skew boundary so any drift in the skew constant surfaces as a test
  // failure, not a coincidental pass.
  currentTime += (3600 - 60 + 5) * 1000;
  assertEquals(await provider.getAccessToken("tenant_x", sa), "tok-2");
  assertEquals(calls.length, 2);
});

Deno.test("google oauth: token remains cached until the skew boundary", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [{ status: 200, body: { access_token: "tok-1", expires_in: 3600 } }],
    calls,
  );
  let currentTime = 1_000_000_000_000;
  const provider = createAccessTokenProvider({ fetchImpl, now: () => currentTime });

  assertEquals(await provider.getAccessToken("t", sa), "tok-1");
  // One second before the skew boundary → still fresh.
  currentTime += (3600 - 60 - 1) * 1000;
  assertEquals(await provider.getAccessToken("t", sa), "tok-1");
  assertEquals(calls.length, 1);
});

Deno.test("google oauth: each tenant cache key fetches its own token", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [
      { status: 200, body: { access_token: "tok-a", expires_in: 3600 } },
      { status: 200, body: { access_token: "tok-b", expires_in: 3600 } },
    ],
    calls,
  );
  const provider = createAccessTokenProvider({ fetchImpl, now: () => 1_000_000_000_000 });

  assertEquals(await provider.getAccessToken("tenant_a", sa), "tok-a");
  assertEquals(await provider.getAccessToken("tenant_b", sa), "tok-b");
  assertEquals(calls.length, 2);
});

Deno.test("google oauth: concurrent cold-cache calls dedupe to a single fetch", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [{ status: 200, body: { access_token: "tok-1", expires_in: 3600 } }],
    calls,
  );
  const provider = createAccessTokenProvider({ fetchImpl, now: () => 1_000_000_000_000 });

  const [a, b, c] = await Promise.all([
    provider.getAccessToken("t", sa),
    provider.getAccessToken("t", sa),
    provider.getAccessToken("t", sa),
  ]);
  assertEquals(a, "tok-1");
  assertEquals(b, "tok-1");
  assertEquals(c, "tok-1");
  assertEquals(calls.length, 1);
});

Deno.test("google oauth: 4xx from token endpoint throws GoogleOAuthError with status", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [{ status: 401, body: { error: "invalid_client" } }],
    calls,
  );
  const provider = createAccessTokenProvider({ fetchImpl, now: () => 1_000_000_000_000 });

  await assertRejects(
    () => provider.getAccessToken("tenant_x", sa),
    GoogleOAuthError,
  );
});

Deno.test("google oauth: sends assertion JWT in application/x-www-form-urlencoded body", async () => {
  const sa = await generateSa();
  const calls: FakeFetchCall[] = [];
  const fetchImpl = fakeFetch(
    [{ status: 200, body: { access_token: "tok", expires_in: 3600 } }],
    calls,
  );
  const provider = createAccessTokenProvider({ fetchImpl, now: () => 1_000_000_000_000 });
  await provider.getAccessToken("t", sa);

  assertEquals(calls.length, 1);
  const body = new URLSearchParams(calls[0]!.body);
  assertEquals(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const assertion = body.get("assertion");
  assert(typeof assertion === "string" && assertion.split(".").length === 3);
});

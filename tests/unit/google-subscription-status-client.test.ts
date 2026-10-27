import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createGoogleHttpClient,
  GoogleApiError,
  GooglePurchaseNotFoundError,
  GoogleRateLimitError,
} from "@/services/google/client.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleCredentialMaterial, GoogleServiceAccount } from "@/services/google/types.ts";

const FAKE_SA: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  client_email: "svc@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const MATERIAL: GoogleCredentialMaterial = {
  packageName: "com.example.app",
  serviceAccount: FAKE_SA,
};

const stubTokenProvider: AccessTokenProvider = {
  getAccessToken: () => Promise.resolve("stub-token"),
};

interface Call {
  url: string;
  authorization: string | null;
}

function makeFetch(responses: Array<{ status: number; body?: unknown; headers?: HeadersInit }>) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get("Authorization") });
    const r = responses.shift();
    if (!r) throw new Error("no more responses queued");
    return Promise.resolve(
      new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers ?? { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(fetchImpl: typeof fetch) {
  return createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl,
  });
}

Deno.test("getSubscription: resolves a token against subscriptionsv2 without a productId", async () => {
  const { impl, calls } = makeFetch([
    { status: 200, body: { kind: "androidpublisher#subscriptionPurchaseV2", lineItems: [] } },
  ]);

  const result = await client(impl).getSubscription({ purchaseToken: "tok-abc" });

  assertEquals(result.raw.kind, "androidpublisher#subscriptionPurchaseV2");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.authorization, "Bearer stub-token");
  assert(
    calls[0]?.url.endsWith(
      "/applications/com.example.app/purchases/subscriptionsv2/tokens/tok-abc",
    ),
    `unexpected URL: ${calls[0]?.url}`,
  );
});

Deno.test("getSubscription: percent-encodes the purchase token", async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: {} }]);

  await client(impl).getSubscription({ purchaseToken: "tok/with+chars" });

  assert(calls[0]?.url.endsWith("/tokens/tok%2Fwith%2Bchars"), `unexpected URL: ${calls[0]?.url}`);
});

Deno.test("getSubscription: 404 maps to GooglePurchaseNotFoundError(not_found)", async () => {
  const { impl } = makeFetch([{ status: 404 }]);

  const err = await assertRejects(
    () => client(impl).getSubscription({ purchaseToken: "gone" }),
    GooglePurchaseNotFoundError,
  );
  assertEquals(err.reason, "not_found");
});

Deno.test("getSubscription: 410 maps to GooglePurchaseNotFoundError(gone)", async () => {
  const { impl } = makeFetch([{ status: 410 }]);

  const err = await assertRejects(
    () => client(impl).getSubscription({ purchaseToken: "consumed" }),
    GooglePurchaseNotFoundError,
  );
  assertEquals(err.reason, "gone");
});

Deno.test("getSubscription: 429 maps to GoogleRateLimitError with Retry-After", async () => {
  const { impl } = makeFetch([{ status: 429, headers: { "Retry-After": "30" } }]);

  const err = await assertRejects(
    () => client(impl).getSubscription({ purchaseToken: "tok" }),
    GoogleRateLimitError,
  );
  assertEquals(err.retryAfterSeconds, 30);
});

Deno.test("getSubscription: 5xx maps to GoogleApiError carrying the status", async () => {
  const { impl } = makeFetch([{ status: 503, body: { error: { status: "UNAVAILABLE" } } }]);

  const err = await assertRejects(
    () => client(impl).getSubscription({ purchaseToken: "tok" }),
    GoogleApiError,
  );
  assertEquals(err.status, 503);
  assertEquals(err.googleErrorCode, "UNAVAILABLE");
});

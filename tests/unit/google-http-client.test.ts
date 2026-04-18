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

Deno.test("GoogleHttpClient: subscription uses subscriptionsv2 URL and bearer token", async () => {
  const { impl, calls } = makeFetch([
    { status: 200, body: { kind: "test", lineItems: [] } },
  ]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  const result = await client.getPurchase({
    type: "subscription",
    productId: "premium",
    purchaseToken: "tok-abc",
  });
  assertEquals(result.raw.kind, "test");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.authorization, "Bearer stub-token");
  assert(
    calls[0]?.url.includes("/purchases/subscriptionsv2/tokens/tok-abc"),
    `unexpected URL: ${calls[0]?.url}`,
  );
  // subscriptionsv2 path is token-keyed, NOT product-keyed.
  assert(!calls[0]?.url.includes("premium"), "subscription URL must not include productId");
});

Deno.test("GoogleHttpClient: product uses products URL with both productId and token", async () => {
  const { impl, calls } = makeFetch([
    { status: 200, body: { purchaseState: 0 } },
  ]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  await client.getPurchase({
    type: "product",
    productId: "gems_100",
    purchaseToken: "tok-prod",
  });
  assert(calls[0]?.url.includes("/purchases/products/gems_100/tokens/tok-prod"));
});

Deno.test("GoogleHttpClient: 404 → PurchaseNotFoundError('not_found')", async () => {
  const { impl } = makeFetch([{ status: 404, body: { error: {} } }]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  const err = await assertRejects(
    () => client.getPurchase({ type: "product", productId: "p", purchaseToken: "t" }),
    GooglePurchaseNotFoundError,
  );
  assertEquals(err.reason, "not_found");
});

Deno.test("GoogleHttpClient: 410 → PurchaseNotFoundError('gone')", async () => {
  const { impl } = makeFetch([{ status: 410, body: { error: {} } }]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  const err = await assertRejects(
    () => client.getPurchase({ type: "product", productId: "p", purchaseToken: "t" }),
    GooglePurchaseNotFoundError,
  );
  assertEquals(err.reason, "gone");
});

Deno.test("GoogleHttpClient: 429 → GoogleRateLimitError with Retry-After parsed", async () => {
  const { impl } = makeFetch([
    {
      status: 429,
      body: { error: {} },
      headers: { "content-type": "application/json", "Retry-After": "45" },
    },
  ]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  const err = await assertRejects(
    () => client.getPurchase({ type: "product", productId: "p", purchaseToken: "t" }),
    GoogleRateLimitError,
  );
  assertEquals(err.retryAfterSeconds, 45);
});

Deno.test("GoogleHttpClient: 5xx → GoogleApiError with status", async () => {
  const { impl } = makeFetch([{ status: 503, body: { error: { status: "UNAVAILABLE" } } }]);
  const client = createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  const err = await assertRejects(
    () => client.getPurchase({ type: "product", productId: "p", purchaseToken: "t" }),
    GoogleApiError,
  );
  assertEquals(err.status, 503);
  assertEquals(err.googleErrorCode, "UNAVAILABLE");
});

Deno.test("GoogleHttpClient: URL-encodes path components to prevent injection", async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: {} }]);
  const client = createGoogleHttpClient({
    credentials: { ...MATERIAL, packageName: "com.example with spaces" },
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl: impl,
  });
  await client.getPurchase({
    type: "product",
    productId: "prod/slash",
    purchaseToken: "tok?query",
  });
  const url = calls[0]?.url ?? "";
  // Slashes and spaces must be percent-encoded in path components.
  assert(!url.includes("com.example with spaces"));
  assert(!url.includes("prod/slash"));
  assert(!url.includes("tok?query"));
});

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createGoogleHttpClient,
  GoogleApiError,
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

function makeFetch(responses: Array<{ status: number; body?: unknown; headers?: HeadersInit }>) {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(url);
    const r = responses.shift();
    if (!r) throw new Error("no more responses queued");
    return Promise.resolve(
      new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers ?? { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, urls };
}

function client(fetchImpl: typeof fetch) {
  return createGoogleHttpClient({
    credentials: MATERIAL,
    tokenProvider: stubTokenProvider,
    tenantCacheKey: "t1",
    fetchImpl,
  });
}

Deno.test("listVoidedPurchases: hits the voidedpurchases endpoint for the tenant's package", async () => {
  const { impl, urls } = makeFetch([{ status: 200, body: { voidedPurchases: [] } }]);

  await client(impl).listVoidedPurchases({});

  const url = new URL(urls[0]!);
  assertEquals(
    url.pathname,
    "/androidpublisher/v3/applications/com.example.app/purchases/voidedpurchases",
  );
});

Deno.test("listVoidedPurchases: defaults to including subscriptions, which Google does not", async () => {
  // Google's `type` defaults to 0 — one-time products only. A caller asking
  // Attesto about voided purchases almost always means subscriptions too,
  // and silently omitting them would read as "not refunded".
  const { impl, urls } = makeFetch([{ status: 200, body: { voidedPurchases: [] } }]);

  await client(impl).listVoidedPurchases({});

  assertEquals(new URL(urls[0]!).searchParams.get("type"), "1");
});

Deno.test("listVoidedPurchases: passes the window, paging and page size through", async () => {
  const { impl, urls } = makeFetch([{ status: 200, body: { voidedPurchases: [] } }]);

  await client(impl).listVoidedPurchases({
    startTimeMillis: "1744464130000",
    endTimeMillis: "1747056130000",
    maxResults: 250,
    pageToken: "next-page",
    type: 0,
  });

  const q = new URL(urls[0]!).searchParams;
  assertEquals(q.get("startTime"), "1744464130000");
  assertEquals(q.get("endTime"), "1747056130000");
  assertEquals(q.get("maxResults"), "250");
  assertEquals(q.get("token"), "next-page");
  assertEquals(q.get("type"), "0");
});

Deno.test("listVoidedPurchases: omits parameters the caller did not supply", async () => {
  const { impl, urls } = makeFetch([{ status: 200, body: { voidedPurchases: [] } }]);

  await client(impl).listVoidedPurchases({});

  const q = new URL(urls[0]!).searchParams;
  assertEquals(q.get("startTime"), null);
  assertEquals(q.get("endTime"), null);
  assertEquals(q.get("token"), null);
});

Deno.test("listVoidedPurchases: returns Google's body untouched", async () => {
  const body = {
    voidedPurchases: [{ purchaseToken: "tok", voidedTimeMillis: "1746000000000" }],
    tokenPagination: { nextPageToken: "more" },
  };
  const { impl } = makeFetch([{ status: 200, body }]);

  const result = await client(impl).listVoidedPurchases({});

  assertEquals(result.raw, body);
});

Deno.test("listVoidedPurchases: a quota rejection surfaces as GoogleRateLimitError", async () => {
  const { impl } = makeFetch([{ status: 429, headers: { "Retry-After": "60" } }]);

  const err = await assertRejects(
    () => client(impl).listVoidedPurchases({}),
    GoogleRateLimitError,
  );
  assertEquals(err.retryAfterSeconds, 60);
});

Deno.test("listVoidedPurchases: a permission failure surfaces as GoogleApiError", async () => {
  // The service account needs "View financial data" in Play Console; without
  // it Google answers 401/403 rather than an empty list.
  const { impl } = makeFetch([
    { status: 403, body: { error: { status: "PERMISSION_DENIED" } } },
  ]);

  const err = await assertRejects(
    () => client(impl).listVoidedPurchases({}),
    GoogleApiError,
  );
  assertEquals(err.status, 403);
  assertEquals(err.googleErrorCode, "PERMISSION_DENIED");
});

Deno.test("listVoidedPurchases: sends the bearer token", async () => {
  const calls: Array<string | null> = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push(new Headers(init.headers).get("Authorization"));
    return Promise.resolve(
      new Response(JSON.stringify({ voidedPurchases: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;

  await client(impl).listVoidedPurchases({});

  assert(calls[0] === "Bearer stub-token");
});

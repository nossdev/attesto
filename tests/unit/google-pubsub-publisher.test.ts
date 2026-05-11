import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { publishPubSubMessage, PubSubPublishError } from "@/services/google/pubsub-publisher.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";

const SA: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  client_email: "svc@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const TOPIC = "projects/test-project/topics/iap-rtdn";

interface CapturedCall {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

function captureFetch(
  responses: Array<{ status: number; body: unknown }>,
  calls: CapturedCall[],
): typeof fetch {
  return ((url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: typeof init.body === "string" ? init.body : "",
    });
    const r = responses.shift();
    if (!r) throw new Error("captureFetch: no more responses queued");
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";

function tokenProvider(
  scopesSeen: string[],
  token = "stub-token",
): AccessTokenProvider {
  return {
    getAccessToken: (_cacheKey, _sa, scope) => {
      scopesSeen.push(scope ?? "");
      return Promise.resolve(token);
    },
  };
}

Deno.test("pubsub publish: posts to {topic}:publish with bearer token and base64 data", async () => {
  const calls: CapturedCall[] = [];
  const scopes: string[] = [];
  const fetchImpl = captureFetch(
    [{ status: 200, body: { messageIds: ["1234567890"] } }],
    calls,
  );
  const result = await publishPubSubMessage({
    tenantId: "tenant_x",
    serviceAccount: SA,
    topic: TOPIC,
    data: { version: "1.0", testNotification: { version: "1.0" } },
    tokenProvider: tokenProvider(scopes),
    fetchImpl,
  });

  assertEquals(result.messageId, "1234567890");
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0]!.url,
    `https://pubsub.googleapis.com/v1/${TOPIC}:publish`,
  );
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.authorization, "Bearer stub-token");
  assertEquals(calls[0]!.contentType, "application/json");
  assertEquals(scopes, [PUBSUB_SCOPE]);

  // Body shape: { messages: [{ data: <base64(JSON.stringify(data))> }] }
  const parsed = JSON.parse(calls[0]!.body) as {
    messages: Array<{ data: string; attributes?: Record<string, string> }>;
  };
  assertEquals(parsed.messages.length, 1);
  const decoded = atob(parsed.messages[0]!.data);
  assertEquals(
    JSON.parse(decoded),
    { version: "1.0", testNotification: { version: "1.0" } },
  );
  // No attributes when none passed.
  assertEquals(parsed.messages[0]!.attributes, undefined);
});

Deno.test("pubsub publish: forwards optional attributes", async () => {
  const calls: CapturedCall[] = [];
  const fetchImpl = captureFetch(
    [{ status: 200, body: { messageIds: ["x"] } }],
    calls,
  );
  await publishPubSubMessage({
    tenantId: "tenant_x",
    serviceAccount: SA,
    topic: TOPIC,
    data: { ping: true },
    attributes: { source: "attesto-probe" },
    tokenProvider: tokenProvider([]),
    fetchImpl,
  });
  const parsed = JSON.parse(calls[0]!.body) as {
    messages: Array<{ attributes?: Record<string, string> }>;
  };
  assertEquals(parsed.messages[0]!.attributes, { source: "attesto-probe" });
});

Deno.test("pubsub publish: 403 maps to friendly IAM error naming the topic", async () => {
  const fetchImpl = captureFetch(
    [{ status: 403, body: { error: { message: "Permission denied" } } }],
    [],
  );
  const err = await assertRejects(
    () =>
      publishPubSubMessage({
        tenantId: "tenant_x",
        serviceAccount: SA,
        topic: TOPIC,
        data: {},
        tokenProvider: tokenProvider([]),
        fetchImpl,
      }),
    PubSubPublishError,
  );
  assertEquals(err.status, 403);
  assertEquals(err.topic, TOPIC);
  assertStringIncludes(err.message, "roles/pubsub.publisher");
  assertStringIncludes(err.message, TOPIC);
});

Deno.test("pubsub publish: 404 maps to topic-not-found error", async () => {
  const fetchImpl = captureFetch(
    [{ status: 404, body: { error: { message: "not found" } } }],
    [],
  );
  const err = await assertRejects(
    () =>
      publishPubSubMessage({
        tenantId: "tenant_x",
        serviceAccount: SA,
        topic: TOPIC,
        data: {},
        tokenProvider: tokenProvider([]),
        fetchImpl,
      }),
    PubSubPublishError,
  );
  assertEquals(err.status, 404);
  assertStringIncludes(err.message, "topic not found");
});

Deno.test("pubsub publish: missing messageIds in response throws", async () => {
  const fetchImpl = captureFetch(
    [{ status: 200, body: { messageIds: [] } }],
    [],
  );
  await assertRejects(
    () =>
      publishPubSubMessage({
        tenantId: "tenant_x",
        serviceAccount: SA,
        topic: TOPIC,
        data: {},
        tokenProvider: tokenProvider([]),
        fetchImpl,
      }),
    PubSubPublishError,
    "no messageId",
  );
});

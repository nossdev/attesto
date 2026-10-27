import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AppleApiError,
  AppleTransactionNotFoundError,
  createAppleHttpClient,
  decodeJwsPayload,
} from "@/services/apple/client.ts";
import { AppleJwsVerificationError, type AppleJwsVerifier } from "@/services/apple/jws-verifier.ts";
import type { AppleCredentialMaterial } from "@/services/apple/types.ts";

const MATERIAL: AppleCredentialMaterial = {
  bundleId: "com.example.app",
  keyId: "ABC1234567",
  // A real ES256 PKCS#8 key — the client signs a JWT before every call, so a
  // placeholder PEM would fail in the signer rather than in the code under test.
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKeyPem: [
    "-----BEGIN PRIVATE KEY-----",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2",
    "OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r",
    "1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
  appAppleId: 1234567890,
};

function toBase64Url(input: string): string {
  return btoa(input).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Build a structurally valid (unsigned) JWS the decode-only verifier can read. */
function fakeJws(payload: unknown): string {
  return `eyJhbGciOiJFUzI1NiJ9.${toBase64Url(JSON.stringify(payload))}.sig`;
}

/** Decode-only verifier: signature checks have their own tests. */
function decodeOnlyVerifier(): AppleJwsVerifier {
  const decode = (jws: string) => Promise.resolve(decodeJwsPayload(jws));
  return {
    verifyNotification: decode,
    verifyTransaction: decode,
    verifyRenewalInfo: decode,
  };
}

interface Call {
  url: string;
}

function makeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = ((url: string) => {
    calls.push({ url });
    const r = responses.shift();
    if (!r) throw new Error("no more responses queued");
    return Promise.resolve(
      new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function transactionPayload(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "2000000999999999",
    originalTransactionId: "2000000000123456",
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: 1_744_464_130_000,
    originalPurchaseDate: 1_736_600_000_000,
    expiresDate: 1_747_056_130_000,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    quantity: 1,
    ...overrides,
  };
}

function renewalPayload(overrides: Record<string, unknown> = {}) {
  return {
    originalTransactionId: "2000000000123456",
    autoRenewProductId: "premium_monthly",
    productId: "premium_monthly",
    autoRenewStatus: 1,
    renewalDate: 1_747_056_130_000,
    ...overrides,
  };
}

function statusesBody(lastTransactions: unknown[]) {
  return {
    environment: "Production",
    bundleId: "com.example.app",
    appAppleId: 1234567890,
    data: [{ subscriptionGroupIdentifier: "20123456", lastTransactions }],
  };
}

function client(fetchImpl: typeof fetch) {
  return createAppleHttpClient({
    credentials: MATERIAL,
    fetchImpl,
    verifier: decodeOnlyVerifier(),
  });
}

Deno.test("getSubscriptionStatuses: calls the subscriptions endpoint on the production host", async () => {
  const { impl, calls } = makeFetch([{
    status: 200,
    body: statusesBody([{
      status: 1,
      originalTransactionId: "2000000000123456",
      signedTransactionInfo: fakeJws(transactionPayload()),
      signedRenewalInfo: fakeJws(renewalPayload()),
    }]),
  }]);

  await client(impl).getSubscriptionStatuses({
    environment: "production",
    originalTransactionId: "2000000000123456",
  });

  assertEquals(calls.length, 1);
  assertEquals(
    calls[0]?.url,
    "https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/2000000000123456",
  );
});

Deno.test("getSubscriptionStatuses: uses the sandbox host for environment=sandbox", async () => {
  const { impl, calls } = makeFetch([{ status: 200, body: statusesBody([]) }]);

  await client(impl).getSubscriptionStatuses({
    environment: "sandbox",
    originalTransactionId: "2000000000123456",
  });

  assert(calls[0]?.url.startsWith("https://api.storekit-sandbox.itunes.apple.com/"));
});

Deno.test("getSubscriptionStatuses: flattens data[].lastTransactions[] and decodes both JWSs", async () => {
  const { impl } = makeFetch([{
    status: 200,
    body: statusesBody([{
      status: 4,
      originalTransactionId: "2000000000123456",
      signedTransactionInfo: fakeJws(transactionPayload({ productId: "premium_annual" })),
      signedRenewalInfo: fakeJws(
        renewalPayload({ gracePeriodExpiresDate: 1_747_660_930_000, autoRenewStatus: 0 }),
      ),
    }]),
  }]);

  const result = await client(impl).getSubscriptionStatuses({
    environment: "production",
    originalTransactionId: "2000000000123456",
  });

  assertEquals(result.bundleId, "com.example.app");
  assertEquals(result.environment, "Production");
  assertEquals(result.entries.length, 1);
  const entry = result.entries[0]!;
  assertEquals(entry.subscriptionGroupIdentifier, "20123456");
  assertEquals(entry.status, 4);
  assertEquals(entry.transaction.productId, "premium_annual");
  assertEquals(entry.renewalInfo?.gracePeriodExpiresDate, 1_747_660_930_000);
  assertEquals(entry.renewalInfo?.autoRenewStatus, 0);
});

Deno.test("getSubscriptionStatuses: keeps every subscription group and transaction", async () => {
  const { impl } = makeFetch([{
    status: 200,
    body: {
      environment: "Sandbox",
      bundleId: "com.example.app",
      data: [
        {
          subscriptionGroupIdentifier: "group-a",
          lastTransactions: [
            {
              status: 1,
              originalTransactionId: "aaa",
              signedTransactionInfo: fakeJws(transactionPayload({ originalTransactionId: "aaa" })),
              signedRenewalInfo: fakeJws(renewalPayload({ originalTransactionId: "aaa" })),
            },
          ],
        },
        {
          subscriptionGroupIdentifier: "group-b",
          lastTransactions: [
            {
              status: 2,
              originalTransactionId: "bbb",
              signedTransactionInfo: fakeJws(transactionPayload({ originalTransactionId: "bbb" })),
              signedRenewalInfo: fakeJws(renewalPayload({ originalTransactionId: "bbb" })),
            },
          ],
        },
      ],
    },
  }]);

  const result = await client(impl).getSubscriptionStatuses({
    environment: "sandbox",
    originalTransactionId: "aaa",
  });

  assertEquals(result.entries.length, 2);
  assertEquals(result.entries.map((e) => e.subscriptionGroupIdentifier), ["group-a", "group-b"]);
  assertEquals(result.entries.map((e) => e.status), [1, 2]);
});

Deno.test("getSubscriptionStatuses: entry without signedRenewalInfo yields renewalInfo null", async () => {
  const { impl } = makeFetch([{
    status: 200,
    body: statusesBody([{
      status: 2,
      originalTransactionId: "2000000000123456",
      signedTransactionInfo: fakeJws(transactionPayload()),
    }]),
  }]);

  const result = await client(impl).getSubscriptionStatuses({
    environment: "production",
    originalTransactionId: "2000000000123456",
  });

  assertEquals(result.entries[0]?.renewalInfo, null);
  assertEquals(result.entries[0]?.signedRenewalInfo, null);
});

Deno.test("getSubscriptionStatuses: 404 with OriginalTransactionIdNotFound maps to not-found", async () => {
  const { impl } = makeFetch([{ status: 404, body: { errorCode: 4040010 } }]);

  const err = await assertRejects(
    () =>
      client(impl).getSubscriptionStatuses({
        environment: "production",
        originalTransactionId: "nope",
      }),
    AppleTransactionNotFoundError,
  );
  assertEquals(err.reason, "transaction_id_not_found");
});

Deno.test("getSubscriptionStatuses: 404 with environment mismatch maps to environment_mismatch", async () => {
  const { impl } = makeFetch([{ status: 404, body: { errorCode: 4040005 } }]);

  const err = await assertRejects(
    () =>
      client(impl).getSubscriptionStatuses({
        environment: "production",
        originalTransactionId: "2000000000123456",
      }),
    AppleTransactionNotFoundError,
  );
  assertEquals(err.reason, "environment_mismatch");
});

Deno.test("getSubscriptionStatuses: non-ok upstream status surfaces AppleApiError", async () => {
  const { impl } = makeFetch([{ status: 500, body: { errorCode: 5000000 } }]);

  const err = await assertRejects(
    () =>
      client(impl).getSubscriptionStatuses({
        environment: "production",
        originalTransactionId: "2000000000123456",
      }),
    AppleApiError,
  );
  assertEquals(err.status, 500);
});

Deno.test("getSubscriptionStatuses: JWS verification failure surfaces AppleApiError", async () => {
  const { impl } = makeFetch([{
    status: 200,
    body: statusesBody([{
      status: 1,
      originalTransactionId: "2000000000123456",
      signedTransactionInfo: fakeJws(transactionPayload()),
      signedRenewalInfo: fakeJws(renewalPayload()),
    }]),
  }]);
  const rejectingVerifier: AppleJwsVerifier = {
    verifyNotification: () => Promise.reject(new AppleJwsVerificationError("nope")),
    verifyTransaction: () => Promise.reject(new AppleJwsVerificationError("nope")),
    verifyRenewalInfo: () => Promise.reject(new AppleJwsVerificationError("nope")),
  };

  await assertRejects(
    () =>
      createAppleHttpClient({
        credentials: MATERIAL,
        fetchImpl: impl,
        verifier: rejectingVerifier,
      }).getSubscriptionStatuses({
        environment: "production",
        originalTransactionId: "2000000000123456",
      }),
    AppleApiError,
  );
});

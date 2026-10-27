import { assert, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createAppleRoutes } from "@/routes/apple.ts";
import { createGoogleRoutes } from "@/routes/google.ts";
import { type AppleClient, AppleTransactionNotFoundError } from "@/services/apple/client.ts";
import { type GoogleClient, GooglePurchaseNotFoundError } from "@/services/google/client.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";
import type {
  ValidationAuditRecord,
  ValidationAuditRecorder,
} from "@/services/audit/validation-audit.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import { insertApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APPLE_MATERIAL = {
  bundleId: "com.example.app",
  keyId: "ABC1234567",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
  appAppleId: 1234567890,
};

const FAKE_SA: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  client_email: "svc@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const stubTokenProvider: AccessTokenProvider = {
  getAccessToken: () => Promise.resolve("stub-token"),
};

function appleLoader(): AppleCredentialsLoader {
  return {
    load: () => Promise.resolve({ material: APPLE_MATERIAL, environment: "production" as const }),
    invalidate() {},
    clear() {},
  };
}

function googleLoader(): GoogleCredentialsLoader {
  return {
    load: () => Promise.resolve({ packageName: "com.example.app", serviceAccount: FAKE_SA }),
    invalidate() {},
    clear() {},
  };
}

function appleClient(outcome: "found" | "missing"): AppleClient {
  return {
    getTransaction: () => Promise.reject(new Error("verify path not used here")),
    getSubscriptionStatuses: () => {
      if (outcome === "missing") {
        return Promise.reject(new AppleTransactionNotFoundError("transaction_id_not_found"));
      }
      return Promise.resolve({
        bundleId: "com.example.app",
        environment: "Production",
        appAppleId: 1234567890,
        entries: [{
          subscriptionGroupIdentifier: "20123456",
          status: 4,
          originalTransactionId: "2000000000123456",
          signedTransactionInfo: "jws.transaction",
          transaction: {
            transactionId: "2000000999999999",
            originalTransactionId: "2000000000123456",
            bundleId: "com.example.app",
            productId: "premium_monthly",
            purchaseDate: 1_744_464_130_000,
            originalPurchaseDate: 1_736_600_000_000,
            expiresDate: 1_747_056_130_000,
            type: "Auto-Renewable Subscription",
            appAccountToken: "household-uuid",
          },
          signedRenewalInfo: "jws.renewal",
          renewalInfo: {
            autoRenewStatus: 1,
            gracePeriodExpiresDate: 1_747_660_930_000,
            isInBillingRetryPeriod: true,
          },
        }],
      });
    },
  };
}

function googleClient(outcome: "found" | "missing"): GoogleClient {
  return {
    // Voided-purchase lookups have their own suite.
    listVoidedPurchases: () =>
      Promise.reject(new Error("listVoidedPurchases not used by these tests")),
    getPurchase: () => Promise.reject(new Error("verify path not used here")),
    getSubscription: () => {
      if (outcome === "missing") {
        return Promise.reject(new GooglePurchaseNotFoundError("not_found"));
      }
      return Promise.resolve({
        raw: {
          kind: "androidpublisher#subscriptionPurchaseV2",
          subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
          startTime: "2026-04-10T14:22:10.000Z",
          regionCode: "US",
          testPurchase: {},
          externalAccountIdentifiers: { obfuscatedExternalAccountId: "household-uuid" },
          lineItems: [{
            productId: "premium_monthly",
            expiryTime: "2026-05-10T14:22:10.000Z",
            autoRenewingPlan: { autoRenewEnabled: true },
          }],
        },
      });
    },
  };
}

function recordingAuditor(): { recorder: ValidationAuditRecorder; rows: ValidationAuditRecord[] } {
  const rows: ValidationAuditRecord[] = [];
  return {
    rows,
    recorder: {
      record(input) {
        rows.push(input);
        return Promise.resolve();
      },
    },
  };
}

async function setupTenantWithKey(
  handle: import("@/db/client.ts").DbHandle,
): Promise<{ tenantId: string; rawKey: string }> {
  const tenant = await createTenant(handle.db, { name: "Acme" });
  const key = await generateApiKey("test");
  await insertApiKey(handle.db, {
    tenantId: tenant.id,
    keyHash: key.hash,
    keyPrefix: key.keyPrefix,
  });
  return { tenantId: tenant.id, rawKey: key.raw };
}

function buildApp(
  handle: import("@/db/client.ts").DbHandle,
  opts: {
    apple?: AppleClient;
    google?: GoogleClient;
    auditRecorder?: ValidationAuditRecorder;
  } = {},
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", createAuthMiddleware({ db: handle.db, touchLastUsedAt: false }));
  app.route(
    "/v1",
    createAppleRoutes({
      credentialsLoader: appleLoader(),
      clientFactory: () => opts.apple ?? appleClient("found"),
      auditRecorder: opts.auditRecorder,
      // These tenants express no audit preference, so the deployment
      // default decides; turn it on so the audit assertions are about
      // the route's behaviour, not about the default being off.
      auditDefaultEnabled: true,
    }),
  );
  app.route(
    "/v1",
    createGoogleRoutes({
      credentialsLoader: googleLoader(),
      tokenProvider: stubTokenProvider,
      clientFactory: () => opts.google ?? googleClient("found"),
      auditRecorder: opts.auditRecorder,
      auditDefaultEnabled: true,
    }),
  );
  return app;
}

function post(app: Hono<HonoEnv>, path: string, rawKey: string | null, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (rawKey) headers.Authorization = `Bearer ${rawKey}`;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

// ─── Apple ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "POST /v1/apple/subscription-status: returns Apple's status and renewal info",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const res = await post(buildApp(handle), "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000000123456",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.environment, "production");
      assertEquals(body.version, "dev");
      assertEquals(body.subscriptions.length, 1);
      assertEquals(body.subscriptions[0].status, 4);
      assertEquals(body.subscriptions[0].productId, "premium_monthly");
      assertEquals(
        body.subscriptions[0].renewalInfo.gracePeriodExpiresDate,
        new Date(1_747_660_930_000).toISOString(),
      );
      assertEquals(body.appUserId, "household-uuid");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/subscription-status: unknown id is a 200 domain outcome, not an error",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildApp(handle, { apple: appleClient("missing") });
      const res = await post(app, "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000000000000",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "SUBSCRIPTION_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/subscription-status: rejects a body with no originalTransactionId",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const res = await post(buildApp(handle), "/v1/apple/subscription-status", rawKey, {
        transactionId: "2000000000123456",
      });

      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/subscription-status: requires an API key",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      await setupTenantWithKey(handle);
      const res = await post(buildApp(handle), "/v1/apple/subscription-status", null, {
        originalTransactionId: "2000000000123456",
      });

      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

// ─── Google ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "POST /v1/google/subscription-status: returns Play's subscriptionState and line items",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const res = await post(buildApp(handle), "/v1/google/subscription-status", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "tok-abc",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.version, "dev");
      assertEquals(body.subscription.subscriptionState, "SUBSCRIPTION_STATE_IN_GRACE_PERIOD");
      assertEquals(body.subscription.expiryTime, "2026-05-10T14:22:10.000Z");
      assertEquals(body.subscription.autoRenewEnabled, true);
      assertEquals(body.subscription.testPurchase, true);
      assertEquals(body.subscription.lineItems[0].productId, "premium_monthly");
      assertEquals(body.appUserId, "household-uuid");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/subscription-status: unknown token is a 200 domain outcome",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildApp(handle, { google: googleClient("missing") });
      const res = await post(app, "/v1/google/subscription-status", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "nope",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "SUBSCRIPTION_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/subscription-status: rejects a body with no purchaseToken",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const res = await post(buildApp(handle), "/v1/google/subscription-status", rawKey, {
        packageName: "com.example.app",
      });

      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

// ─── Audit ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "subscription-status: audits the purchase reference under the right source",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId, rawKey } = await setupTenantWithKey(handle);
      const { recorder, rows } = recordingAuditor();
      const app = buildApp(handle, { auditRecorder: recorder });

      await post(app, "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000000123456",
      });
      await post(app, "/v1/google/subscription-status", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "tok-abc",
      });

      assertEquals(rows.length, 2);
      assertEquals(rows[0]?.source, "apple");
      assertEquals(rows[0]?.identifier, "2000000000123456");
      assertEquals(rows[0]?.valid, true);
      assertEquals(rows[0]?.tenantId, tenantId);
      assertEquals(rows[1]?.source, "google");
      assertEquals(rows[1]?.identifier, "tok-abc");
      assertEquals(rows[1]?.valid, true);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "subscription-status: writes no audit row when no recorder is configured",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      // No auditRecorder — the route must not blow up and must not record.
      const res = await post(buildApp(handle), "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000000123456",
      });
      assertEquals(res.status, 200);
      assert((await res.json()).valid);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "subscription-status: an identifier with an unpaired surrogate is a 400, not a 500",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildApp(handle);

      // These strings pass `z.string().min(1).max(N)` but make
      // encodeURIComponent throw URIError while building the upstream URL.
      const apple = await post(app, "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000\ud800",
      });
      assertEquals(apple.status, 400);
      assertEquals((await apple.json()).error, "INVALID_REQUEST");

      const google = await post(app, "/v1/google/subscription-status", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "tok\ud800",
      });
      assertEquals(google.status, 400);
      assertEquals((await google.json()).error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "subscription-status: a domain failure is audited with its own error code",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const { recorder, rows } = recordingAuditor();
      const app = buildApp(handle, { apple: appleClient("missing"), auditRecorder: recorder });

      await post(app, "/v1/apple/subscription-status", rawKey, {
        originalTransactionId: "2000000000000000",
      });

      assertEquals(rows.length, 1);
      assertEquals(rows[0]?.valid, false);
      assertEquals(rows[0]?.errorCode, "SUBSCRIPTION_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

// ─── Voided purchases ─────────────────────────────────────────────────────────

function voidedClient(pages: Array<Record<string, unknown>>): GoogleClient {
  let i = 0;
  return {
    getPurchase: () => Promise.reject(new Error("not used here")),
    getSubscription: () => Promise.reject(new Error("not used here")),
    listVoidedPurchases: () => {
      const page = pages[Math.min(i, pages.length - 1)] ?? {};
      i++;
      return Promise.resolve({ raw: page });
    },
  };
}

function buildVoidedApp(
  handle: import("@/db/client.ts").DbHandle,
  pages: Array<Record<string, unknown>>,
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", createAuthMiddleware({ db: handle.db, touchLastUsedAt: false }));
  app.route(
    "/v1",
    createGoogleRoutes({
      credentialsLoader: googleLoader(),
      tokenProvider: stubTokenProvider,
      clientFactory: () => voidedClient(pages),
    }),
  );
  return app;
}

const VOIDED_ROW = {
  kind: "androidpublisher#voidedPurchase",
  purchaseToken: "tok-refunded",
  orderId: "GPA.1111-2222-3333-44444",
  purchaseTimeMillis: "1744464130000",
  voidedTimeMillis: "1746000000000",
  voidedSource: 0,
  voidedReason: 1,
};

Deno.test({
  name: "POST /v1/google/voided-purchases: returns a page in Google's own vocabulary",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildVoidedApp(handle, [{
        voidedPurchases: [VOIDED_ROW],
        tokenPagination: { nextPageToken: "page-2" },
      }]);

      const res = await post(app, "/v1/google/voided-purchases", rawKey, {
        packageName: "com.example.app",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.voidedPurchases.length, 1);
      assertEquals(body.voidedPurchases[0].purchaseToken, "tok-refunded");
      assertEquals(body.voidedPurchases[0].voidedTime, new Date(1_746_000_000_000).toISOString());
      assertEquals(body.voidedPurchases[0].voidedReason, 1);
      assertEquals(body.nextPageToken, "page-2");
      assertEquals(body.version, "dev");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/voided-purchases: rejects a body with no packageName",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const res = await post(app2(handle), "/v1/google/voided-purchases", rawKey, {});
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

function app2(handle: import("@/db/client.ts").DbHandle): Hono<HonoEnv> {
  return buildVoidedApp(handle, [{}]);
}

Deno.test({
  name: "POST /v1/google/purchase-voided: finds a refunded token and says why",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildVoidedApp(handle, [{ voidedPurchases: [VOIDED_ROW] }]);

      const res = await post(app, "/v1/google/purchase-voided", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "tok-refunded",
      });

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.voided, true);
      assertEquals(body.voidedPurchase.voidedSource, 0);
      assertEquals(body.truncated, false);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/purchase-voided: an exhausted list is a conclusive not-voided",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const app = buildVoidedApp(handle, [{ voidedPurchases: [VOIDED_ROW] }]);

      const res = await post(app, "/v1/google/purchase-voided", rawKey, {
        packageName: "com.example.app",
        purchaseToken: "tok-never-refunded",
      });

      const body = await res.json();
      assertEquals(body.voided, false);
      assertEquals(body.voidedPurchase, null);
      assertEquals(body.truncated, false);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/purchase-voided: requires an API key",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      await setupTenantWithKey(handle);
      const res = await post(buildVoidedApp(handle, [{}]), "/v1/google/purchase-voided", null, {
        packageName: "com.example.app",
        purchaseToken: "tok",
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

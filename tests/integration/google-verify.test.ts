import { assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createGoogleRoutes } from "@/routes/google.ts";
import {
  type GetPurchaseArgs,
  GoogleApiError,
  type GoogleClient,
  GooglePurchaseNotFoundError,
  GoogleRateLimitError,
} from "@/services/google/client.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleCredentialMaterial, GoogleServiceAccount } from "@/services/google/types.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import { insertApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const FAKE_SERVICE_ACCOUNT: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  client_email: "svc@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

function makeLoader(packageName: string): GoogleCredentialsLoader {
  const material: GoogleCredentialMaterial = {
    packageName,
    serviceAccount: FAKE_SERVICE_ACCOUNT,
  };
  return {
    load: () => Promise.resolve(material),
    invalidate() {},
    clear() {},
  };
}

function emptyLoader(): GoogleCredentialsLoader {
  return {
    load: () => Promise.resolve(null),
    invalidate() {},
    clear() {},
  };
}

const stubTokenProvider: AccessTokenProvider = {
  getAccessToken: () => Promise.resolve("stub-access-token"),
};

interface ClientBehavior {
  response?: Record<string, unknown> | Error;
  calls: GetPurchaseArgs[];
}

function makeClient(behavior: ClientBehavior): GoogleClient {
  return {
    getPurchase(args) {
      behavior.calls.push(args);
      if (behavior.response === undefined) {
        return Promise.reject(new GooglePurchaseNotFoundError());
      }
      if (behavior.response instanceof Error) return Promise.reject(behavior.response);
      return Promise.resolve({ raw: behavior.response });
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
  loader: GoogleCredentialsLoader,
  client: GoogleClient,
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", createAuthMiddleware({ db: handle.db, touchLastUsedAt: false }));
  app.route(
    "/v1",
    createGoogleRoutes({
      credentialsLoader: loader,
      tokenProvider: stubTokenProvider,
      clientFactory: () => client,
    }),
  );
  return app;
}

const PKG = "com.example.app";

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "POST /v1/google/verify: valid subscription → 200 normalized payload",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const calls: GetPurchaseArgs[] = [];
      // $9.99 in Google Money: units="9", nanos=990_000_000
      // → micros = 9*1_000_000 + 990_000_000/1000 = 9_990_000
      const client = makeClient({
        response: {
          startTime: "2026-04-10T14:22:10.000Z",
          regionCode: "US",
          acknowledgementState: 1,
          latestOrderId: "GPA.1234-5678-9012-34567",
          lineItems: [
            {
              expiryTime: "2026-05-10T14:22:10.000Z",
              autoRenewingPlan: { autoRenewEnabled: true },
              prices: [{ currencyCode: "USD", units: "9", nanos: 990_000_000 }],
            },
          ],
        },
        calls,
      });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "premium_monthly",
          purchaseToken: "tok-abc",
          type: "subscription",
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.purchase.kind, "androidpublisher#subscriptionPurchaseV2");
      assertEquals(body.purchase.packageName, PKG);
      assertEquals(body.purchase.productId, "premium_monthly");
      assertEquals(body.purchase.autoRenewing, true);
      assertEquals(body.purchase.priceCurrencyCode, "USD");
      assertEquals(body.purchase.priceAmountMicros, "9990000");
      assertEquals(body.purchase.orderId, "GPA.1234-5678-9012-34567");
      // Raw response preserved for power users.
      assertEquals(typeof body.purchase.rawResponse, "object");

      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.type, "subscription");
      assertEquals(calls[0]?.purchaseToken, "tok-abc");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "POST /v1/google/verify: multi-line-item subscription returns first-line envelope (by design)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({
        response: {
          startTime: "2026-04-10T14:22:10.000Z",
          regionCode: "US",
          lineItems: [
            {
              expiryTime: "2026-05-10T14:22:10.000Z",
              autoRenewingPlan: { autoRenewEnabled: true },
              prices: [{ currencyCode: "USD", units: "5", nanos: 0 }],
              productId: "premium_monthly",
            },
            {
              expiryTime: "2026-07-10T14:22:10.000Z",
              autoRenewingPlan: { autoRenewEnabled: false },
              prices: [{ currencyCode: "USD", units: "20", nanos: 0 }],
              productId: "addon_extras",
            },
          ],
        },
        calls: [],
      });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName: PKG,
          productId: "premium_monthly",
          purchaseToken: "tok-multi",
          type: "subscription",
        }),
      });
      const body = await res.json();
      assertEquals(body.valid, true);
      // Envelope fields reflect FIRST line item only — by design.
      assertEquals(body.purchase.expiryTime, "2026-05-10T14:22:10.000Z");
      assertEquals(body.purchase.autoRenewing, true);
      assertEquals(body.purchase.priceAmountMicros, "5000000");
      // Second line item must still be present in rawResponse for clients
      // that need the full picture.
      assertEquals(
        (body.purchase.rawResponse.lineItems as Array<Record<string, unknown>>).length,
        2,
      );
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: 410 Gone → valid:false PURCHASE_NOT_FOUND with 'gone' message",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({
        response: new GooglePurchaseNotFoundError("gone"),
        calls: [],
      });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName: PKG,
          productId: "p",
          purchaseToken: "consumed-token",
          type: "product",
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "PURCHASE_NOT_FOUND");
      assertEquals(body.message.includes("gone"), true);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: 429 rate limit → 429 RATE_LIMITED with Retry-After",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({
        response: new GoogleRateLimitError(30),
        calls: [],
      });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName: PKG,
          productId: "p",
          purchaseToken: "t",
          type: "product",
        }),
      });
      assertEquals(res.status, 429);
      const body = await res.json();
      assertEquals(body.error, "RATE_LIMITED");
      assertEquals(body.details?.retryAfterSeconds, 30);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: valid product → 200 normalized payload",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({
        response: {
          purchaseTimeMillis: "1744464130000",
          purchaseState: 0,
          consumptionState: 1,
          acknowledgementState: 1,
          orderId: "GPA.5678",
        },
        calls: [],
      });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "gems_100",
          purchaseToken: "tok-prod",
          type: "product",
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.purchase.kind, "androidpublisher#productPurchase");
      assertEquals(body.purchase.purchaseState, 0);
      assertEquals(body.purchase.consumptionState, 1);
      assertEquals(body.purchase.orderId, "GPA.5678");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: package mismatch → 200 valid:false PACKAGE_NAME_MISMATCH",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, makeLoader("com.example.app"), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: "com.attacker.app",
          productId: "gems_100",
          purchaseToken: "tok-prod",
          type: "product",
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "PACKAGE_NAME_MISMATCH");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: unknown token → 200 valid:false PURCHASE_NOT_FOUND",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ calls: [] }); // default → PurchaseNotFound
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "premium_monthly",
          purchaseToken: "unknown-token",
          type: "subscription",
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "PURCHASE_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: missing creds → 400 CREDENTIALS_MISSING",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, emptyLoader(), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "x",
          purchaseToken: "y",
          type: "subscription",
        }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "CREDENTIALS_MISSING");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: upstream 500 → 502 GOOGLE_API_ERROR",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ response: new GoogleApiError("boom", 500), calls: [] });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "p",
          purchaseToken: "t",
          type: "product",
        }),
      });
      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error, "GOOGLE_API_ERROR");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: invalid body (missing purchaseToken) → 400 INVALID_REQUEST",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ packageName: PKG, productId: "p", type: "product" }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: invalid type value rejected",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          packageName: PKG,
          productId: "p",
          purchaseToken: "t",
          type: "coupon",
        }),
      });
      assertEquals(res.status, 400);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/google/verify: missing auth → 401 UNAUTHENTICATED",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, makeLoader(PKG), client);

      const res = await app.request("/v1/google/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageName: PKG,
          productId: "p",
          purchaseToken: "t",
          type: "product",
        }),
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

import { assert, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createAppleRoutes } from "@/routes/apple.ts";
import {
  AppleApiError,
  type AppleClient,
  AppleTransactionNotFoundError,
  type GetTransactionArgs,
} from "@/services/apple/client.ts";
import type {
  AppleTransactionFetchResult,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type { AppleEnvironment } from "@/db/queries/apple-credentials.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import { insertApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeLoader(
  material: {
    bundleId: string;
    keyId: string;
    issuerId: string;
    privateKeyPem: string;
    appAppleId: number | null;
  },
  environment: AppleEnvironment = "auto",
): AppleCredentialsLoader {
  return {
    load: () => Promise.resolve({ material, environment }),
    invalidate() {},
    clear() {},
  };
}

function emptyLoader(): AppleCredentialsLoader {
  return {
    load: () => Promise.resolve(null),
    invalidate() {},
    clear() {},
  };
}

interface ClientBehavior {
  byEnv?: Partial<Record<"production" | "sandbox", DecodedAppleTransactionPayload | Error>>;
  calls: GetTransactionArgs[];
}

function wrap(decoded: DecodedAppleTransactionPayload): AppleTransactionFetchResult {
  return {
    signedTransactionInfo: `fake-jws.${btoa(JSON.stringify(decoded))}.sig`,
    decoded,
  };
}

function makeClient(behavior: ClientBehavior): AppleClient {
  return {
    getTransaction(args) {
      behavior.calls.push(args);
      const entry = behavior.byEnv?.[args.environment];
      if (entry === undefined) {
        return Promise.reject(new AppleTransactionNotFoundError("transaction_id_not_found"));
      }
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(wrap(entry));
    },
  };
}

function baseTransaction(
  overrides: Partial<DecodedAppleTransactionPayload> = {},
): DecodedAppleTransactionPayload {
  return {
    transactionId: "2000000123456789",
    originalTransactionId: "2000000000123456",
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: 1_744_464_130_000,
    originalPurchaseDate: 1_736_600_000_000,
    expiresDate: 1_747_056_130_000,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    quantity: 1,
    webOrderLineItemId: "web-line-item-1",
    currency: "USD",
    price: 9_990,
    storefront: "USA",
    storefrontId: "143441",
    transactionReason: "PURCHASE",
    ...overrides,
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
  loader: AppleCredentialsLoader,
  client: AppleClient,
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.use("*", createAuthMiddleware({ db: handle.db, touchLastUsedAt: false }));
  app.route(
    "/v1",
    createAppleRoutes({
      credentialsLoader: loader,
      clientFactory: () => client,
    }),
  );
  return app;
}

const SAMPLE_MATERIAL = {
  bundleId: "com.example.app",
  keyId: "ABC1234567",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
  // Default fixture includes appAppleId so existing production-env tests pass
  // the verify.ts pre-flight. Tests for the "missing appAppleId" path
  // override with `{ ...SAMPLE_MATERIAL, appAppleId: null }`.
  appAppleId: 1234567890,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "POST /v1/apple/verify: valid transaction → 200 with normalized payload",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId: _, rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { production: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      // Build version echoed in the body — "dev" in the test runner
      // (ATTESTO_VERSION unset). The X-Attesto-Version *header* is added by
      // the response middleware, exercised in tests/unit/health.test.ts.
      assertEquals(body.version, "dev");
      assertEquals(body.environment, "production");
      assertEquals(body.transaction.transactionId, "2000000123456789");
      assertEquals(body.transaction.bundleId, "com.example.app");
      assertEquals(body.transaction.productId, "premium_monthly");
      assertEquals(body.transaction.purchaseDate, new Date(1_744_464_130_000).toISOString());
      assertEquals(body.transaction.expiresDate, new Date(1_747_056_130_000).toISOString());
      assertEquals(body.transaction.price, 9990);

      // Only one API call because tenant is hard-configured for production.
      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.environment, "production");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "POST /v1/apple/verify: surfaces top-level appUserId from JWS appAccountToken; null when absent",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");

      // Case 1: JWS carries appAccountToken → surfaced as top-level appUserId.
      const withToken = baseTransaction({
        appAccountToken: "11111111-2222-4333-8444-555555555555",
      });
      const calls1: GetTransactionArgs[] = [];
      const app1 = buildApp(
        handle,
        loader,
        makeClient({ byEnv: { production: withToken }, calls: calls1 }),
      );
      const res1 = await app1.request("/v1/apple/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      const body1 = await res1.json();
      assertEquals(body1.valid, true);
      assertEquals(body1.appUserId, "11111111-2222-4333-8444-555555555555");
      // Also still surfaced on the platform-specific transaction (back-compat).
      assertEquals(
        body1.transaction.appAccountToken,
        "11111111-2222-4333-8444-555555555555",
      );

      // Case 2: JWS lacks appAccountToken → top-level appUserId is null.
      const withoutToken = baseTransaction(); // no appAccountToken set
      const calls2: GetTransactionArgs[] = [];
      const app2 = buildApp(
        handle,
        loader,
        makeClient({ byEnv: { production: withoutToken }, calls: calls2 }),
      );
      const res2 = await app2.request("/v1/apple/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      const body2 = await res2.json();
      assertEquals(body2.valid, true);
      assertEquals(body2.appUserId, null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: auto-detect tries production first, falls back to sandbox",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        byEnv: {
          production: new AppleTransactionNotFoundError("environment_mismatch"),
          sandbox: baseTransaction(),
        },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, true);
      assertEquals(body.environment, "sandbox");
      assertEquals(calls.length, 2);
      assertEquals(calls.map((c) => c.environment), ["production", "sandbox"]);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: unknown transactionId → 200 valid:false TRANSACTION_NOT_FOUND",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      // Both prod and sandbox return transaction_id_not_found.
      const client = makeClient({ calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "0000000000000000" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "TRANSACTION_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: bundle-id mismatch → 200 valid:false BUNDLE_ID_MISMATCH",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const calls: GetTransactionArgs[] = [];
      // Transaction belongs to a DIFFERENT bundle.
      const client = makeClient({
        byEnv: { production: baseTransaction({ bundleId: "com.attacker.app" }) },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.valid, false);
      assertEquals(body.error, "BUNDLE_ID_MISMATCH");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: tenant without apple creds → 400 CREDENTIALS_MISSING",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = emptyLoader();
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
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
  name: "POST /v1/apple/verify: env hint overrides tenant config",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      // Tenant is "auto" but request hints "sandbox" — only sandbox should be called.
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        byEnv: { sandbox: baseTransaction() },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transactionId: "2000000123456789",
          environment: "sandbox",
        }),
      });
      assertEquals(res.status, 200);
      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.environment, "sandbox");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: 401 from production in auto mode → falls back to sandbox",
  ignore: shouldSkipIntegration,
  async fn() {
    // Regression test for the bug discovered during the first customer onboarding:
    // Apple returns 401 for production-environment requests against apps that
    // haven't been promoted to the App Store yet (pre-launch / TestFlight-only).
    // verify.ts must catch AppleApiError(401) on a non-final env and fall back
    // to sandbox (symmetric to AppleTransactionNotFoundError fallback).
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        byEnv: {
          production: new AppleApiError("apple returned 401", 401),
          sandbox: baseTransaction(),
        },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });

      assertEquals(res.status, 200);
      const body = await res.json() as { valid: boolean; environment?: string };
      assertEquals(body.valid, true);
      assertEquals(body.environment, "sandbox");
      // Both envs should have been attempted, in order.
      assertEquals(calls.length, 2);
      assertEquals(calls[0]?.environment, "production");
      assertEquals(calls[1]?.environment, "sandbox");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "POST /v1/apple/verify: 401 on the last env in the list → APPLE_API_ERROR (no further fallback)",
  ignore: shouldSkipIntegration,
  async fn() {
    // The 401 fallback must NOT loop indefinitely. If both envs return 401 (or
    // we're configured for a single env that 401s), we surface APPLE_API_ERROR
    // so operators see the upstream auth failure and can investigate.
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        byEnv: {
          production: new AppleApiError("apple returned 401", 401),
          sandbox: new AppleApiError("apple returned 401", 401),
        },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });

      assertEquals(res.status, 502);
      const body = await res.json() as { error: string; details?: { status?: number } };
      assertEquals(body.error, "APPLE_API_ERROR");
      assertEquals(body.details?.status, 401);
      // Both envs attempted before giving up.
      assertEquals(calls.length, 2);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "POST /v1/apple/verify: explicit production env without appAppleId → 400 CREDENTIALS_MISSING",
  ignore: shouldSkipIntegration,
  async fn() {
    // The verify.ts pre-flight catches the case where environments resolves
    // to [production] AND material.appAppleId is null/undefined. Without
    // this guard the SDK would throw deep inside SignedDataVerifier ctor
    // with an opaque message; here we surface the actionable CLI fix.
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader({ ...SAMPLE_MATERIAL, appAppleId: null }, "production");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { production: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 400);
      const body = await res.json() as { error: string; message: string };
      assertEquals(body.error, "CREDENTIALS_MISSING");
      assert(
        body.message.includes("--app-apple-id"),
        `expected message to point at --app-apple-id remediation, got: ${body.message}`,
      );
      // Apple was NOT contacted — verifier construction was rejected upstream.
      assertEquals(calls.length, 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: explicit production env WITH appAppleId proceeds normally",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(
        { ...SAMPLE_MATERIAL, appAppleId: 1234567890 },
        "production",
      );
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { production: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json() as { valid: boolean; environment?: string };
      assertEquals(body.valid, true);
      assertEquals(body.environment, "production");
      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.environment, "production");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "POST /v1/apple/verify: environmentHint=production overrides auto config — pre-flight fires when appAppleId is null",
  ignore: shouldSkipIntegration,
  async fn() {
    // Coverage for the hint-driven path: tenant configured `auto`, request
    // body asks for `environment: "production"` explicitly. resolveEnvironments
    // narrows to [production], the entry guard catches missing appAppleId,
    // surfaces CREDENTIALS_MISSING. Future refactors of resolveEnvironments
    // could accidentally remove this coverage; pin it down.
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader({ ...SAMPLE_MATERIAL, appAppleId: null }, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { production: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transactionId: "2000000123456789",
          environment: "production",
        }),
      });
      assertEquals(res.status, 400);
      const body = await res.json() as { error: string; message: string };
      assertEquals(body.error, "CREDENTIALS_MISSING");
      assert(body.message.includes("--app-apple-id"));
      // Apple was not contacted — pre-flight rejected the request upstream.
      assertEquals(calls.length, 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: auto env + appAppleId=null still works (sandbox path)",
  ignore: shouldSkipIntegration,
  async fn() {
    // Regression check for Infopathy's exact configuration: env=auto +
    // appAppleId=null. The verify-path pre-flight skips (length > 1), the
    // env loop proceeds, production responds with the equivalent of a 401
    // (here we simulate via AppleApiError), the existing 401-fallback
    // catches and continues to sandbox. Net effect: existing pre-launch
    // tenants keep working unchanged after this PR.
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader({ ...SAMPLE_MATERIAL, appAppleId: null }, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        byEnv: {
          // Production simulated as 401 — same shape the new client.ts
          // pre-flight produces in production code.
          production: new AppleApiError("appAppleId required for production verifier", 401),
          sandbox: baseTransaction(),
        },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json() as { valid: boolean; environment?: string };
      assertEquals(body.valid, true);
      assertEquals(body.environment, "sandbox");
      assertEquals(calls.length, 2);
      assertEquals(calls[0]?.environment, "production");
      assertEquals(calls[1]?.environment, "sandbox");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: malformed body → 400 INVALID_REQUEST",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ wrong: "shape" }),
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
  name: "POST /v1/apple/verify: upstream Apple error → 502 APPLE_API_ERROR",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const client = makeClient({
        byEnv: { production: new AppleApiError("boom", 500) },
        calls: [],
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error, "APPLE_API_ERROR");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: missing Authorization → 401 UNAUTHENTICATED (middleware guard)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 401);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: family-shared transaction flows through inAppOwnershipType",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const client = makeClient({
        byEnv: { production: baseTransaction({ inAppOwnershipType: "FAMILY_SHARED" }) },
        calls: [],
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      const body = await res.json();
      assertEquals(body.transaction.inAppOwnershipType, "FAMILY_SHARED");
    } finally {
      await teardown();
    }
  },
});

// ─── Auto-detect branch coverage (code-reviewer H1 + M8) ─────────────────────

Deno.test({
  name: "POST /v1/apple/verify: auto with prod success does NOT call sandbox",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { production: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(body.valid, true);
      assertEquals(body.environment, "production");
      assertEquals(calls.length, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: auto falls back to sandbox on transaction_id_not_found (H1)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "auto");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({
        // Apple docs are inconsistent — prod sometimes returns 4040010 (not 4040005)
        // for a sandbox transaction. We treat both as "try the other env".
        byEnv: {
          production: new AppleTransactionNotFoundError("transaction_id_not_found"),
          sandbox: baseTransaction(),
        },
        calls,
      });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      const body = await res.json();
      assertEquals(res.status, 200);
      assertEquals(body.valid, true);
      assertEquals(body.environment, "sandbox");
      assertEquals(calls.length, 2);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: configured=sandbox does not try production",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "sandbox");
      const calls: GetTransactionArgs[] = [];
      const client = makeClient({ byEnv: { sandbox: baseTransaction() }, calls });
      const app = buildApp(handle, loader, client);

      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: "2000000123456789" }),
      });
      assertEquals(res.status, 200);
      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.environment, "sandbox");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "POST /v1/apple/verify: oversized body (>16KB) → 400 INVALID_REQUEST",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { rawKey } = await setupTenantWithKey(handle);
      const loader = makeLoader(SAMPLE_MATERIAL, "production");
      const client = makeClient({ calls: [] });
      const app = buildApp(handle, loader, client);

      const bigPayload = JSON.stringify({
        transactionId: "2000000123456789",
        bogus: "x".repeat(20_000),
      });
      const res = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(bigPayload).length),
        },
        body: bigPayload,
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "INVALID_REQUEST");
    } finally {
      await teardown();
    }
  },
});

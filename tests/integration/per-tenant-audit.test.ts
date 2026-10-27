import { assert, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import { count, eq } from "drizzle-orm";
import type { HonoEnv } from "@/hono-env.ts";
import { createAuthMiddleware } from "@/middleware/auth.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createAppleRoutes } from "@/routes/apple.ts";
import { createGoogleRoutes } from "@/routes/google.ts";
import type { AppleClient } from "@/services/apple/client.ts";
import type { GoogleClient } from "@/services/google/client.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";
import { createValidationAuditRecorder } from "@/services/audit/validation-audit.ts";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import { createTenant, setTenantAuditLog } from "@/db/queries/tenants.ts";
import { insertApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { apiKeys, googlePurchaseChains, validationAudit, webhookEvents } from "@/db/schema.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

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

function appleClient(): AppleClient {
  return {
    getTransaction: () =>
      Promise.resolve({
        signedTransactionInfo: "jws.transaction",
        decoded: {
          transactionId: "2000000999999999",
          originalTransactionId: "2000000000123456",
          bundleId: "com.example.app",
          productId: "premium_monthly",
          purchaseDate: 1_744_464_130_000,
          originalPurchaseDate: 1_736_600_000_000,
          expiresDate: 1_747_056_130_000,
          type: "Auto-Renewable Subscription",
        },
      }),
    getSubscriptionStatuses: () =>
      Promise.resolve({
        bundleId: "com.example.app",
        environment: "Production",
        appAppleId: 1234567890,
        entries: [{
          subscriptionGroupIdentifier: "20123456",
          status: 1,
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
          },
          signedRenewalInfo: null,
          renewalInfo: null,
        }],
      }),
  };
}

function googleClient(): GoogleClient {
  const raw = {
    kind: "androidpublisher#subscriptionPurchaseV2",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [{ productId: "premium_monthly", expiryTime: "2026-05-10T14:22:10.000Z" }],
  };
  return {
    getPurchase: () => Promise.resolve({ raw }),
    getSubscription: () => Promise.resolve({ raw }),
  };
}

function buildApp(
  handle: import("@/db/client.ts").DbHandle,
  auditDefaultEnabled: boolean,
): Hono<HonoEnv> {
  const encryption = createEncryptionService(ENCRYPTION_KEY);
  const auditRecorder = createValidationAuditRecorder({
    db: handle.db,
    encryption,
    fireAndForget: false,
  });
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  // touchLastUsedAt left ON — the guarantee names `api_keys.last_used_at`
  // as the one thing a verify writes, so the test must exercise it.
  app.use("*", createAuthMiddleware({ db: handle.db }));
  app.route(
    "/v1",
    createAppleRoutes({
      credentialsLoader: appleLoader(),
      clientFactory: () => appleClient(),
      auditRecorder,
      auditDefaultEnabled,
    }),
  );
  app.route(
    "/v1",
    createGoogleRoutes({
      credentialsLoader: googleLoader(),
      tokenProvider: stubTokenProvider,
      clientFactory: () => googleClient(),
      auditRecorder,
      auditDefaultEnabled,
    }),
  );
  return app;
}

async function tenantWithKey(
  handle: import("@/db/client.ts").DbHandle,
  name: string,
): Promise<{ tenantId: string; rawKey: string; keyId: string }> {
  const tenant = await createTenant(handle.db, { name });
  const key = await generateApiKey("test");
  const stored = await insertApiKey(handle.db, {
    tenantId: tenant.id,
    keyHash: key.hash,
    keyPrefix: key.keyPrefix,
  });
  return { tenantId: tenant.id, rawKey: key.raw, keyId: stored.id };
}

function post(app: Hono<HonoEnv>, path: string, rawKey: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Exercise all four lookup endpoints for one tenant.
 *
 * Every response is asserted 200. Body validation runs BEFORE the audit
 * wrapper, so a request rejected at the schema writes no audit row — which
 * would make every "writes no audit row" assertion below pass vacuously if
 * a stub or a schema ever drifted.
 */
async function callAllFour(app: Hono<HonoEnv>, rawKey: string): Promise<void> {
  const responses = [
    await post(app, "/v1/apple/verify", rawKey, { transactionId: "2000000999999999" }),
    await post(app, "/v1/apple/subscription-status", rawKey, {
      originalTransactionId: "2000000000123456",
    }),
    await post(app, "/v1/google/verify", rawKey, {
      packageName: "com.example.app",
      productId: "premium_monthly",
      purchaseToken: "tok-abc",
      type: "subscription",
    }),
    await post(app, "/v1/google/subscription-status", rawKey, {
      packageName: "com.example.app",
      purchaseToken: "tok-abc",
    }),
  ];
  for (const res of responses) {
    const body = await res.json();
    assertEquals(res.status, 200, `lookup failed: ${JSON.stringify(body)}`);
    assertEquals(body.valid, true, `lookup not valid: ${JSON.stringify(body)}`);
  }
}

async function auditRowCount(
  handle: import("@/db/client.ts").DbHandle,
  tenantId: string,
): Promise<number> {
  const rows = await handle.db
    .select({ n: count() })
    .from(validationAudit)
    .where(eq(validationAudit.tenantId, tenantId));
  return Number(rows[0]?.n ?? 0);
}

const SETTLE_MS = 50;
const MAX_WAIT_MS = 5_000;

/**
 * Audit writes are deliberately fire-and-forget (a DB hiccup must never
 * fail a verify), so a row can land after the response. Poll for the
 * expected count rather than racing it.
 */
async function waitForAuditRows(
  handle: import("@/db/client.ts").DbHandle,
  tenantId: string,
  expected: number,
): Promise<number> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let seen = await auditRowCount(handle, tenantId);
  while (seen < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    seen = await auditRowCount(handle, tenantId);
  }
  return seen;
}

/**
 * Count a tenant's audit rows behind a happens-after barrier.
 *
 * Audit writes are fire-and-forget, so "no rows yet" proves nothing on its
 * own — a sleep only proves the write was not fast. Instead we drive a
 * CONTROL tenant through the same app afterwards and wait for ITS rows to
 * land. Once they have, the quiet tenant's writes have had at least as
 * long, so a zero count is a real zero rather than a race we won.
 */
async function countBehindBarrier(
  handle: import("@/db/client.ts").DbHandle,
  app: Hono<HonoEnv>,
  quietTenantId: string,
): Promise<number> {
  const control = await tenantWithKey(handle, `Barrier-${crypto.randomUUID()}`);
  await setTenantAuditLog(handle.db, control.tenantId, true);
  await callAllFour(app, control.rawKey);
  assertEquals(await waitForAuditRows(handle, control.tenantId, 4), 4);
  return await auditRowCount(handle, quietTenantId);
}

// ─── Per-tenant override ──────────────────────────────────────────────────────

Deno.test({
  name: "audit: a tenant opted out writes no audit row even when the global default is on",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId, rawKey } = await tenantWithKey(handle, "OptedOut");
      await setTenantAuditLog(handle.db, tenantId, false);

      const app = buildApp(handle, true);
      await callAllFour(app, rawKey);

      assertEquals(await countBehindBarrier(handle, app, tenantId), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "audit: a tenant opted in writes rows even when the global default is off",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId, rawKey } = await tenantWithKey(handle, "OptedIn");
      await setTenantAuditLog(handle.db, tenantId, true);

      await callAllFour(buildApp(handle, false), rawKey);

      assertEquals(await waitForAuditRows(handle, tenantId, 4), 4);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "audit: a tenant with no preference follows the global default",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const a = await tenantWithKey(handle, "DefaultOn");
      await callAllFour(buildApp(handle, true), a.rawKey);
      assertEquals(await waitForAuditRows(handle, a.tenantId, 4), 4);

      const b = await tenantWithKey(handle, "DefaultOff");
      const offApp = buildApp(handle, false);
      await callAllFour(offApp, b.rawKey);
      // Barrier on an app whose default is ON, so the control's rows land.
      assertEquals(await countBehindBarrier(handle, buildApp(handle, true), b.tenantId), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "audit: one tenant's setting does not affect another's",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const quiet = await tenantWithKey(handle, "Quiet");
      const loud = await tenantWithKey(handle, "Loud");
      await setTenantAuditLog(handle.db, quiet.tenantId, false);

      const app = buildApp(handle, true);
      await callAllFour(app, quiet.rawKey);
      await callAllFour(app, loud.rawKey);

      assertEquals(await waitForAuditRows(handle, loud.tenantId, 4), 4);
      assertEquals(await auditRowCount(handle, quiet.tenantId), 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "audit: the setting can be cleared back to following the global default",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId, rawKey } = await tenantWithKey(handle, "Resettable");
      await setTenantAuditLog(handle.db, tenantId, false);
      await setTenantAuditLog(handle.db, tenantId, null);

      await callAllFour(buildApp(handle, true), rawKey);

      assertEquals(await waitForAuditRows(handle, tenantId, 4), 4);
    } finally {
      await teardown();
    }
  },
});

// ─── The written guarantee, as an executable test ────────────────────────────

Deno.test({
  name:
    "audit: a webhook-less, audit-off tenant stores nothing per purchase but the key's last_used_at",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { tenantId, rawKey, keyId } = await tenantWithKey(handle, "Wren");
      await setTenantAuditLog(handle.db, tenantId, false);

      const before = await handle.db
        .select({ lastUsedAt: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));
      assertEquals(before[0]?.lastUsedAt, null);

      // Global default ON, to prove the tenant's own setting is what decides.
      await callAllFour(buildApp(handle, true), rawKey);

      // Nothing per purchase, on any table that could hold one.
      assertEquals(await countBehindBarrier(handle, buildApp(handle, true), tenantId), 0);
      const events = await handle.db
        .select({ n: count() })
        .from(webhookEvents)
        .where(eq(webhookEvents.tenantId, tenantId));
      assertEquals(Number(events[0]?.n ?? 0), 0);
      const chains = await handle.db
        .select({ n: count() })
        .from(googlePurchaseChains)
        .where(eq(googlePurchaseChains.tenantId, tenantId));
      assertEquals(Number(chains[0]?.n ?? 0), 0);

      // The one documented exception: the key's last_used_at is stamped.
      const after = await handle.db
        .select({ lastUsedAt: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyId));
      assert(after[0]?.lastUsedAt instanceof Date, "expected last_used_at to be stamped");
    } finally {
      await teardown();
    }
  },
});

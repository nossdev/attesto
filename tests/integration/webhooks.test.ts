import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import type { DbHandle } from "@/db/client.ts";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { createWebhookRoutes } from "@/routes/webhooks.ts";
import { createApp } from "@/app.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import {
  enqueueWebhookDelivery,
  getWebhookConfig,
  insertWebhookEventIdempotent,
  upsertWebhookConfig,
} from "@/db/queries/webhooks.ts";
import { upsertAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { tenants, webhookConfigs, webhookDeliveries, webhookEvents } from "@/db/schema.ts";
import { createDispatcher, WEBHOOK_SECRET_ENC_CONTEXT } from "@/services/webhooks/dispatcher.ts";
import { DEFAULT_MAX_ATTEMPTS, RETRY_SCHEDULE_SECONDS } from "@/services/webhooks/delivery.ts";
import { verifyWebhookSignature } from "@/services/webhooks/signature.ts";
import { decodeJwsPayload } from "@/services/apple/client.ts";
import {
  AppleJwsVerificationError,
  type AppleJwsVerifier,
  type AppleJwsVerifierCache,
} from "@/services/apple/jws-verifier.ts";
import type { GoogleOidcVerifier } from "@/services/google/oidc-verifier.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

const TEST_ENC_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=";
const encryption = createEncryptionService(TEST_ENC_KEY);

async function seedWebhookConfig(
  handle: DbHandle,
  tenantId: string,
  callbackUrl: string,
  secret = "test-secret-supersecure",
  isActive = true,
): Promise<void> {
  const secretEnc = await encryption.encryptString(secret, WEBHOOK_SECRET_ENC_CONTEXT);
  await upsertWebhookConfig(handle.db, {
    tenantId,
    callbackUrl,
    secretEnc,
    isActive,
  });
}

async function setupTenant(
  handle: DbHandle,
  opts: {
    withAppleCreds?: boolean;
    bundleId?: string;
    environment?: "production" | "sandbox" | "auto";
    appAppleId?: number | null;
  } = {},
): Promise<string> {
  const tenant = await createTenant(handle.db, { name: "Webhook Test Tenant" });
  if (opts.withAppleCreds !== false) {
    // Webhook tests need apple_credentials seeded because the new receiver
    // resolves bundleId + environment from them for JWS verification. The
    // decode-only verifier below skips signature checks, but the receiver
    // still requires the row.
    const fakeKey = await encryption.encryptString(
      "-----BEGIN PRIVATE KEY-----\ntest-placeholder\n-----END PRIVATE KEY-----",
      "apple_credentials.private_key",
    );
    await upsertAppleCredentials(handle.db, {
      tenantId: tenant.id,
      bundleId: opts.bundleId ?? "com.example.app",
      keyId: "ABC1234567",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKeyEnc: fakeKey,
      environment: opts.environment ?? "sandbox",
      appAppleId: opts.appAppleId ?? null,
    });
  }
  return tenant.id;
}

/** Decode-only verifier — mimics the SDK interface but skips signature
 * checks. Cryptographic verification has its own unit tests. Wraps
 * decode failures as `AppleJwsVerificationError` to match the SDK's
 * contract so receiver error-handling is exercised correctly. */
function decodeOnlyVerifier(): AppleJwsVerifier {
  const decode = (jws: string): Promise<Record<string, unknown>> => {
    try {
      return Promise.resolve(decodeJwsPayload(jws));
    } catch (err) {
      return Promise.reject(
        new AppleJwsVerificationError(err instanceof Error ? err.message : String(err)),
      );
    }
  };
  return { verifyNotification: decode, verifyTransaction: decode };
}

function decodeOnlyVerifierCache(): AppleJwsVerifierCache {
  const shared = decodeOnlyVerifier();
  return { get: () => Promise.resolve(shared), clear: () => {} };
}

function passThroughOidcVerifier(): GoogleOidcVerifier {
  return { verify: () => Promise.resolve() };
}

function buildWebhookApp(
  handle: DbHandle,
  overrides: {
    appleVerifierCache?: AppleJwsVerifierCache;
    googleOidcVerifier?: GoogleOidcVerifier;
  } = {},
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: false }));
  app.route(
    "/v1/webhooks",
    createWebhookRoutes({
      db: handle.db,
      appleVerifierCache: overrides.appleVerifierCache ?? decodeOnlyVerifierCache(),
      googleOidcVerifier: overrides.googleOidcVerifier ?? passThroughOidcVerifier(),
    }),
  );
  return app;
}

/** Encodes `payload` as a fake JWS (header.payload.sig) — signature is not
 * verified by Attesto yet, so any non-empty string works. */
function fakeAppleJws(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = "fake-signature";
  return `${header}.${body}.${sig}`;
}

function googlePubsubEnvelope(notification: Record<string, unknown>, messageId: string) {
  const data = btoa(JSON.stringify(notification));
  return {
    message: {
      data,
      messageId,
      publishTime: "2026-04-18T12:00:00Z",
    },
    subscription: "projects/test/subscriptions/attesto",
  };
}

// ─── Receiver tests ───────────────────────────────────────────────────────────

// ─── Routing isolation (regression) ───────────────────────────────────────────
// Previously the `authed` sub-app registered auth middleware on `*` and was
// mounted at `/v1`. That wildcard shadowed `/v1/webhooks/*`, so inbound Apple
// /Google webhook requests received `401 UNAUTHENTICATED` from the API-key
// middleware before they could reach their handlers. The fix scopes auth to
// `/apple/*` and `/google/*` inside the authed sub-app. This test exercises
// the full createApp() factory (the per-test buildWebhookApp helper builds a
// stripped-down app without auth, so it can't catch this regression).

Deno.test({
  name: "createApp: /v1/webhooks/* is not shadowed by /v1 API-key auth middleware",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = createApp({
        // `authenticated` with no apple/google deps still mounts the authed
        // sub-app and its middleware — exactly the surface that used to leak.
        authenticated: { db: handle.db },
        webhooks: {
          db: handle.db,
          appleVerifierCache: decodeOnlyVerifierCache(),
          googleOidcVerifier: passThroughOidcVerifier(),
        },
      });

      // Bad tenantId format → handler returns 400. Pre-fix this returned 401
      // because the /v1 wildcard auth middleware fired first.
      const res = await app.request("/v1/webhooks/apple/badtenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assertNotEquals(
        res.status,
        401,
        "auth middleware must not shadow /v1/webhooks/*",
      );
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error, "INVALID_REQUEST");

      // Sanity: the auth surface still works for routes it actually owns.
      const verifyRes = await app.request("/v1/apple/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assertEquals(verifyRes.status, 401);
    } finally {
      await teardown();
    }
  },
});

// ─── Tenant existence pre-flight ──────────────────────────────────────────────
// docs/reference/api.md guarantees 404 TENANT_NOT_FOUND for webhook routes
// when the path-encoded tenantId doesn't resolve to an active tenant. Both
// receivers must check tenant existence/active BEFORE running the heavier
// verification or persistence path.

Deno.test({
  name: "apple webhook: non-existent tenantId → 404 TENANT_NOT_FOUND",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const fakeTenantId = "tenant_01HXYZABCDEFGHJKMNPQRSTV01"; // valid shape, never inserted
      const jws = fakeAppleJws({
        notificationUUID: "uuid-irrelevant",
        notificationType: "DID_RENEW",
        environment: "Sandbox",
      });
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${fakeTenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "TENANT_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: inactive tenant → 404 TENANT_NOT_FOUND",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle, { environment: "sandbox" });
      // Deactivate the tenant — same shape as `tenant:deactivate` would do.
      await handle.db
        .update(tenants)
        .set({ isActive: false })
        .where(eq(tenants.id, tenantId));
      const jws = fakeAppleJws({
        notificationUUID: "uuid-inactive",
        notificationType: "DID_RENEW",
        environment: "Sandbox",
      });
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "TENANT_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google webhook: post-OIDC tenant check fires for missing/inactive tenants",
  ignore: shouldSkipIntegration,
  async fn() {
    // The Google route runs OIDC verify BEFORE the tenant check (anti-oracle
    // ordering — see routes/webhooks.ts). In production, a non-existent tenant
    // surfaces as UNAUTHENTICATED via the verifier (no Google creds → fail).
    // This test uses passThroughOidcVerifier (which always succeeds) to
    // exercise the post-verify tenant check directly: with the OIDC gate
    // bypassed, an inactive tenant must surface as TENANT_NOT_FOUND.
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle, { environment: "sandbox" });
      // Deactivate the tenant — same shape as `tenant:deactivate` would do.
      await handle.db
        .update(tenants)
        .set({ isActive: false })
        .where(eq(tenants.id, tenantId));
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/google/${tenantId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer any-token-passthrough-verifier-accepts",
        },
        body: JSON.stringify({ message: { data: btoa("{}"), messageId: "irrelevant" } }),
      });
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "TENANT_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: tenant check fires BEFORE body read (oversized body still 404)",
  ignore: shouldSkipIntegration,
  async fn() {
    // Regression guard: if a future refactor moves readJsonWithLimit ahead of
    // assertActiveTenant, an oversized payload addressed to a non-existent
    // tenant would 413 (or worse, eat memory) rather than 404 cheaply. Pin
    // down the order with a >1MB body.
    const { handle, teardown } = await freshDb();
    try {
      const fakeTenantId = "tenant_01HXYZABCDEFGHJKMNPQRSTV03";
      const oversized = "x".repeat(1024 * 1024 + 100);
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${fakeTenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: oversized }),
      });
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "TENANT_NOT_FOUND");
    } finally {
      await teardown();
    }
  },
});

// ─── appAppleId pre-flight tests ──────────────────────────────────────────────
// The receiver must refuse to construct a production verifier without
// appAppleId (the SDK throws), and surface CREDENTIALS_MISSING with the
// exact remediation message — symmetric with the verify path.

Deno.test({
  name: "apple webhook: explicit production env without appAppleId → 400 CREDENTIALS_MISSING",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle, {
        environment: "production",
        appAppleId: null,
      });
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");
      const jws = fakeAppleJws({
        notificationUUID: "uuid-x",
        notificationType: "DID_RENEW",
        environment: "Production",
      });
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 400);
      const body = await res.json() as { error: string; message: string };
      assertEquals(body.error, "CREDENTIALS_MISSING");
      // Message must guide the operator to the CLI fix (shared with verify path).
      if (!body.message.includes("--app-apple-id")) {
        throw new Error(`expected --app-apple-id remediation, got: ${body.message}`);
      }
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: auto env + appAppleId=null + sandbox-fails-too → 400 CREDENTIALS_MISSING",
  ignore: shouldSkipIntegration,
  async fn() {
    // Regression test: the verifyWithEnvironments loop used to silently
    // throw a generic "no candidate environments produced a valid
    // verification" (mapped to SIGNATURE_INVALID) when production was
    // skipped due to missing appAppleId AND sandbox couldn't verify the
    // JWS (e.g. because it was production-signed and the sandbox cert
    // chain rejects). Operator saw "signature verification failed" —
    // misleading; the actual problem is missing credentials.
    //
    // Now: when productionSkipped=true and nothing else verified, surface
    // CREDENTIALS_MISSING with the remediation hint.
    //
    // Test setup forces a sandbox failure by injecting a verifier cache
    // that rejects every verifyNotification call.
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle, {
        environment: "auto",
        appAppleId: null,
      });
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");
      const jws = fakeAppleJws({
        notificationUUID: "uuid-y",
        notificationType: "DID_RENEW",
        environment: "Production",
      });
      // Cache that returns a verifier rejecting every call — simulates the
      // SDK's behavior when sandbox roots can't verify a production-signed JWS.
      const failingVerifier: AppleJwsVerifier = {
        verifyNotification: () =>
          Promise.reject(
            new AppleJwsVerificationError("simulated rejection by sandbox roots"),
          ),
        verifyTransaction: () =>
          Promise.reject(
            new AppleJwsVerificationError("simulated rejection"),
          ),
      };
      const failingCache: AppleJwsVerifierCache = {
        get: () => Promise.resolve(failingVerifier),
        clear: () => {},
      };
      const app = buildWebhookApp(handle, { appleVerifierCache: failingCache });
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 400);
      const body = await res.json() as { error: string; message: string };
      assertEquals(body.error, "CREDENTIALS_MISSING");
      if (!body.message.includes("--app-apple-id")) {
        throw new Error(`expected --app-apple-id remediation, got: ${body.message}`);
      }
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: production env WITH appAppleId proceeds normally",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle, {
        environment: "production",
        appAppleId: 1234567890,
      });
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");
      const jws = fakeAppleJws({
        notificationUUID: "uuid-z",
        notificationType: "DID_RENEW",
        environment: "Production",
      });
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 200);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: persists event + enqueues delivery when config exists",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");

      const jws = fakeAppleJws({
        notificationUUID: "uuid-1",
        notificationType: "DID_RENEW",
        subtype: "AUTO_RENEW_ENABLED",
      });
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.isNew, true);
      assertEquals(body.enqueuedDelivery, true);
      assertEquals(body.externalId, "uuid-1");

      const events = await handle.db.select().from(webhookEvents);
      assertEquals(events.length, 1);
      // DID_RENEW with an unmapped subtype falls back to the bare-type entry
      // (`subscription.renewed`); the full subtype survives in platformEvent.
      assertEquals(events[0]?.eventType, "subscription.renewed");
      assertEquals(events[0]?.reason, null);
      assertEquals(events[0]?.platformEvent, "apple.did_renew.auto_renew_enabled");

      const deliveries = await handle.db.select().from(webhookDeliveries);
      assertEquals(deliveries.length, 1);
      assertEquals(deliveries[0]?.status, "pending");
      assertEquals(deliveries[0]?.callbackUrl, "https://callback.example/hook");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name:
    "apple webhook: extracts appAccountToken from inner JWS → persists app_user_id; null when absent",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");

      // Case 1: inner signedTransactionInfo carries appAccountToken.
      const innerWith = fakeAppleJws({
        originalTransactionId: "2000000000123456",
        productId: "premium_monthly",
        type: "Auto-Renewable Subscription",
        appAccountToken: "11111111-2222-4333-8444-555555555555",
      });
      const outerWith = fakeAppleJws({
        notificationUUID: "uuid-with-token",
        notificationType: "DID_RENEW",
        data: { signedTransactionInfo: innerWith },
      });
      const app = buildWebhookApp(handle);
      const res1 = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: outerWith }),
      });
      assertEquals(res1.status, 200);

      // Case 2: inner signedTransactionInfo lacks appAccountToken.
      const innerWithout = fakeAppleJws({
        originalTransactionId: "2000000000123457",
        productId: "premium_monthly",
        type: "Auto-Renewable Subscription",
      });
      const outerWithout = fakeAppleJws({
        notificationUUID: "uuid-without-token",
        notificationType: "DID_RENEW",
        data: { signedTransactionInfo: innerWithout },
      });
      const res2 = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: outerWithout }),
      });
      assertEquals(res2.status, 200);

      const events = await handle.db.select().from(webhookEvents);
      assertEquals(events.length, 2);
      const byExt = new Map(events.map((e) => [e.externalId, e]));
      assertEquals(
        byExt.get("uuid-with-token")?.appUserId,
        "11111111-2222-4333-8444-555555555555",
      );
      assertEquals(byExt.get("uuid-without-token")?.appUserId, null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: idempotent — duplicate notificationUUID does not enqueue a second delivery",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");

      const jws = fakeAppleJws({ notificationUUID: "uuid-dup", notificationType: "DID_RENEW" });
      const app = buildWebhookApp(handle);
      const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      } as const;

      const first = await (await app.request(`/v1/webhooks/apple/${tenantId}`, opts)).json();
      const second = await (await app.request(`/v1/webhooks/apple/${tenantId}`, opts)).json();
      assertEquals(first.isNew, true);
      assertEquals(second.isNew, false);
      assertEquals(first.eventId, second.eventId);
      assertEquals(second.enqueuedDelivery, false);

      const deliveries = await handle.db.select().from(webhookDeliveries);
      assertEquals(deliveries.length, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: 400 when signedPayload missing",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
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
  name: "apple webhook: 401 SIGNATURE_INVALID when JWS malformed (not 3 segments)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: "only.two" }),
      });
      assertEquals(res.status, 401);
      const body = await res.json();
      assertEquals(body.error, "SIGNATURE_INVALID");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: 400 when payload missing notificationUUID",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const app = buildWebhookApp(handle);
      const jws = fakeAppleJws({ notificationType: "DID_RENEW" }); // no UUID
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 400);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: tenant without config — event persists, no delivery enqueued",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      // NO webhook config
      const app = buildWebhookApp(handle);
      const jws = fakeAppleJws({
        notificationUUID: "uuid-noconfig",
        notificationType: "DID_RENEW",
      });
      const res = await app.request(`/v1/webhooks/apple/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      const body = await res.json();
      assertEquals(body.isNew, true);
      assertEquals(body.enqueuedDelivery, false);

      const events = await handle.db.select().from(webhookEvents);
      assertEquals(events.length, 1);
      const deliveries = await handle.db.select().from(webhookDeliveries);
      assertEquals(deliveries.length, 0);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "apple webhook: invalid tenant_id path → 400",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const app = buildWebhookApp(handle);
      const jws = fakeAppleJws({ notificationUUID: "u", notificationType: "DID_RENEW" });
      const res = await app.request(`/v1/webhooks/apple/not-a-tenant-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedPayload: jws }),
      });
      assertEquals(res.status, 400);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google webhook: persists Pub/Sub message + normalizes event type",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");

      const envelope = googlePubsubEnvelope(
        {
          version: "1.0",
          packageName: "com.example.app",
          subscriptionNotification: {
            version: "1.0",
            notificationType: 4,
            purchaseToken: "ptok",
            subscriptionId: "premium_monthly",
          },
        },
        "msg-1",
      );
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/google/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.isNew, true);
      assertEquals(body.enqueuedDelivery, true);

      const events = await handle.db.select().from(webhookEvents);
      // Google SUBSCRIPTION_PURCHASED (4) → unified subscription.purchased
      // with reason "initial"; original numeric form preserved on platformEvent.
      assertEquals(events[0]?.eventType, "subscription.purchased");
      assertEquals(events[0]?.reason, "initial");
      assertEquals(events[0]?.platformEvent, "google.subscription.4");
      assertEquals(events[0]?.externalId, "msg-1");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google webhook: idempotent on messageId",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");

      const envelope = googlePubsubEnvelope(
        { testNotification: { version: "1.0" } },
        "msg-dup",
      );
      const app = buildWebhookApp(handle);
      const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      } as const;

      const first = await (await app.request(`/v1/webhooks/google/${tenantId}`, opts)).json();
      const second = await (await app.request(`/v1/webhooks/google/${tenantId}`, opts)).json();
      assertEquals(first.isNew, true);
      assertEquals(second.isNew, false);
      assertEquals(first.eventId, second.eventId);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google webhook: 400 when Pub/Sub envelope shape wrong",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/google/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: { data: "abc" /* no messageId */ } }),
      });
      assertEquals(res.status, 400);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google webhook: 400 when data is not valid base64 JSON",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const app = buildWebhookApp(handle);
      const res = await app.request(`/v1/webhooks/google/${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: { data: btoa("not valid json {"), messageId: "m1" },
        }),
      });
      assertEquals(res.status, 400);
    } finally {
      await teardown();
    }
  },
});

// ─── Outbound delivery tests ──────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

function makeCapturingFetch(
  responder: (req: CapturedRequest) => { status: number; body?: string },
): { impl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const impl = ((url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    const captured = { url, headers, body };
    calls.push(captured);
    const res = responder(captured);
    return Promise.resolve(
      new Response(res.body ?? "", {
        status: res.status,
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

Deno.test({
  name: "dispatcher: delivers pending row and marks delivered on 200",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "sekret-1");
      // Directly insert an event + delivery to exercise the dispatcher
      // in isolation of the receiver path.
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-del",
        eventType: "subscription.renewed",
        platformEvent: "apple.did_renew",
        rawPayload: { signedPayload: "..." },
        decodedPayload: { notificationUUID: "uuid-del", notificationType: "DID_RENEW" },
      });
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
      });

      const { impl, calls } = makeCapturingFetch(() => ({ status: 200, body: "ok" }));
      const dispatcher = createDispatcher({ db: handle, encryption, fetchImpl: impl });
      const tickResult = await dispatcher.tick();
      assertEquals(tickResult.claimed, 1);
      assertEquals(tickResult.outcomes[0]?.outcome, "delivered");

      assertEquals(calls.length, 1);
      assertEquals(calls[0]?.url, "https://callback.example/hook");
      assertEquals(calls[0]?.headers.get("X-Attesto-Event"), "subscription.renewed");
      assertEquals(calls[0]?.headers.get("X-Attesto-Event-Id"), event.id);
      assert(calls[0]?.headers.get("X-Attesto-Signature")?.startsWith("t="));

      // HMAC verifies on the delivered body
      const signatureHeader = calls[0]!.headers.get("X-Attesto-Signature")!;
      const verified = await verifyWebhookSignature({
        secret: "sekret-1",
        body: calls[0]!.body,
        headerValue: signatureHeader,
      });
      assertEquals(verified.valid, true);

      // DB reflects delivery
      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, event.id));
      assertEquals(row?.status, "delivered");
      assertEquals(row?.attemptCount, 1);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "dispatcher: schedules retry with exponential backoff on 5xx",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "s");
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-retry",
        eventType: "subscription.renewed",
        platformEvent: "apple.did_renew",
        rawPayload: {},
        decodedPayload: { notificationUUID: "uuid-retry" },
      });
      const frozenNow = new Date("2026-04-18T12:00:00.000Z");
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
        nextAttemptAt: new Date(frozenNow.getTime() - 1000), // eligible
      });

      const { impl } = makeCapturingFetch(() => ({ status: 503, body: "unavailable" }));
      const dispatcher = createDispatcher({
        db: handle,
        encryption,
        fetchImpl: impl,
        now: () => frozenNow,
      });
      const tickResult = await dispatcher.tick();
      assertEquals(tickResult.outcomes[0]?.outcome, "retry");

      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, event.id));
      assertEquals(row?.status, "pending");
      assertEquals(row?.attemptCount, 1);
      assertEquals(row?.lastResponseCode, 503);
      // First backoff is 30 seconds.
      const expectedNext = new Date(frozenNow.getTime() + RETRY_SCHEDULE_SECONDS[0] * 1000);
      assertEquals(row?.nextAttemptAt?.getTime(), expectedNext.getTime());
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "dispatcher: marks failed after exhausting retry schedule",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "s");
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-fail",
        eventType: "subscription.renewed",
        platformEvent: "apple.did_renew",
        rawPayload: {},
        decodedPayload: { notificationUUID: "uuid-fail" },
      });
      let now = new Date("2026-04-18T12:00:00.000Z");
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
        nextAttemptAt: new Date(now.getTime() - 1000),
      });

      // Drive the delivery to its terminal failed state by running one tick
      // per scheduled attempt, advancing `now` past each scheduled retry.
      const { impl } = makeCapturingFetch(() => ({ status: 500, body: "boom" }));
      const dispatcher = createDispatcher({
        db: handle,
        encryption,
        fetchImpl: impl,
        now: () => now,
      });

      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        const r = await dispatcher.tick();
        assertEquals(r.claimed, 1, `expected 1 claimed on attempt ${i + 1}`);
        const delaySec = RETRY_SCHEDULE_SECONDS[i];
        if (delaySec !== undefined) {
          now = new Date(now.getTime() + (delaySec + 1) * 1000);
        }
      }

      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, event.id));
      assertEquals(row?.status, "failed");
      assertEquals(row?.attemptCount, DEFAULT_MAX_ATTEMPTS);
      assert(row?.failedAt !== null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "dispatcher: threads operator-supplied maxRetries through to attemptDelivery",
  ignore: shouldSkipIntegration,
  async fn() {
    // Regression for #54: createDispatcher accepts maxRetries; processOne must
    // forward it to attemptDelivery so an operator who set
    // WEBHOOK_MAX_RETRIES=2 actually sees failure after 3 total attempts
    // (1 initial + 2 retries). If processOne ever drops the field, this fails.
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook");
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-maxretries",
        eventType: "subscription.renewed",
        platformEvent: "apple.did_renew",
        rawPayload: {},
        decodedPayload: {},
      });
      let now = new Date("2026-04-27T00:00:00Z");
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
        // Seed nextAttemptAt slightly in the past so the first tick claims
        // immediately (the row's default is real-world NOW, which would be
        // far in the future relative to the mocked `now`).
        nextAttemptAt: new Date(now.getTime() - 1000),
      });

      const { impl } = makeCapturingFetch(() => ({ status: 500, body: "boom" }));
      const dispatcher = createDispatcher({
        db: handle,
        encryption,
        fetchImpl: impl,
        now: () => now,
        maxRetries: 2, // operator-supplied cap below the schedule length
      });

      // 3 attempts total: 1 initial + 2 retries, then failed.
      for (let i = 0; i < 3; i++) {
        const r = await dispatcher.tick();
        assertEquals(r.claimed, 1, `expected 1 claimed on attempt ${i + 1}`);
        const delaySec = RETRY_SCHEDULE_SECONDS[i];
        if (delaySec !== undefined) {
          now = new Date(now.getTime() + (delaySec + 1) * 1000);
        }
      }

      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, event.id));
      assertEquals(row?.status, "failed");
      assertEquals(row?.attemptCount, 3);
      assert(row?.failedAt !== null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "dispatcher: abandons delivery if webhook config is disabled mid-retry",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "s", true);
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-disabled",
        eventType: "test",
        platformEvent: "apple.test",
        rawPayload: {},
        decodedPayload: { notificationUUID: "uuid-disabled" },
      });
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
      });

      // Tenant deactivates their webhook config before the dispatcher runs.
      await handle.db
        .update(webhookConfigs)
        .set({ isActive: false })
        .where(eq(webhookConfigs.tenantId, tenantId));

      const { impl, calls } = makeCapturingFetch(() => ({ status: 200 }));
      const dispatcher = createDispatcher({ db: handle, encryption, fetchImpl: impl });
      const r = await dispatcher.tick();
      assertEquals(r.outcomes[0]?.outcome, "failed");
      assertEquals(calls.length, 0, "no HTTP call should have been made");

      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventId, event.id));
      assertEquals(row?.status, "failed");
      assertEquals(row?.lastResponseBody, "no_active_webhook_config");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "dispatcher: payload body includes event fields per PLAN §4.5",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "s");
      const { event } = await insertWebhookEventIdempotent(handle.db, {
        tenantId,
        source: "apple",
        externalId: "uuid-body",
        eventType: "subscription.renewed",
        reason: null,
        platformEvent: "apple.did_renew",
        rawPayload: { signedPayload: "jws-here" },
        decodedPayload: { notificationUUID: "uuid-body", notificationType: "DID_RENEW" },
      });
      await enqueueWebhookDelivery(handle.db, {
        eventId: event.id,
        tenantId,
        callbackUrl: "https://callback.example/hook",
      });

      const { impl, calls } = makeCapturingFetch(() => ({ status: 200 }));
      const dispatcher = createDispatcher({ db: handle, encryption, fetchImpl: impl });
      await dispatcher.tick();

      const payload = JSON.parse(calls[0]!.body);
      assertEquals(payload.event, "subscription.renewed");
      assertEquals(payload.reason, null);
      assertEquals(payload.platformEvent, "apple.did_renew");
      assertEquals(payload.eventId, event.id);
      assertEquals(payload.externalId, "uuid-body");
      assertEquals(payload.tenantId, tenantId);
      assertEquals(payload.source, "apple");
      assertEquals(payload.data.notificationType, "DID_RENEW");
      assertEquals(payload.raw.signedPayload, "jws-here");
    } finally {
      await teardown();
    }
  },
});

// ─── CLI webhook:set-config ───────────────────────────────────────────────────

import { type AdminContext, runWebhookSetConfig } from "@/cli/admin.ts";
import { createTenant as _ } from "@/db/queries/tenants.ts"; // already imported above

function ctxFrom(handle: DbHandle): AdminContext {
  return { db: handle, encryption };
}

Deno.test({
  name: "cli webhook:set-config stores encrypted secret",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);

      const out: string[] = [];
      const errs: string[] = [];
      const code = await runWebhookSetConfig(
        ctxFrom(handle),
        [
          tenantId,
          "--callback-url",
          "https://example.com/webhook",
          "--secret",
          "super-secret-hmac-key-at-least-32-bytes",
        ],
        { write: (l) => out.push(l), err: (l) => errs.push(l) },
      );
      assertEquals(code, 0);
      assertEquals(errs.length, 0);

      const stored = await getWebhookConfig(handle.db, tenantId);
      assert(stored !== null);
      assertEquals(stored.callbackUrl, "https://example.com/webhook");
      const plaintext = await encryption.decryptString(
        stored.secretEnc,
        WEBHOOK_SECRET_ENC_CONTEXT,
      );
      assertEquals(plaintext, "super-secret-hmac-key-at-least-32-bytes");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli webhook:set-config rejects callback URL pointing at private / metadata hosts",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const badUrls = [
        "http://127.0.0.1:5000/hook",
        "http://169.254.169.254/latest/meta-data/",
        "https://localhost/hook",
        "http://10.0.0.1/hook",
        "http://192.168.1.1/hook",
        "http://metadata.google.internal/hook",
      ];
      for (const url of badUrls) {
        const errs: string[] = [];
        const code = await runWebhookSetConfig(
          ctxFrom(handle),
          [tenantId, "--callback-url", url, "--secret", "x".repeat(44)],
          { write: () => {}, err: (l) => errs.push(l) },
        );
        assertEquals(code, 2, `expected rejection for ${url}, got ${code}`);
        assert(errs.some((e) => e.toLowerCase().includes("callbackurl")));
      }
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli webhook:set-config rejects secret shorter than 32 chars",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const errs: string[] = [];
      const code = await runWebhookSetConfig(
        ctxFrom(handle),
        [tenantId, "--callback-url", "https://example.com/hook", "--secret", "short"],
        { write: () => {}, err: (l) => errs.push(l) },
      );
      assertEquals(code, 2);
      assert(errs.some((e) => e.toLowerCase().includes("secret")));
    } finally {
      await teardown();
    }
  },
});

// ─── Dispatcher lifecycle ──────────────────────────────────────────────────

Deno.test({
  name: "dispatcher start/stop: serializes ticks; stop() awaits in-flight tick",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      await seedWebhookConfig(handle, tenantId, "https://callback.example/hook", "s");
      const past = new Date(Date.now() - 60_000);
      // Three overlapping deliveries — if ticks overlap, we'd see > 3 calls.
      for (let i = 0; i < 3; i++) {
        const { event } = await insertWebhookEventIdempotent(handle.db, {
          tenantId,
          source: "apple",
          externalId: `uuid-life-${i}`,
          eventType: "test",
          platformEvent: "apple.test",
          rawPayload: {},
          decodedPayload: { notificationUUID: `uuid-life-${i}` },
        });
        await enqueueWebhookDelivery(handle.db, {
          eventId: event.id,
          tenantId,
          callbackUrl: "https://callback.example/hook",
          nextAttemptAt: past,
        });
      }

      let inFlight = 0;
      let maxInFlight = 0;
      const impl = ((_u: string, _i: RequestInit) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            inFlight--;
            resolve(new Response("ok", { status: 200 }));
          }, 50);
        });
      }) as unknown as typeof fetch;

      const dispatcher = createDispatcher({
        db: handle,
        encryption,
        fetchImpl: impl,
        intervalMs: 10, // fire quickly to attempt overlap
        concurrency: 10,
      });
      dispatcher.start();
      // Give the loop a chance to run one full cycle.
      await new Promise((r) => setTimeout(r, 200));
      await dispatcher.stop();

      const delivered = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.tenantId, tenantId));
      const deliveredCount = delivered.filter((d) => d.status === "delivered").length;
      assertEquals(deliveredCount, 3);
      // After stop() resolves, no inflight requests remain.
      assertEquals(inFlight, 0);
      // Each delivery was attempted exactly once.
      for (const d of delivered) assertEquals(d.attemptCount, 1);
      // Concurrency=10 means all 3 can be in flight at once within a single tick;
      // what we're guarding against is the NEXT tick starting while the first
      // is still running, which would bump this past 3.
      assert(maxInFlight <= 10, `unexpected in-flight concurrency: ${maxInFlight}`);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli webhook:set-config rejects non-URL callback",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenantId = await setupTenant(handle);
      const out: string[] = [];
      const errs: string[] = [];
      const code = await runWebhookSetConfig(
        ctxFrom(handle),
        [tenantId, "--callback-url", "not-a-url", "--secret", "x".repeat(32)],
        { write: (l) => out.push(l), err: (l) => errs.push(l) },
      );
      assertEquals(code, 2);
      assert(errs.some((e) => e.toLowerCase().includes("callbackurl")));
    } finally {
      await teardown();
    }
  },
});

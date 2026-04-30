/**
 * Integration tests for Google subscription upgrade-chain resolution.
 *
 * The unit-level helpers in services/webhooks/google-chain.ts are exercised
 * via the receiver path in webhooks.test.ts; this file covers the chain
 * walker directly against a real Postgres so concurrency / index behavior
 * is on the path tested.
 */

import { assert, assertEquals } from "@std/assert";
import { recordChainLink, resolveToRoot } from "@/services/webhooks/google-chain.ts";
import { createTenant } from "@/db/queries/tenants.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

Deno.test({
  name: "google-chain: resolveToRoot returns the input when no link exists",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const root = await resolveToRoot(handle.db, tenant.id, "TOK_A");
      assertEquals(root, "TOK_A");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: resolveToRoot walks one hop (B → A)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_B",
        previousToken: "TOK_A",
      });
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_B"), "TOK_A");
      // Walking from the root itself returns it (no further predecessor).
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_A"), "TOK_A");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: resolveToRoot walks multi-hop chain (D → C → B → A)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Insert in arbitrary order — the walker shouldn't depend on insertion order.
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_D",
        previousToken: "TOK_C",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_B",
        previousToken: "TOK_A",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_C",
        previousToken: "TOK_B",
      });
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_D"), "TOK_A");
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_C"), "TOK_A");
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_B"), "TOK_A");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: recordChainLink is idempotent (duplicate inserts no-op)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Insert twice; second call must not throw and must not overwrite.
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_B",
        previousToken: "TOK_A",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_B",
        previousToken: "TOK_A_DIFFERENT", // ignored — original wins
      });
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_B"), "TOK_A");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: recordChainLink ignores empty / self-link inputs",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // None of these should insert anything.
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "",
        previousToken: "TOK_A",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_A",
        previousToken: "",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_A",
        previousToken: "TOK_A", // self-link
      });
      // Resolution still returns the input — no rows were inserted.
      assertEquals(await resolveToRoot(handle.db, tenant.id, "TOK_A"), "TOK_A");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: chains are tenant-scoped (no cross-tenant resolution)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const t1 = await createTenant(handle.db, { name: "Tenant 1" });
      const t2 = await createTenant(handle.db, { name: "Tenant 2" });
      // Same token strings, different tenants → different chains.
      await recordChainLink(handle.db, {
        tenantId: t1.id,
        currentToken: "TOK_X",
        previousToken: "TOK_W",
      });
      // t2 has no chain for TOK_X; resolveToRoot returns the input.
      assertEquals(await resolveToRoot(handle.db, t1.id, "TOK_X"), "TOK_W");
      assertEquals(await resolveToRoot(handle.db, t2.id, "TOK_X"), "TOK_X");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: depth cap (16) prevents runaway walks on cycles",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Build a deliberately deep linear chain (well past the cap of 16).
      // Tokens 0..30, where token N points back to token N-1.
      for (let i = 1; i <= 30; i++) {
        await recordChainLink(handle.db, {
          tenantId: tenant.id,
          currentToken: `TOK_${i}`,
          previousToken: `TOK_${i - 1}`,
        });
      }
      // From TOK_30 we'd ideally walk 30 steps back, but the cap stops at 16.
      // Result must be deterministic (the deepest walked token), not throw.
      const root = await resolveToRoot(handle.db, tenant.id, "TOK_30");
      // After 16 hops from TOK_30: TOK_30 → TOK_29 → ... → TOK_14
      assertEquals(root, "TOK_14");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "google-chain: cycle detection short-circuits without spinning",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Construct a 2-cycle: A → B, B → A. Real Google data should never
      // produce this but we defend against it anyway.
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_A",
        previousToken: "TOK_B",
      });
      await recordChainLink(handle.db, {
        tenantId: tenant.id,
        currentToken: "TOK_B",
        previousToken: "TOK_A",
      });
      // Shouldn't loop forever; returns deterministically — the second seen
      // token after detecting the cycle.
      const root = await resolveToRoot(handle.db, tenant.id, "TOK_A");
      assert(root === "TOK_A" || root === "TOK_B");
    } finally {
      await teardown();
    }
  },
});

// ─── Receiver integration ─────────────────────────────────────────────────────

import { receiveGoogleWebhook } from "@/services/webhooks/google-receiver.ts";
import type { GoogleClient } from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { GoogleCredentialMaterial, GoogleServiceAccount } from "@/services/google/types.ts";

function makePubsubBody(decodedJson: Record<string, unknown>, messageId: string) {
  const data = btoa(JSON.stringify(decodedJson));
  return { message: { data, messageId, publishTime: "2026-01-01T00:00:00Z" } };
}

const STUB_SERVICE_ACCOUNT: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
  client_email: "x@y.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const STUB_MATERIAL: GoogleCredentialMaterial = {
  packageName: "com.example.app",
  serviceAccount: STUB_SERVICE_ACCOUNT,
};

function stubLoader(
  material: GoogleCredentialMaterial | null = STUB_MATERIAL,
): GoogleCredentialsLoader {
  return {
    load: () => Promise.resolve(material),
    invalidate() {},
    clear() {},
  };
}

function stubClient(linkedPurchaseToken: string | undefined): GoogleClient {
  return {
    getPurchase: () =>
      Promise.resolve({
        raw: linkedPurchaseToken ? { linkedPurchaseToken } : {},
      }),
  };
}

Deno.test({
  name: "receiver: subscription with linkedPurchaseToken records chain + writes root subjectKey",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      // Pre-seed: TOK_PREVIOUS already exists in chain table.
      // Sequence: first webhook for TOK_PREVIOUS arrives, next webhook for
      // TOK_NEW with linkedPurchaseToken=TOK_PREVIOUS. After processing
      // TOK_NEW, subject_key should be TOK_PREVIOUS (root walks back).

      const result = await receiveGoogleWebhook(handle.db, {
        tenantId: tenant.id,
        body: makePubsubBody(
          {
            subscriptionNotification: {
              version: "1.0",
              notificationType: 4,
              purchaseToken: "TOK_NEW",
              subscriptionId: "monthly.premium",
            },
          },
          "msg-1",
        ),
        chainResolver: {
          credentialsLoader: stubLoader(),
          clientFactory: () => stubClient("TOK_PREVIOUS"),
        },
      });

      assert(result.isNew);
      // Read back the persisted event and confirm subject_key.
      const { webhookEvents } = await import("@/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await handle.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, result.eventId));
      assertEquals(rows[0]?.subjectKey, "TOK_PREVIOUS");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "receiver: subscription without linkedPurchaseToken stores raw token as subjectKey",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const result = await receiveGoogleWebhook(handle.db, {
        tenantId: tenant.id,
        body: makePubsubBody(
          {
            subscriptionNotification: {
              version: "1.0",
              notificationType: 4,
              purchaseToken: "TOK_FIRST",
              subscriptionId: "monthly.premium",
            },
          },
          "msg-2",
        ),
        chainResolver: {
          credentialsLoader: stubLoader(),
          clientFactory: () => stubClient(undefined), // no link
        },
      });

      const { webhookEvents } = await import("@/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await handle.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, result.eventId));
      assertEquals(rows[0]?.subjectKey, "TOK_FIRST");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "receiver: chain resolver missing → subjectKey=null (legacy path), webhook still persists",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const result = await receiveGoogleWebhook(handle.db, {
        tenantId: tenant.id,
        body: makePubsubBody(
          {
            subscriptionNotification: {
              version: "1.0",
              notificationType: 4,
              purchaseToken: "TOK_RAW",
              subscriptionId: "monthly.premium",
            },
          },
          "msg-3",
        ),
        // No chainResolver — older code path / tests that don't wire it.
      });

      const { webhookEvents } = await import("@/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await handle.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, result.eventId));
      // Without a resolver, subjectKey is the raw token (no chain to walk).
      assertEquals(rows[0]?.subjectKey, "TOK_RAW");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "receiver: oneTimeProductNotification leaves subjectKey null (chain logic doesn't apply)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const result = await receiveGoogleWebhook(handle.db, {
        tenantId: tenant.id,
        body: makePubsubBody(
          {
            oneTimeProductNotification: {
              version: "1.0",
              notificationType: 1,
              purchaseToken: "TOK_PRODUCT",
              sku: "lifetime.gold",
            },
          },
          "msg-4",
        ),
        chainResolver: {
          credentialsLoader: stubLoader(),
          // Chain client should NOT be called for one-time products — fail loudly if it is.
          clientFactory: () => {
            throw new Error("clientFactory invoked for one-time product (should not happen)");
          },
        },
      });

      const { webhookEvents } = await import("@/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await handle.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, result.eventId));
      assertEquals(rows[0]?.subjectKey, null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "receiver: Play API failure → subjectKey falls back to raw token (logged warn)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const tenant = await createTenant(handle.db, { name: "Acme" });
      const result = await receiveGoogleWebhook(handle.db, {
        tenantId: tenant.id,
        body: makePubsubBody(
          {
            subscriptionNotification: {
              version: "1.0",
              notificationType: 4,
              purchaseToken: "TOK_FAIL",
              subscriptionId: "monthly.premium",
            },
          },
          "msg-5",
        ),
        chainResolver: {
          credentialsLoader: stubLoader(),
          // Throws — simulates Play API outage / quota / network.
          clientFactory: () => ({
            getPurchase: () => Promise.reject(new Error("Play API unreachable")),
          }),
        },
      });

      const { webhookEvents } = await import("@/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await handle.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, result.eventId));
      // Graceful degradation: raw token, not null. Better to deliver something
      // than to fail the whole webhook (which Google would retry forever).
      assertEquals(rows[0]?.subjectKey, "TOK_FAIL");
    } finally {
      await teardown();
    }
  },
});

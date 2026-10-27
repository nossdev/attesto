import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import { type VerifyGoogleDeps, verifyGooglePurchase } from "@/services/google/verify.ts";
import { getGoogleSubscriptionStatus } from "@/services/google/subscription-status.ts";
import type { ValidationAuditRecorder } from "@/services/audit/validation-audit.ts";
import { parseLookupBody, purchaseReference, withAudit } from "@/routes/shared.ts";
import { VERSION } from "@/lib/version.ts";

const VerifyBody = z.object({
  packageName: purchaseReference(200, { trim: true }),
  productId: purchaseReference(200, { trim: true }),
  purchaseToken: purchaseReference(4096, { trim: true }),
  type: z.enum(["subscription", "product"]),
});

// No productId: subscriptionsv2 is per-token, and a caller holding only a
// stored purchase reference has no product id to supply.
const SubscriptionStatusBody = z.object({
  packageName: purchaseReference(200, { trim: true }),
  purchaseToken: purchaseReference(4096, { trim: true }),
});

export interface GoogleRouteDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  /**
   * Builds the Play Developer API client. One factory serves both routes:
   * `GoogleClient` extends `GoogleSubscriptionClient`.
   */
  clientFactory?: VerifyGoogleDeps["clientFactory"];
  /** Optional audit recorder — when `ENABLE_VALIDATION_AUDIT_LOG=true`. */
  auditRecorder?: ValidationAuditRecorder;
}

export function createGoogleRoutes(deps: GoogleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // As with Apple: domain outcomes are HTTP 200 with `valid: false`; only
  // credential / upstream / transport faults throw. `version` echoes the
  // build that produced the response — do not branch on it.

  app.post("/google/verify", async (c) => {
    const body = await parseLookupBody(c, VerifyBody);
    const auth = c.get("auth");

    const result = await withAudit(
      {
        recorder: deps.auditRecorder,
        tenantId: auth.tenant.id,
        source: "google",
        identifier: body.purchaseToken,
      },
      () =>
        verifyGooglePurchase(
          {
            credentialsLoader: deps.credentialsLoader,
            tokenProvider: deps.tokenProvider,
            clientFactory: deps.clientFactory,
          },
          {
            tenantId: auth.tenant.id,
            packageName: body.packageName,
            productId: body.productId,
            purchaseToken: body.purchaseToken,
            type: body.type,
          },
        ),
    );

    return c.json({ ...result, version: VERSION });
  });

  /**
   * Current status of a subscription, by its purchase token, with no device
   * present. Surfaces what the verify envelope drops: `subscriptionState`
   * (where grace / on-hold / paused / canceled actually live), the
   * cancellation and pause context, `testPurchase`, and per-line-item detail.
   */
  app.post("/google/subscription-status", async (c) => {
    const body = await parseLookupBody(c, SubscriptionStatusBody);
    const auth = c.get("auth");

    const result = await withAudit(
      {
        recorder: deps.auditRecorder,
        tenantId: auth.tenant.id,
        source: "google",
        identifier: body.purchaseToken,
      },
      () =>
        getGoogleSubscriptionStatus(
          {
            credentialsLoader: deps.credentialsLoader,
            tokenProvider: deps.tokenProvider,
            clientFactory: deps.clientFactory,
          },
          {
            tenantId: auth.tenant.id,
            packageName: body.packageName,
            purchaseToken: body.purchaseToken,
          },
        ),
    );

    return c.json({ ...result, version: VERSION });
  });

  return app;
}

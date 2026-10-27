import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import { type VerifyGoogleDeps, verifyGooglePurchase } from "@/services/google/verify.ts";
import { getGoogleSubscriptionStatus } from "@/services/google/subscription-status.ts";
import {
  findGoogleVoidedPurchase,
  type GoogleVoidedPurchasesDeps,
  listGoogleVoidedPurchases,
} from "@/services/google/voided-purchases.ts";
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

// Google takes the window as ms-epoch strings and caps the lookback at 30
// days; we pass both through rather than inventing a date format.
const MillisString = z.string().trim().regex(/^\d{1,15}$/, "must be a millisecond epoch");

const VoidedPurchasesBody = z.object({
  packageName: purchaseReference(200, { trim: true }),
  startTime: MillisString.optional(),
  endTime: MillisString.optional(),
  /** Google's own enum: 0 one-time products only, 1 also subscriptions. */
  type: z.union([z.literal(0), z.literal(1)]).optional(),
  maxResults: z.number().int().positive().lte(1000).optional(),
  pageToken: z.string().trim().min(1).max(4096).optional(),
});

const PurchaseVoidedBody = z.object({
  packageName: purchaseReference(200, { trim: true }),
  purchaseToken: purchaseReference(4096, { trim: true }),
  startTime: MillisString.optional(),
  endTime: MillisString.optional(),
});

export interface GoogleRouteDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  /**
   * Builds the Play Developer API client. One factory serves every route:
   * `GoogleClient` extends both `GoogleSubscriptionClient` and
   * `GoogleVoidedPurchasesClient`.
   */
  clientFactory?: VerifyGoogleDeps["clientFactory"];
  /** Audit recorder. Whether it is used is decided per tenant, per request. */
  auditRecorder?: ValidationAuditRecorder;
  /**
   * Deployment-wide `ENABLE_VALIDATION_AUDIT_LOG`, used only for tenants
   * whose own `audit_log_enabled` is NULL. Defaults to off.
   */
  auditDefaultEnabled?: boolean;
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
        tenantAuditLogEnabled: auth.tenant.auditLogEnabled,
        defaultEnabled: deps.auditDefaultEnabled ?? false,
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
        tenantAuditLogEnabled: auth.tenant.auditLogEnabled,
        defaultEnabled: deps.auditDefaultEnabled ?? false,
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

  /**
   * One page of the app's voided (refunded / revoked / charged-back)
   * purchases.
   *
   * Google offers no per-token endpoint, so this is a per-APP list over a
   * time window — its lookback is capped at 30 days. For the per-token
   * question use `/google/purchase-voided` below.
   *
   * Requires the tenant's service account to hold **"View financial data"**
   * in Play Console. Without it Google answers 403, which surfaces as
   * `GOOGLE_API_ERROR` — never as an empty list, because a permissions
   * problem must not read as "nothing was refunded".
   *
   * Not audited: this is an app-wide report, not a lookup of one purchase
   * reference, so there is no identifier to record.
   */
  app.post("/google/voided-purchases", async (c) => {
    const body = await parseLookupBody(c, VoidedPurchasesBody);
    const auth = c.get("auth");

    const result = await listGoogleVoidedPurchases(voidedDeps(deps), {
      tenantId: auth.tenant.id,
      packageName: body.packageName,
      startTimeMillis: body.startTime,
      endTimeMillis: body.endTime,
      type: body.type,
      maxResults: body.maxResults,
      pageToken: body.pageToken,
    });

    return c.json({ ...result, version: VERSION });
  });

  /**
   * Was this specific purchase voided?
   *
   * This is the question `subscriptionsv2` cannot answer: it has no revoked
   * state, so a refund-revoked subscription reads as
   * `SUBSCRIPTION_STATE_EXPIRED`, indistinguishable from a lapse. Attesto
   * pages the voided list and matches.
   *
   * Read `truncated` before trusting a `false`: it means the scan hit its
   * page cap with pages remaining, so the answer is "not found in what I
   * read", not "not refunded". Narrow the window and ask again.
   */
  app.post("/google/purchase-voided", async (c) => {
    const body = await parseLookupBody(c, PurchaseVoidedBody);
    const auth = c.get("auth");

    const result = await withAudit(
      {
        recorder: deps.auditRecorder,
        tenantId: auth.tenant.id,
        source: "google",
        identifier: body.purchaseToken,
        tenantAuditLogEnabled: auth.tenant.auditLogEnabled,
        defaultEnabled: deps.auditDefaultEnabled ?? false,
      },
      () =>
        findGoogleVoidedPurchase(voidedDeps(deps), {
          tenantId: auth.tenant.id,
          packageName: body.packageName,
          purchaseToken: body.purchaseToken,
          startTimeMillis: body.startTime,
          endTimeMillis: body.endTime,
        }),
    );

    return c.json({ ...result, version: VERSION });
  });

  return app;
}

/** The voided-purchase services need only the narrow client capability. */
function voidedDeps(deps: GoogleRouteDeps): GoogleVoidedPurchasesDeps {
  return {
    credentialsLoader: deps.credentialsLoader,
    tokenProvider: deps.tokenProvider,
    clientFactory: deps.clientFactory,
  };
}

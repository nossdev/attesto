import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import { type VerifyAppleDeps, verifyAppleTransaction } from "@/services/apple/verify.ts";
import { getAppleSubscriptionStatus } from "@/services/apple/subscription-status.ts";
import type { ValidationAuditRecorder } from "@/services/audit/validation-audit.ts";
import { parseLookupBody, purchaseReference, withAudit } from "@/routes/shared.ts";
import { VERSION } from "@/lib/version.ts";

const VerifyBody = z.object({
  transactionId: purchaseReference(128),
  environment: z.enum(["production", "sandbox"]).optional(),
});

const SubscriptionStatusBody = z.object({
  originalTransactionId: purchaseReference(128),
  environment: z.enum(["production", "sandbox"]).optional(),
});

export interface AppleRouteDeps {
  credentialsLoader: AppleCredentialsLoader;
  /**
   * Builds the App Store Server API client. One factory serves both routes:
   * `AppleClient` extends `AppleSubscriptionStatusClient`.
   */
  clientFactory: VerifyAppleDeps["clientFactory"];
  /** Optional audit recorder — when `ENABLE_VALIDATION_AUDIT_LOG=true`. */
  auditRecorder?: ValidationAuditRecorder;
}

export function createAppleRoutes(deps: AppleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // `/v1/apple/*` always returns HTTP 200 for domain outcomes — `valid: false`
  // is an answer, not a transport error. Authentication / credentials /
  // upstream API failures throw AppError and are mapped by the error
  // middleware. `version` echoes the build that produced the response —
  // informational (also on the X-Attesto-Version header); do not branch on it.

  app.post("/apple/verify", async (c) => {
    const body = await parseLookupBody(c, VerifyBody);
    const auth = c.get("auth");

    const result = await withAudit(
      {
        recorder: deps.auditRecorder,
        tenantId: auth.tenant.id,
        source: "apple",
        identifier: body.transactionId,
      },
      () =>
        verifyAppleTransaction(
          { credentialsLoader: deps.credentialsLoader, clientFactory: deps.clientFactory },
          {
            tenantId: auth.tenant.id,
            transactionId: body.transactionId,
            environmentHint: body.environment,
          },
        ),
    );

    return c.json({ ...result, version: VERSION });
  });

  /**
   * Current status of a subscription, by its original transaction id, with
   * no device present. Distinct from `/apple/verify`: that calls Get
   * Transaction Info, which for an original transaction id returns the
   * FIRST period and never the renewal info that carries grace-period and
   * billing-retry state.
   */
  app.post("/apple/subscription-status", async (c) => {
    const body = await parseLookupBody(c, SubscriptionStatusBody);
    const auth = c.get("auth");

    const result = await withAudit(
      {
        recorder: deps.auditRecorder,
        tenantId: auth.tenant.id,
        source: "apple",
        identifier: body.originalTransactionId,
      },
      () =>
        getAppleSubscriptionStatus(
          { credentialsLoader: deps.credentialsLoader, clientFactory: deps.clientFactory },
          {
            tenantId: auth.tenant.id,
            originalTransactionId: body.originalTransactionId,
            environmentHint: body.environment,
          },
        ),
    );

    return c.json({ ...result, version: VERSION });
  });

  return app;
}

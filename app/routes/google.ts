import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { VERIFY_MAX_BODY_BYTES } from "@/lib/http-limits.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import { type VerifyGoogleDeps, verifyGooglePurchase } from "@/services/google/verify.ts";
import type { ValidationAuditRecorder } from "@/services/audit/validation-audit.ts";
import { VERSION } from "@/lib/version.ts";

const VerifyBody = z.object({
  packageName: z.string().trim().min(1).max(200),
  productId: z.string().trim().min(1).max(200),
  purchaseToken: z.string().trim().min(1).max(4096),
  type: z.enum(["subscription", "product"]),
});

export interface GoogleRouteDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  clientFactory?: VerifyGoogleDeps["clientFactory"];
  /** Optional audit recorder — when `ENABLE_VALIDATION_AUDIT_LOG=true`. */
  auditRecorder?: ValidationAuditRecorder;
}

export function createGoogleRoutes(deps: GoogleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post("/google/verify", async (c) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > VERIFY_MAX_BODY_BYTES) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Request body too large", {
        details: { maxBytes: VERIFY_MAX_BODY_BYTES },
      });
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = VerifyBody.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid request body", {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      });
    }
    const auth = c.get("auth");
    const startedAt = performance.now();
    let result: Awaited<ReturnType<typeof verifyGooglePurchase>> | undefined;
    let thrownError: unknown;
    try {
      result = await verifyGooglePurchase(
        {
          credentialsLoader: deps.credentialsLoader,
          tokenProvider: deps.tokenProvider,
          clientFactory: deps.clientFactory,
        },
        {
          tenantId: auth.tenant.id,
          packageName: parsed.data.packageName,
          productId: parsed.data.productId,
          purchaseToken: parsed.data.purchaseToken,
          type: parsed.data.type,
        },
      );
    } catch (err) {
      thrownError = err;
      throw err;
    } finally {
      // Audit success + failure; preserve the AppError code so
      // CREDENTIALS_MISSING / GOOGLE_API_ERROR / RATE_LIMITED are
      // distinguishable from domain `error` on a valid=false result.
      if (deps.auditRecorder) {
        const latencyMs = Math.round(performance.now() - startedAt);
        const errorCode = thrownError instanceof AppError
          ? thrownError.code
          : thrownError !== undefined
          ? ErrorCodes.INTERNAL_ERROR
          : result?.valid === false
          ? result.error
          : null;
        void deps.auditRecorder.record({
          tenantId: auth.tenant.id,
          source: "google",
          identifier: parsed.data.purchaseToken,
          valid: result?.valid === true,
          errorCode,
          latencyMs,
        });
      }
    }
    // `version` echoes the build that produced the response — informational
    // (also on the X-Attesto-Version header); do not branch on it.
    return c.json({ ...result, version: VERSION });
  });

  return app;
}

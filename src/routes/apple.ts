import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { VERIFY_MAX_BODY_BYTES } from "@/lib/http-limits.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import { type VerifyAppleDeps, verifyAppleTransaction } from "@/services/apple/verify.ts";
import type { ValidationAuditRecorder } from "@/services/audit/validation-audit.ts";

const VerifyBody = z.object({
  transactionId: z.string().min(1).max(128),
  environment: z.enum(["production", "sandbox"]).optional(),
});

export interface AppleRouteDeps {
  credentialsLoader: AppleCredentialsLoader;
  clientFactory?: VerifyAppleDeps["clientFactory"];
  /** Optional audit recorder — when `ENABLE_VALIDATION_AUDIT_LOG=true`. */
  auditRecorder?: ValidationAuditRecorder;
}

export function createAppleRoutes(deps: AppleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post("/v1/apple/verify", async (c) => {
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
    let result: Awaited<ReturnType<typeof verifyAppleTransaction>> | undefined;
    let thrownError: unknown;
    try {
      result = await verifyAppleTransaction(
        { credentialsLoader: deps.credentialsLoader, clientFactory: deps.clientFactory },
        {
          tenantId: auth.tenant.id,
          transactionId: parsed.data.transactionId,
          environmentHint: parsed.data.environment,
        },
      );
    } catch (err) {
      thrownError = err;
      throw err;
    } finally {
      // Record audit on success AND failure. Preserve the AppError code so
      // CREDENTIALS_MISSING / APPLE_API_ERROR / etc. are distinguishable
      // from the domain `error` on a valid=false result — otherwise all
      // failures collapse to `errorCode: null` and operators lose signal.
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
          source: "apple",
          identifier: parsed.data.transactionId,
          valid: result?.valid === true,
          errorCode,
          latencyMs,
        });
      }
    }

    // `/v1/apple/verify` always returns HTTP 200 — `valid: false` is a domain
    // outcome, not a transport error. Authentication / credentials / upstream
    // API failures throw AppError and are mapped by the error middleware.
    return c.json(result);
  });

  return app;
}

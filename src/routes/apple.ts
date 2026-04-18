import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import { type VerifyAppleDeps, verifyAppleTransaction } from "@/services/apple/verify.ts";

const VerifyBody = z.object({
  transactionId: z.string().min(1).max(128),
  environment: z.enum(["production", "sandbox"]).optional(),
});

// PLAN.md §11 caps webhook payloads at 1MB; verify request bodies are tiny
// (just a transactionId), so clamp tighter to avoid buffering a rogue request.
const MAX_BODY_BYTES = 16 * 1024;

export interface AppleRouteDeps {
  credentialsLoader: AppleCredentialsLoader;
  clientFactory?: VerifyAppleDeps["clientFactory"];
}

export function createAppleRoutes(deps: AppleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post("/v1/apple/verify", async (c) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Request body too large", {
        details: { maxBytes: MAX_BODY_BYTES },
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

    const result = await verifyAppleTransaction(
      { credentialsLoader: deps.credentialsLoader, clientFactory: deps.clientFactory },
      {
        tenantId: auth.tenant.id,
        transactionId: parsed.data.transactionId,
        environmentHint: parsed.data.environment,
      },
    );

    // `/v1/apple/verify` always returns HTTP 200 — `valid: false` is a domain
    // outcome, not a transport error. Authentication / credentials / upstream
    // API failures throw AppError and are mapped by the error middleware.
    return c.json(result);
  });

  return app;
}

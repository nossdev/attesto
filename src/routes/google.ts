import { Hono } from "@hono/hono";
import { z } from "zod";
import type { HonoEnv } from "@/hono-env.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import { type VerifyGoogleDeps, verifyGooglePurchase } from "@/services/google/verify.ts";

const VerifyBody = z.object({
  packageName: z.string().trim().min(1).max(200),
  productId: z.string().trim().min(1).max(200),
  purchaseToken: z.string().trim().min(1).max(4096),
  type: z.enum(["subscription", "product"]),
});

const MAX_BODY_BYTES = 16 * 1024;

export interface GoogleRouteDeps {
  credentialsLoader: GoogleCredentialsLoader;
  tokenProvider: AccessTokenProvider;
  clientFactory?: VerifyGoogleDeps["clientFactory"];
}

export function createGoogleRoutes(deps: GoogleRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post("/v1/google/verify", async (c) => {
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
    const result = await verifyGooglePurchase(
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
    return c.json(result);
  });

  return app;
}

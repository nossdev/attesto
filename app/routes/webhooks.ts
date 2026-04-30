import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import type { Database } from "@/db/client.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";
import { getTenantById } from "@/db/queries/tenants.ts";
import { receiveAppleWebhook } from "@/services/webhooks/apple-receiver.ts";
import { receiveGoogleWebhook } from "@/services/webhooks/google-receiver.ts";
import type { AppleJwsVerifierCache } from "@/services/apple/jws-verifier.ts";
import type { GoogleOidcVerifier } from "@/services/google/oidc-verifier.ts";

// Inbound webhook bodies are small (Apple <10KB, Google Pub/Sub <10KB) but
// we cap at 1MB per PLAN.md §11 just in case.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface WebhookRouteDeps {
  db: Database;
  appleVerifierCache: AppleJwsVerifierCache;
  googleOidcVerifier: GoogleOidcVerifier;
}

// Validate tenant_id shape early — not really auth, just an input guard.
// Inbound webhook origin auth is cryptographic: Apple JWS signature
// verification (via @apple/app-store-server-library) or Google OIDC JWT
// (via Google JWKS).
const TENANT_ID_RE = /^tenant_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Read body + enforce `MAX_BODY_BYTES` against *actual* bytes —
 * `Content-Length` is advisory (spoofable, omitted on chunked transfer).
 */
async function readJsonWithLimit(c: {
  req: { raw: Request; header: (name: string) => string | undefined };
}): Promise<Record<string, unknown> | null> {
  const advertised = c.req.header("content-length");
  if (advertised && Number(advertised) > MAX_BODY_BYTES) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Request body too large", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  const buf = await c.req.raw.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "Request body too large", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  try {
    const text = new TextDecoder().decode(buf);
    if (!text) return null;
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function createWebhookRoutes(deps: WebhookRouteDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  function checkTenantId(tenantId: string): void {
    if (!TENANT_ID_RE.test(tenantId)) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Invalid tenant_id in path");
    }
  }

  /** Throws TENANT_NOT_FOUND if the tenant is missing or `!isActive`.
   * One PK SELECT per call — fine at current scale; cache if it ever shows up. */
  async function assertActiveTenant(tenantId: string): Promise<void> {
    const tenant = await getTenantById(deps.db, tenantId);
    if (!tenant || !tenant.isActive) {
      throw new AppError(ErrorCodes.TENANT_NOT_FOUND, "Tenant not found");
    }
  }

  app.post("/apple/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    checkTenantId(tenantId);
    await assertActiveTenant(tenantId);

    const body = await readJsonWithLimit(c);
    if (!body) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Body must be a JSON object");
    }

    const result = await receiveAppleWebhook(
      { db: deps.db, verifierCache: deps.appleVerifierCache },
      { tenantId, body: body as { signedPayload?: unknown } },
    );
    // Apple expects 200 OK on successful receipt — any non-2xx triggers
    // their retry loop, which we want ONLY on genuine persistence failures.
    return c.json(result, 200);
  });

  app.post("/google/:tenantId", async (c) => {
    const tenantId = c.req.param("tenantId");
    checkTenantId(tenantId);

    // OIDC verify FIRST — running an unauthenticated DB lookup before this
    // gate would create a tenant-existence oracle (404 vs 401 distinguishes
    // existing-but-misconfigured from non-existent). Behavior:
    //   - non-existent tenant: OIDC verifier finds no Google creds row →
    //     UNAUTHENTICATED (401) — leaks no existence signal
    //   - inactive tenant with valid creds + valid JWT: passes OIDC, then
    //     the post-verify tenant check below surfaces TENANT_NOT_FOUND (404)
    //
    // This intentionally trades doc symmetry with the Apple route (which has
    // no auth gate at this layer) for security against tenant enumeration.
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    await deps.googleOidcVerifier.verify(tenantId, authHeader);
    await assertActiveTenant(tenantId);

    const body = await readJsonWithLimit(c);
    if (!body) {
      throw new AppError(ErrorCodes.INVALID_REQUEST, "Body must be a JSON object");
    }

    const result = await receiveGoogleWebhook(
      deps.db,
      { tenantId, body: body as Parameters<typeof receiveGoogleWebhook>[1]["body"] },
    );
    return c.json(result, 200);
  });

  return app;
}

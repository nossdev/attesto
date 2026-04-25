/**
 * Google OIDC JWT verification for Pub/Sub push subscriptions.
 *
 * When a Pub/Sub topic is configured with a push subscription + a service
 * account, Google signs an OIDC JWT with its service-account key and puts
 * it in the `Authorization: Bearer <jwt>` header of every push request.
 *
 * We verify:
 *   - JWT header `alg` is on an allowlist (no `none`, no HMAC variants)
 *   - Signature algorithm matches the JWK's key type/curve (no "alg
 *     confusion" where a caller claims one alg while the key is a
 *     different family)
 *   - Signature is valid against the corresponding JWKS key
 *   - `iss` ∈ {"accounts.google.com", "https://accounts.google.com"}
 *   - `exp` / `iat` within `skewSeconds` of now
 *   - `aud` matches the tenant's configured `pubsubAudience`
 *     (REQUIRED — the tenant boundary. Without it, any Google-signed JWT
 *     from any GCP customer would pass, since `iss` is shared across all
 *     Google OIDC tokens.)
 *
 * JWKS is cached for 1 hour with a rotation-retry: if we see a `kid`
 * that isn't in the cache, we evict and refetch once.
 */

import type { Database } from "@/db/client.ts";
import type { FetchLike } from "@/lib/http-utils.ts";
import { createTtlCache, type TtlCache } from "@/lib/ttl-cache.ts";
import { fromBase64Url } from "@/lib/crypto-utils.ts";
import { getGoogleCredentials } from "@/db/queries/google-credentials.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SKEW_SECONDS = 60;

interface GoogleJwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface Jwks {
  keys: GoogleJwk[];
}

export interface GoogleOidcVerifier {
  /**
   * Verify the Authorization header for a push to tenant `tenantId`.
   * Throws `AppError(UNAUTHENTICATED)` on any failure; returns silently
   * on success.
   */
  verify(tenantId: string, authorizationHeader: string | undefined): Promise<void>;
}

export interface CreateGoogleOidcVerifierOptions {
  db: Database;
  fetchImpl?: FetchLike;
  /** Override `now` for deterministic tests. Returns ms since epoch. */
  now?: () => number;
  /** JWKS override for tests — if set, HTTPS fetch is skipped. */
  jwksOverride?: Jwks;
  /** Tolerance for `exp` / `iat` skew in seconds. Default 60s — assumes
   * the deployment's clock is NTP-synced. Loosen to 300s for environments
   * running without reliable time sync. */
  skewSeconds?: number;
}

function decodeJwtParts(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: Uint8Array;
  signingInput: Uint8Array;
} {
  const segments = jwt.split(".");
  if (segments.length !== 3) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, "Malformed JWT: expected 3 segments");
  }
  const [h, c, s] = segments;
  const td = new TextDecoder();
  return {
    header: JSON.parse(td.decode(fromBase64Url(h!))) as Record<string, unknown>,
    claims: JSON.parse(td.decode(fromBase64Url(c!))) as Record<string, unknown>,
    signature: fromBase64Url(s!),
    signingInput: new TextEncoder().encode(`${h}.${c}`),
  };
}

/**
 * Derive the Web Crypto verify algorithm from the JWT header's `alg`
 * AND validate that the JWK's key family matches. This closes alg-
 * confusion attacks: a caller cannot claim `alg=ES256` while we verify
 * with RSA, or `alg=HS256` to sneak symmetric verification past an
 * asymmetric-only codepath, etc.
 *
 * Explicitly excludes `none` and all HMAC (`HS*`) variants. For the RSA
 * and EC families, the algorithm's hash size must match the JWT's
 * declared `alg`, and for EC the curve must match.
 */
function deriveVerifyAlgorithm(
  headerAlg: string,
  jwk: GoogleJwk,
): AlgorithmIdentifier | EcdsaParams | RsaPssParams {
  switch (headerAlg) {
    case "RS256":
    case "RS384":
    case "RS512": {
      if (jwk.kty !== "RSA") {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `JWT alg ${headerAlg} requires RSA key, JWK kty is ${jwk.kty}`,
        );
      }
      return {
        name: "RSASSA-PKCS1-v1_5",
        hash: `SHA-${headerAlg.slice(2)}`,
      } as AlgorithmIdentifier;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (jwk.kty !== "RSA") {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `JWT alg ${headerAlg} requires RSA key, JWK kty is ${jwk.kty}`,
        );
      }
      // PS* requires RSA-PSS with a salt length equal to the hash output.
      const bits = Number(headerAlg.slice(2));
      return { name: "RSA-PSS", hash: `SHA-${bits}`, saltLength: bits / 8 } as RsaPssParams;
    }
    case "ES256": {
      if (jwk.kty !== "EC" || (jwk.crv && jwk.crv !== "P-256")) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `JWT alg ES256 requires EC P-256 key, JWK is ${jwk.kty}/${jwk.crv ?? "?"}`,
        );
      }
      return { name: "ECDSA", hash: "SHA-256" } as EcdsaParams;
    }
    case "ES384": {
      if (jwk.kty !== "EC" || (jwk.crv && jwk.crv !== "P-384")) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `JWT alg ES384 requires EC P-384 key, JWK is ${jwk.kty}/${jwk.crv ?? "?"}`,
        );
      }
      return { name: "ECDSA", hash: "SHA-384" } as EcdsaParams;
    }
    case "ES512": {
      if (jwk.kty !== "EC" || (jwk.crv && jwk.crv !== "P-521")) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `JWT alg ES512 requires EC P-521 key, JWK is ${jwk.kty}/${jwk.crv ?? "?"}`,
        );
      }
      return { name: "ECDSA", hash: "SHA-512" } as EcdsaParams;
    }
    default:
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        `JWT alg "${headerAlg}" is not allowed (must be RS*/PS*/ES* with recognized hash)`,
      );
  }
}

function importParams(
  headerAlg: string,
  jwk: GoogleJwk,
): AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams {
  if (headerAlg.startsWith("RS")) {
    return { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${headerAlg.slice(2)}` };
  }
  if (headerAlg.startsWith("PS")) {
    return { name: "RSA-PSS", hash: `SHA-${headerAlg.slice(2)}` };
  }
  // ES256 → P-256, ES384 → P-384, ES512 → P-521
  const curve = headerAlg === "ES512" ? "P-521" : `P-${headerAlg.slice(2)}`;
  return { name: "ECDSA", namedCurve: jwk.crv ?? curve };
}

async function verifySignature(
  headerAlg: string,
  jwk: GoogleJwk,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (jwk.use === "enc") {
    // Encryption-only key; rejecting at Web Crypto would also work, but the
    // explicit check makes the intent clear.
    return false;
  }
  const verifyParams = deriveVerifyAlgorithm(headerAlg, jwk);
  const importAlgo = importParams(headerAlg, jwk);
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as unknown as JsonWebKey,
      importAlgo,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      verifyParams,
      key,
      signature.buffer as ArrayBuffer,
      signingInput.buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

export function createGoogleOidcVerifier(
  opts: CreateGoogleOidcVerifierOptions,
): GoogleOidcVerifier {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const skewSeconds = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const jwksCache: TtlCache<Jwks> = createTtlCache({ ttlMs: JWKS_CACHE_TTL_MS, now });

  async function fetchJwks(): Promise<Jwks> {
    if (opts.jwksOverride) return opts.jwksOverride;
    return await jwksCache.loadOrFetch("google", async () => {
      const res = await fetchImpl(GOOGLE_JWKS_URL, { method: "GET" });
      if (!res.ok) {
        throw new AppError(
          ErrorCodes.INTERNAL_ERROR,
          `Google JWKS fetch failed: ${res.status}`,
        );
      }
      return await res.json() as Jwks;
    });
  }

  return {
    async verify(tenantId, authorizationHeader) {
      if (!authorizationHeader) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          "Missing Authorization header on Google webhook",
        );
      }
      if (!authorizationHeader.startsWith("Bearer ")) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          "Authorization header must be Bearer token",
        );
      }
      const jwt = authorizationHeader.slice("Bearer ".length).trim();
      if (!jwt) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "Empty Bearer token");
      }

      const { header, claims, signature, signingInput } = decodeJwtParts(jwt);
      const kid = typeof header.kid === "string" ? header.kid : null;
      const alg = typeof header.alg === "string" ? header.alg : null;
      if (!kid) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "JWT missing `kid` header");
      }
      if (!alg) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "JWT missing `alg` header");
      }

      let jwks = await fetchJwks();
      let selectedKey = jwks.keys.find((k) => k.kid === kid);
      if (!selectedKey) {
        // Key rotation race: evict cache and try once more against the
        // freshly fetched JWKS (not the stale snapshot).
        jwksCache.delete("google");
        jwks = await fetchJwks();
        selectedKey = jwks.keys.find((k) => k.kid === kid);
        if (!selectedKey) {
          throw new AppError(
            ErrorCodes.UNAUTHENTICATED,
            `No matching Google JWK for kid="${kid}"`,
          );
        }
      }

      const sigValid = await verifySignature(alg, selectedKey, signingInput, signature);
      if (!sigValid) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "JWT signature verification failed");
      }

      const iss = typeof claims.iss === "string" ? claims.iss : null;
      if (!iss || !VALID_ISS.has(iss)) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, `Invalid issuer: ${iss ?? "(none)"}`);
      }
      const nowSec = Math.floor(now() / 1000);
      if (typeof claims.exp !== "number" || nowSec - skewSeconds > claims.exp) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "JWT expired");
      }
      if (typeof claims.iat === "number" && claims.iat - skewSeconds > nowSec) {
        throw new AppError(ErrorCodes.UNAUTHENTICATED, "JWT issued in the future");
      }

      // Audience check — REQUIRED. The `iss` claim alone is not a tenant
      // boundary: Google signs OIDC tokens for every GCP customer with the
      // same keys, so without an `aud` check any valid Google-signed JWT
      // (from unrelated projects) would pass. Tenants MUST configure
      // `pubsub_audience` when they set up Google credentials.
      const creds = await getGoogleCredentials(opts.db, tenantId);
      if (!creds) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          "Tenant has no google_credentials configured — cannot authenticate Google webhook",
        );
      }
      if (!creds.pubsubAudience) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          "Tenant has no pubsub_audience configured — run " +
            "`attesto google:set-credentials --pubsub-audience <aud>` to close this origin",
        );
      }
      const aud = typeof claims.aud === "string" ? claims.aud : null;
      if (aud !== creds.pubsubAudience) {
        throw new AppError(
          ErrorCodes.UNAUTHENTICATED,
          `Invalid audience: expected "${creds.pubsubAudience}", got "${aud ?? "(none)"}"`,
        );
      }
    },
  };
}

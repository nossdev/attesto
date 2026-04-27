/**
 * Signs JWTs for the Apple App Store Server API.
 *
 * Apple expects ES256 JWTs signed with the ECDSA P-256 private key stored in
 * the tenant's `.p8` file. Required claims for App Store Server API auth, per
 * Apple's reference implementation in @apple/app-store-server-library
 * (`AppStoreServerAPIClient.createBearerToken` in dist/index.js):
 *   - iss: Issuer ID from App Store Connect
 *   - iat: now (seconds)
 *   - exp: iat + 5 minutes (matches Apple SDK; max permitted by Apple is 60min)
 *   - aud: "appstoreconnect-v1"
 *   - bid: bundle id of the app
 *
 * Notably the JWT does NOT include a `nonce` claim — that's only required for
 * JWS signed-data signatures (e.g. promotional offers, JWS verification),
 * not for authenticating outbound API requests. Apple's auth strict-validates
 * the JWT and returns 401 for unknown claims.
 *
 * We use Web Crypto (no npm dep) since .p8 is a standard PKCS#8 PEM and
 * ES256 is natively supported by Deno's `crypto.subtle`.
 */

import { parsePkcs8Pem, toBase64Url, toBase64UrlString } from "@/lib/crypto-utils.ts";

// Match Apple SDK's default of 5 minutes (`expiresIn: '5m'` in createBearerToken).
// Apple permits up to 60 minutes; staying close to the SDK's value reduces the
// surface for any future server-side strictness changes.
const APPLE_JWT_TTL_SECONDS = 5 * 60;

export interface SignAppStoreConnectJwtInput {
  privateKeyPem: string; // .p8 file contents (PKCS#8 PEM)
  keyId: string; // Apple Key ID (10 chars)
  issuerId: string; // App Store Connect Issuer ID
  bundleId: string; // Application bundle ID
  /** Override `now` for deterministic tests. */
  now?: () => number;
}

async function importP256PrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = parsePkcs8Pem(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    // Scrub the underlying error message — Web Crypto implementations can
    // embed key-derived bytes in error text (implementation-defined). Even
    // a tiny leak into a log aggregator is an unbounded liability.
    throw new Error("Failed to import .p8 as ECDSA P-256 private key");
  }
}

export async function signAppStoreConnectJwt(input: SignAppStoreConnectJwtInput): Promise<string> {
  const key = await importP256PrivateKey(input.privateKeyPem);
  const nowMs = input.now ? input.now() : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + APPLE_JWT_TTL_SECONDS;

  const header = { alg: "ES256", kid: input.keyId, typ: "JWT" };
  const claims = {
    iss: input.issuerId,
    iat,
    exp,
    aud: "appstoreconnect-v1",
    bid: input.bundleId,
  };

  const encodedHeader = toBase64UrlString(JSON.stringify(header));
  const encodedClaims = toBase64UrlString(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);

  const signatureRaw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signingInput.buffer as ArrayBuffer,
    ),
  );
  return `${encodedHeader}.${encodedClaims}.${toBase64Url(signatureRaw)}`;
}

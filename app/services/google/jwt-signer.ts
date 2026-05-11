/**
 * Signs JWTs for Google's OAuth 2.0 service-account flow.
 *
 * Google uses RS256 (RSA-2048 PKCS#1 v1.5 signing) with the service-account
 * private key. Required claims per https://developers.google.com/identity/protocols/oauth2/service-account :
 *   - iss: service account email (client_email)
 *   - scope: space-separated list of OAuth scopes
 *   - aud: token_uri (usually https://oauth2.googleapis.com/token)
 *   - iat: now (seconds)
 *   - exp: iat + up to 1 hour (3600)
 *
 * Web Crypto (no npm dep) — service-account private keys are PKCS#8 PEM.
 */

import { parsePkcs8Pem, toBase64Url, toBase64UrlString } from "@/lib/crypto-utils.ts";

const GOOGLE_JWT_TTL_SECONDS = 3600; // Google's documented max.
export const ANDROIDPUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export interface SignGoogleServiceAccountJwtInput {
  privateKeyPem: string;
  clientEmail: string;
  tokenUri: string;
  scope?: string;
  now?: () => number;
}

async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = parsePkcs8Pem(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // Scrubbed — Web Crypto error messages are implementation-defined and
    // can embed key-derived bytes.
    throw new Error("Failed to import service-account private key as RSA-2048 PKCS#8");
  }
}

export async function signGoogleServiceAccountJwt(
  input: SignGoogleServiceAccountJwtInput,
): Promise<string> {
  const key = await importRs256PrivateKey(input.privateKeyPem);
  const nowMs = input.now ? input.now() : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + GOOGLE_JWT_TTL_SECONDS;

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: input.clientEmail,
    scope: input.scope ?? ANDROIDPUBLISHER_SCOPE,
    aud: input.tokenUri,
    iat,
    exp,
  };

  const encodedHeader = toBase64UrlString(JSON.stringify(header));
  const encodedClaims = toBase64UrlString(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);

  const signatureRaw = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      signingInput.buffer as ArrayBuffer,
    ),
  );
  return `${encodedHeader}.${encodedClaims}.${toBase64Url(signatureRaw)}`;
}

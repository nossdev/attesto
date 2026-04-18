/**
 * Signs JWTs for the Apple App Store Server API.
 *
 * Apple expects ES256 JWTs signed with the ECDSA P-256 private key stored in
 * the tenant's `.p8` file. Required claims per Apple's docs:
 *   - iss: Issuer ID from App Store Connect
 *   - iat: now (seconds)
 *   - exp: iat + up to 20 minutes
 *   - aud: "appstoreconnect-v1"
 *   - bid: bundle id of the app
 *   - nonce: unique per request (Apple rejects replays)
 *
 * We use Web Crypto (no npm dep) since .p8 is a standard PKCS#8 PEM and
 * ES256 is natively supported by Deno's `crypto.subtle`.
 */

const APPLE_JWT_TTL_SECONDS = 20 * 60; // Apple's documented maximum.

export interface SignAppStoreConnectJwtInput {
  privateKeyPem: string; // .p8 file contents (PKCS#8 PEM)
  keyId: string; // Apple Key ID (10 chars)
  issuerId: string; // App Store Connect Issuer ID
  bundleId: string; // Application bundle ID
  /** Override `now` for deterministic tests. */
  now?: () => number;
  /** Override `nonce` for deterministic tests. */
  nonce?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBase64UrlString(value: string): string {
  return toBase64Url(new TextEncoder().encode(value));
}

function parsePkcs8Pem(pem: string): ArrayBuffer {
  const trimmed = pem.trim();
  const markerMatch = trimmed.match(
    /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/,
  );
  if (!markerMatch) {
    throw new Error(
      "Invalid PEM: expected PKCS#8 markers (-----BEGIN PRIVATE KEY-----)",
    );
  }
  const body = markerMatch[1]!.replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
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

function randomNonce(): string {
  // 16 bytes → 22-char base64url (Apple just requires uniqueness per request).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
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
    nonce: input.nonce ?? randomNonce(),
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

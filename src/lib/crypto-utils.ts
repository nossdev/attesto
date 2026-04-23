/**
 * Shared crypto encoding helpers used by both Apple (ES256) and Google (RS256)
 * JWT signers. Every JWT signer needs base64url encoding and PKCS#8 PEM
 * parsing; rather than duplicate the functions per store, keep the bytes-only
 * utilities here.
 */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64UrlString(value: string): string {
  return toBase64Url(new TextEncoder().encode(value));
}

/**
 * Decode base64url (Uint8Array), tolerating missing `=` padding. The
 * counterpart to `toBase64Url`. Used across JWT / JWS decoders.
 */
export function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Parse a PKCS#8 PEM (the `-----BEGIN PRIVATE KEY-----` form) to a raw
 * ArrayBuffer suitable for `crypto.subtle.importKey("pkcs8", ...)`.
 * Throws with a clear message on malformed input — the thrown error never
 * includes key-derived bytes, so it's safe to surface to callers.
 */
export function parsePkcs8Pem(pem: string): ArrayBuffer {
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

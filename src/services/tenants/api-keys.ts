/**
 * API key generation, hashing, and verification.
 *
 * Key format: `attesto_live_<43-char base64url>` (43 chars ≈ 32 random bytes).
 * We store only `SHA-256(raw)` — the raw key is shown exactly once at creation.
 *
 * Verification uses timing-safe comparison on the hashes. Bearer-token auth in
 * middleware calls `hashApiKey(raw)` and looks up the row by that hash
 * through a partial unique index on active (non-revoked) keys.
 */

export const API_KEY_PREFIXES = {
  live: "attesto_live_",
  test: "attesto_test_",
} as const;

export type ApiKeyEnvironment = keyof typeof API_KEY_PREFIXES;

const RANDOM_BYTES = 32;
const IDENTIFYING_PREFIX_CHARS = 8;

export interface GeneratedApiKey {
  raw: string; // "attesto_live_..." — return to the caller exactly once.
  hash: string; // SHA-256 hex — store this.
  keyPrefix: string; // first 8 chars of the random suffix — store for UI identification.
}

function randomBase64url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  // btoa needs a binary string — safe because every byte is 0..255.
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generateApiKey(environment: ApiKeyEnvironment): Promise<GeneratedApiKey> {
  const suffix = randomBase64url(RANDOM_BYTES);
  const raw = `${API_KEY_PREFIXES[environment]}${suffix}`;
  const keyPrefix = suffix.slice(0, IDENTIFYING_PREFIX_CHARS);
  const hash = await hashApiKey(raw);
  return { raw, hash, keyPrefix };
}

export async function hashApiKey(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseApiKeyEnvironment(raw: string): ApiKeyEnvironment | null {
  for (const [env, prefix] of Object.entries(API_KEY_PREFIXES) as [ApiKeyEnvironment, string][]) {
    if (raw.startsWith(prefix)) return env;
  }
  return null;
}

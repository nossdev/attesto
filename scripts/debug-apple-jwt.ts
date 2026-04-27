/**
 * Diagnostic: sign a JWT with the same code path as production and call
 * Apple directly. Prints the full response body so we can see Apple's
 * errorCode (e.g. 4040002 / 4040003 / 4040004) which the production error
 * envelope doesn't surface.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/debug-apple-jwt.ts \
 *     <path-to-.p8> <KEY_ID> <ISSUER_ID> <BUNDLE_ID> [transactionId]
 *
 * The transactionId defaults to all-zeros (a known-bad ID — we don't expect
 * to find it; the point is to surface the auth result, not a real lookup).
 */

import { signAppStoreConnectJwt } from "@/services/apple/jwt-signer.ts";

const [keyPath, keyId, issuerId, bundleId, txId] = Deno.args;
if (!keyPath || !keyId || !issuerId || !bundleId) {
  console.error(
    "usage: deno run --allow-net --allow-read scripts/debug-apple-jwt.ts <p8> <KEY_ID> <ISSUER_ID> <BUNDLE_ID> [txId]",
  );
  Deno.exit(2);
}

const transactionId = txId ?? "0000000000000000";
const pem = await Deno.readTextFile(keyPath);

const jwt = await signAppStoreConnectJwt({
  privateKeyPem: pem,
  keyId,
  issuerId,
  bundleId,
});

// Decode the JWT for visibility (no signature verification).
const [h, c] = jwt.split(".");
const decoder = new TextDecoder();
const fromB64Url = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
};
console.log("Decoded JWT header:", JSON.parse(decoder.decode(fromB64Url(h!))));
console.log("Decoded JWT claims:", JSON.parse(decoder.decode(fromB64Url(c!))));

for (const env of ["production", "sandbox"] as const) {
  const baseUrl = env === "production"
    ? "https://api.storekit.itunes.apple.com"
    : "https://api.storekit-sandbox.itunes.apple.com";
  const url = `${baseUrl}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  console.log(`\n=== ${env.toUpperCase()} → ${url} ===`);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
    const text = await r.text();
    console.log(`status: ${r.status} ${r.statusText}`);
    console.log(`body:   ${text}`);
  } catch (err) {
    console.error(`fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

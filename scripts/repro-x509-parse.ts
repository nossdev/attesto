/**
 * Reproduces the Apple SDK's X509Certificate parsing path under Deno.
 *
 * The webhook verification failed with VerificationStatus=6 (INVALID_CERTIFICATE),
 * which the SDK throws when `new X509Certificate(Buffer.from(cert, 'base64'))`
 * raises. This script exercises that exact construction with several inputs to
 * isolate whether the failure is:
 *   (a) Deno's node:crypto X509Certificate is broken across the board
 *   (b) Specific to how the SDK passes a Node Buffer (vs Uint8Array)
 *   (c) Specific to Apple's leaf cert format (not testable here without a
 *       captured JWS — that's the next step if (a) and (b) both pass)
 *
 * Run:
 *   deno run --allow-read=app/services/apple/roots scripts/repro-x509-parse.ts
 */

import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";

const ROOTS_DIR = new URL("../app/services/apple/roots/", import.meta.url);
const ROOT_FILES = [
  "AppleIncRootCertificate.cer",
  "AppleRootCA-G2.cer",
  "AppleRootCA-G3.cer",
];

function tryParse(label: string, input: Uint8Array | Buffer): void {
  try {
    const cert = new X509Certificate(input as never);
    console.log(`OK  ${label}`);
    console.log(`     subject:   ${cert.subject.replace(/\n/g, "; ")}`);
    console.log(`     issuer:    ${cert.issuer.replace(/\n/g, "; ")}`);
    console.log(`     validTo:   ${cert.validTo}`);
  } catch (err) {
    console.log(`FAIL ${label}`);
    if (err instanceof Error) {
      console.log(`     name:    ${err.name}`);
      console.log(`     message: ${err.message || "(empty)"}`);
      console.log(`     keys:    ${Object.getOwnPropertyNames(err).join(", ")}`);
      const code = (err as { code?: unknown }).code;
      if (code !== undefined) console.log(`     code:    ${String(code)}`);
      const cause = (err as { cause?: unknown }).cause;
      if (cause !== undefined) console.log(`     cause:   ${String(cause)}`);
    } else {
      console.log(`     non-error throw: ${String(err)}`);
    }
  }
}

console.log("Deno + node:crypto X509Certificate reproducer");
console.log(`Deno: ${Deno.version.deno}, V8: ${Deno.version.v8}, TS: ${Deno.version.typescript}`);
console.log();

console.log("=== Test 1: bundled Apple root certs as Uint8Array (raw) ===");
for (const name of ROOT_FILES) {
  const der = await Deno.readFile(new URL(name, ROOTS_DIR));
  tryParse(`${name} as Uint8Array (${der.byteLength}B DER)`, der);
}
console.log();

console.log("=== Test 2: bundled Apple root certs wrapped in Node Buffer ===");
console.log(
  "(This mirrors how the SDK invokes it: `new X509Certificate(Buffer.from(b64, 'base64'))`)",
);
for (const name of ROOT_FILES) {
  const der = await Deno.readFile(new URL(name, ROOTS_DIR));
  const b64 = btoa(String.fromCharCode(...der));
  const buf = Buffer.from(b64, "base64");
  tryParse(`${name} as Buffer (Node-style)`, buf);
}
console.log();

console.log("=== Test 3: malformed input (negative control) ===");
tryParse("zero-length Buffer", Buffer.alloc(0));
tryParse("garbage bytes", new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
console.log();

console.log("=== Test 4: SDK re-classification — x5c with wrong chain length ===");
console.log("Hypothesis: SDK's verifyJWT() catches its own VerificationException(5)");
console.log("and re-throws as VerificationException(6) with the original as .cause.");
console.log("If true, our staging log's `sdkStatus:6` is actually status 5 in disguise.");
console.log();

import pkg from "npm:@apple/app-store-server-library@^3";
// deno-lint-ignore no-explicit-any
const { SignedDataVerifier, Environment } = pkg as any;

// Build a JWS with x5c.length === 2 (vs the required 3). Body/sig are dummy
// bytes — we never reach signature verification because the SDK rejects on
// x5c length first.
function makeJwsWithBadChain(x5cLen: number): string {
  const header = {
    alg: "ES256",
    x5c: Array.from({ length: x5cLen }, () => "MIIBzjCCAXMCFAo="), // placeholder b64
  };
  const payload = { data: { bundleId: "com.example.app", environment: "Sandbox" } };
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc(header)}.${enc(payload)}.AAAA`;
}

const roots = await Promise.all(
  ROOT_FILES.map((n) => Deno.readFile(new URL(n, ROOTS_DIR))),
);
const verifier = new SignedDataVerifier(
  roots.map((r) => Buffer.from(r)),
  false,
  Environment.SANDBOX,
  "com.example.app",
);

for (const len of [2, 3, 4]) {
  const jws = makeJwsWithBadChain(len);
  try {
    await verifier.verifyAndDecodeNotification(jws);
    console.log(`x5c.length=${len}: unexpectedly succeeded`);
  } catch (err) {
    const e = err as { status?: unknown; cause?: { status?: unknown; message?: unknown } };
    console.log(
      `x5c.length=${len}: outer status=${e.status}, inner status=${
        e.cause?.status ?? "(none)"
      }, inner message="${e.cause?.message ?? ""}"`,
    );
  }
}
console.log();

console.log("=== Done ===");
console.log(
  "If all of Test 1+2 succeeded → Deno's X509Certificate works for known-good Apple roots.",
);
console.log(
  "If Test 2 fails but Test 1 passes → SDK's Buffer-based call is the issue (Deno compat quirk).",
);
console.log(
  "If both fail → general Deno X509Certificate problem; need to swap the verifier path.",
);

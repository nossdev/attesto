import { assert, assertEquals, assertRejects } from "@std/assert";
import { signAppStoreConnectJwt } from "@/services/apple/jwt-signer.ts";

// Apple's docs require ES256; .p8 files are EC P-256 PKCS#8 PEMs.
// Generate a throwaway P-256 keypair per test run and export the PEM;
// deterministic fixtures would couple the test to a keypair we'd have to
// rotate, which provides no additional signal.
async function generateTestP8Pem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  // Convert to PEM.
  let b64 = "";
  for (const byte of pkcs8) b64 += String.fromCharCode(byte);
  const encoded = btoa(b64).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodeJwtHeaderAndClaims(jwt: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: Uint8Array;
} {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) throw new Error("malformed JWT");
  const decoder = new TextDecoder();
  return {
    header: JSON.parse(decoder.decode(b64urlToBytes(h))) as Record<string, unknown>,
    claims: JSON.parse(decoder.decode(b64urlToBytes(c))) as Record<string, unknown>,
    signature: b64urlToBytes(s),
  };
}

Deno.test("apple jwt: header has alg=ES256, typ=JWT, kid=<keyId>", async () => {
  const pem = await generateTestP8Pem();
  const jwt = await signAppStoreConnectJwt({
    privateKeyPem: pem,
    keyId: "ABC1234567",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    bundleId: "com.example.app",
  });
  const { header } = decodeJwtHeaderAndClaims(jwt);
  assertEquals(header.alg, "ES256");
  assertEquals(header.typ, "JWT");
  assertEquals(header.kid, "ABC1234567");
});

Deno.test("apple jwt: claims match Apple SDK (iss, aud=appstoreconnect-v1, bid, iat, exp; no nonce)", async () => {
  const pem = await generateTestP8Pem();
  const before = Math.floor(Date.now() / 1000);
  const jwt = await signAppStoreConnectJwt({
    privateKeyPem: pem,
    keyId: "KEY1234567",
    issuerId: "iss-1234",
    bundleId: "com.example.app",
  });
  const { claims } = decodeJwtHeaderAndClaims(jwt);
  assertEquals(claims.iss, "iss-1234");
  assertEquals(claims.aud, "appstoreconnect-v1");
  assertEquals(claims.bid, "com.example.app");
  assert(typeof claims.iat === "number" && claims.iat >= before);
  assert(typeof claims.exp === "number" && claims.exp > (claims.iat as number));
  // Apple's reference SDK does NOT include a nonce claim for App Store Server
  // API auth; the API rejects JWTs with the unknown claim with 401.
  assertEquals(claims.nonce, undefined);
});

Deno.test("apple jwt: exp is iat + 5 minutes (matches Apple SDK's expiresIn: '5m')", async () => {
  const pem = await generateTestP8Pem();
  const jwt = await signAppStoreConnectJwt({
    privateKeyPem: pem,
    keyId: "K",
    issuerId: "I",
    bundleId: "com.example.app",
  });
  const { claims } = decodeJwtHeaderAndClaims(jwt);
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  assertEquals(exp - iat, 5 * 60);
});

Deno.test("apple jwt: signature verifies against the P-256 public key", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let b64 = "";
  for (const byte of pkcs8) b64 += String.fromCharCode(byte);
  const encoded = btoa(b64).match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;

  const jwt = await signAppStoreConnectJwt({
    privateKeyPem: pem,
    keyId: "K",
    issuerId: "I",
    bundleId: "com.example.app",
  });

  const [h, c, s] = jwt.split(".");
  const signingInput = new TextEncoder().encode(`${h}.${c}`);
  const sig = b64urlToBytes(s!);
  const buf = new ArrayBuffer(sig.byteLength);
  new Uint8Array(buf).set(sig);
  const inBuf = new ArrayBuffer(signingInput.byteLength);
  new Uint8Array(inBuf).set(signingInput);

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    kp.publicKey,
    buf,
    inBuf,
  );
  assert(verified, "JWT signature must verify with the signing key's public half");
});

Deno.test("apple jwt: rejects non-PKCS8 PEM with a clear error", async () => {
  await assertRejects(
    () =>
      signAppStoreConnectJwt({
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nnot-real-base64-data\n-----END PRIVATE KEY-----",
        keyId: "K",
        issuerId: "I",
        bundleId: "com.example.app",
      }),
    Error,
  );
});

Deno.test("apple jwt: rejects missing PEM markers", async () => {
  await assertRejects(
    () =>
      signAppStoreConnectJwt({
        privateKeyPem: "no pem markers here",
        keyId: "K",
        issuerId: "I",
        bundleId: "com.example.app",
      }),
    Error,
    "PEM",
  );
});

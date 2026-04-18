import { assert, assertEquals, assertRejects } from "@std/assert";
import { signGoogleServiceAccountJwt } from "@/services/google/jwt-signer.ts";

async function generateTestRsaPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let b64 = "";
  for (const byte of pkcs8) b64 += String.fromCharCode(byte);
  const encoded = btoa(b64).match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: kp.publicKey };
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) throw new Error("malformed JWT");
  const td = new TextDecoder();
  return {
    header: JSON.parse(td.decode(b64urlToBytes(h))) as Record<string, unknown>,
    claims: JSON.parse(td.decode(b64urlToBytes(c))) as Record<string, unknown>,
    signature: b64urlToBytes(s),
    signingInput: `${h}.${c}`,
  };
}

Deno.test("google jwt: header alg=RS256 typ=JWT, no kid (Google does not require kid here)", async () => {
  const { pem } = await generateTestRsaPem();
  const jwt = await signGoogleServiceAccountJwt({
    privateKeyPem: pem,
    clientEmail: "svc@project.iam.gserviceaccount.com",
    tokenUri: "https://oauth2.googleapis.com/token",
  });
  const { header } = decodeJwt(jwt);
  assertEquals(header.alg, "RS256");
  assertEquals(header.typ, "JWT");
});

Deno.test("google jwt: claims iss/aud/scope/iat/exp", async () => {
  const { pem } = await generateTestRsaPem();
  const before = Math.floor(Date.now() / 1000);
  const jwt = await signGoogleServiceAccountJwt({
    privateKeyPem: pem,
    clientEmail: "svc@project.iam.gserviceaccount.com",
    tokenUri: "https://oauth2.googleapis.com/token",
  });
  const { claims } = decodeJwt(jwt);
  assertEquals(claims.iss, "svc@project.iam.gserviceaccount.com");
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assertEquals(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert(typeof claims.iat === "number" && claims.iat >= before);
  assertEquals((claims.exp as number) - (claims.iat as number), 3600);
});

Deno.test("google jwt: signature verifies with the matching public key", async () => {
  const { pem, publicKey } = await generateTestRsaPem();
  const jwt = await signGoogleServiceAccountJwt({
    privateKeyPem: pem,
    clientEmail: "svc@example.iam.gserviceaccount.com",
    tokenUri: "https://oauth2.googleapis.com/token",
  });
  const { signature, signingInput } = decodeJwt(jwt);
  const signingInputBytes = new TextEncoder().encode(signingInput);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature.buffer as ArrayBuffer,
    signingInputBytes.buffer as ArrayBuffer,
  );
  assert(ok, "signature must verify against the signing key's public half");
});

Deno.test("google jwt: respects custom scope", async () => {
  const { pem } = await generateTestRsaPem();
  const jwt = await signGoogleServiceAccountJwt({
    privateKeyPem: pem,
    clientEmail: "svc@example.iam.gserviceaccount.com",
    tokenUri: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
  });
  const { claims } = decodeJwt(jwt);
  assertEquals(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
});

Deno.test("google jwt: rejects malformed PEM", async () => {
  await assertRejects(
    () =>
      signGoogleServiceAccountJwt({
        privateKeyPem: "not a pem",
        clientEmail: "svc@example.iam.gserviceaccount.com",
        tokenUri: "https://oauth2.googleapis.com/token",
      }),
    Error,
    "PEM",
  );
});

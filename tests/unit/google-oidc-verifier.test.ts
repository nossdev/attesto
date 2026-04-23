import { assertRejects } from "@std/assert";
import { createGoogleOidcVerifier } from "@/services/google/oidc-verifier.ts";
import type { Database } from "@/db/client.ts";
import { AppError } from "@/lib/errors.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function generateRsaKeypair() {
  return await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function exportJwk(publicKey: CryptoKey, kid: string) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlString(value: string): string {
  return b64url(new TextEncoder().encode(value));
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const h = b64urlString(JSON.stringify(header));
  const c = b64urlString(JSON.stringify(claims));
  const input = new TextEncoder().encode(`${h}.${c}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, input.buffer as ArrayBuffer),
  );
  return `${h}.${c}.${b64url(sig)}`;
}

type RowShape = {
  tenantId: string;
  packageName: string;
  serviceAccountEnc: Uint8Array;
  pubsubAudience: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeChain(row: RowShape | null): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  return { select: () => chain } as unknown as Database;
}

// Row exists with a non-null pubsub_audience — the happy case.
function fakeDbWithAudience(audience: string): Database {
  return makeChain({
    tenantId: "tenant_x",
    packageName: "com.example.app",
    serviceAccountEnc: new Uint8Array(0),
    pubsubAudience: audience,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// Row exists but pubsub_audience is NULL — tenant forgot to set it.
function fakeDbRowNullAudience(): Database {
  return makeChain({
    tenantId: "tenant_x",
    packageName: "com.example.app",
    serviceAccountEnc: new Uint8Array(0),
    pubsubAudience: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// No row at all — tenant hasn't configured Google creds.
function fakeDbNoRow(): Database {
  return makeChain(null);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("google oidc: rejects missing Authorization header", async () => {
  const verifier = createGoogleOidcVerifier({ db: fakeDbNoRow() });
  await assertRejects(() => verifier.verify("tenant_x", undefined), AppError, "Missing");
});

Deno.test("google oidc: rejects non-Bearer scheme", async () => {
  const verifier = createGoogleOidcVerifier({ db: fakeDbNoRow() });
  await assertRejects(() => verifier.verify("tenant_x", "Basic abc"), AppError, "Bearer");
});

Deno.test("google oidc: rejects empty bearer", async () => {
  const verifier = createGoogleOidcVerifier({ db: fakeDbNoRow() });
  await assertRejects(() => verifier.verify("tenant_x", "Bearer "), AppError, "Empty");
});

Deno.test("google oidc: rejects malformed JWT (non-3 segments)", async () => {
  const verifier = createGoogleOidcVerifier({ db: fakeDbNoRow() });
  await assertRejects(() => verifier.verify("tenant_x", "Bearer not.a"), AppError, "Malformed");
});

Deno.test("google oidc: rejects JWT without kid header", async () => {
  const { privateKey } = await generateRsaKeypair();
  // Hand-build a JWT with no kid.
  const h = b64urlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const c = b64urlString(JSON.stringify({
    iss: "accounts.google.com",
    aud: "https://x.example/hook",
    exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const input = new TextEncoder().encode(`${h}.${c}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, input.buffer as ArrayBuffer),
  );
  const jwt = `${h}.${c}.${b64url(sig)}`;

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [] },
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "kid");
});

Deno.test("google oidc: rejects when tenant has no google_credentials row (C2)", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "test-kid-1");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "test-kid-1", {
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now - 10,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(
    () => verifier.verify("tenant_x", `Bearer ${jwt}`),
    AppError,
    "google_credentials",
  );
});

Deno.test("google oidc: rejects when tenant row has NULL pubsub_audience (C2)", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "test-kid-null-aud");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "test-kid-null-aud", {
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now - 10,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbRowNullAudience(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(
    () => verifier.verify("tenant_x", `Bearer ${jwt}`),
    AppError,
    "pubsub_audience",
  );
});

// ─── C1: algorithm confusion resistance ──────────────────────────────────────

Deno.test("google oidc: rejects JWT with alg=none (C1)", async () => {
  const { publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-none");
  const now = 1_700_000_000;
  // Hand-build a JWT with alg=none and an empty signature.
  const h = b64urlString(JSON.stringify({ alg: "none", typ: "JWT", kid: "kid-none" }));
  const c = b64urlString(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now,
  }));
  const jwt = `${h}.${c}.`;

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://example.com/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "alg");
});

Deno.test("google oidc: rejects JWT with alg=HS256 (symmetric — C1)", async () => {
  const { publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-hs");
  const now = 1_700_000_000;
  // Attacker claims HS256 — if we blindly used kty=RSA → RSASSA-PKCS1-v1_5,
  // this would NOT verify because the signature is wrong alg. But the real
  // bug is accepting HS* at all: an attacker who has the RSA public key
  // could sign an HMAC with it as the shared secret. We must reject HS*
  // outright.
  const h = b64urlString(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "kid-hs" }));
  const c = b64urlString(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now,
  }));
  const jwt = `${h}.${c}.ZmFrZXNpZw`;

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://example.com/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "alg");
});

Deno.test("google oidc: rejects alg/kty mismatch (ES256 on RSA key — C1)", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-mismatch");
  const now = 1_700_000_000;
  // JWT claims ES256 but the JWK under that kid is RSA. Even if the
  // signature happened to "work" (it won't — different alg families) we
  // must reject on the type mismatch.
  const h = b64urlString(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "kid-mismatch" }));
  const claims = {
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now,
  };
  const cEnc = b64urlString(JSON.stringify(claims));
  const input = new TextEncoder().encode(`${h}.${cEnc}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, input.buffer as ArrayBuffer),
  );
  const jwt = `${h}.${cEnc}.${b64url(sig)}`;

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://example.com/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(
    () => verifier.verify("tenant_x", `Bearer ${jwt}`),
    AppError,
    "RSA",
  );
});

Deno.test("google oidc: rejects JWT missing alg header (C1)", async () => {
  const { publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-noalg");
  const now = 1_700_000_000;
  const h = b64urlString(JSON.stringify({ typ: "JWT", kid: "kid-noalg" }));
  const c = b64urlString(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "https://example.com/hook",
    exp: now + 300,
    iat: now,
  }));
  const jwt = `${h}.${c}.ZmFrZQ`;

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://example.com/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "alg");
});

Deno.test("google oidc: rejects expired JWT", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "test-kid-2");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "test-kid-2", {
    iss: "https://accounts.google.com",
    aud: "https://x/hook",
    exp: now - 1000, // expired
    iat: now - 2000,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "expired");
});

Deno.test("google oidc: rejects wrong issuer", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "test-kid-3");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "test-kid-3", {
    iss: "https://attacker.example.com",
    aud: "https://x/hook",
    exp: now + 300,
    iat: now,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "issuer");
});

Deno.test("google oidc: rejects JWT signed with a different key than JWKS claims", async () => {
  const { privateKey: realPrivate, publicKey: realPublic } = await generateRsaKeypair();
  const { privateKey: attackerPrivate } = await generateRsaKeypair();
  const jwk = await exportJwk(realPublic, "kid-x");
  const now = 1_700_000_000;
  // Attacker signs a JWT with `kid-x` but uses THEIR private key — since
  // JWKS only has the real public key, signature verify fails.
  const jwt = await signJwt(attackerPrivate, "kid-x", {
    iss: "https://accounts.google.com",
    aud: "https://x/hook",
    exp: now + 300,
    iat: now,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "signature");
  // Satisfy the TS compiler on the unused realPrivate binding.
  void realPrivate;
});

Deno.test("google oidc: rejects JWT whose aud does not match tenant's configured pubsubAudience", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-aud");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "kid-aud", {
    iss: "https://accounts.google.com",
    aud: "https://wrong.example/hook",
    exp: now + 300,
    iat: now,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://expected.example/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(
    () => verifier.verify("tenant_x", `Bearer ${jwt}`),
    AppError,
    "audience",
  );
});

Deno.test("google oidc: accepts matching aud", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "kid-ok");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "kid-ok", {
    iss: "https://accounts.google.com",
    aud: "https://expected.example/hook",
    exp: now + 300,
    iat: now,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbWithAudience("https://expected.example/hook"),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await verifier.verify("tenant_x", `Bearer ${jwt}`);
});

Deno.test("google oidc: rejects unknown kid even when signature would verify", async () => {
  const { privateKey, publicKey } = await generateRsaKeypair();
  const jwk = await exportJwk(publicKey, "real-kid");
  const now = 1_700_000_000;
  const jwt = await signJwt(privateKey, "unknown-kid", {
    iss: "https://accounts.google.com",
    aud: "https://x/hook",
    exp: now + 300,
    iat: now,
  });

  const verifier = createGoogleOidcVerifier({
    db: fakeDbNoRow(),
    jwksOverride: { keys: [jwk as unknown as { kid: string; kty: string }] },
    now: () => now * 1000,
  });
  await assertRejects(() => verifier.verify("tenant_x", `Bearer ${jwt}`), AppError, "JWK");
});

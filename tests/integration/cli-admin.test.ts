import { assert, assertEquals } from "@std/assert";
import type { AdminContext } from "@/cli/admin.ts";
import {
  type CliIO,
  runKeyCreate,
  runKeyList,
  runKeyRevoke,
  runTenantCreate,
  runTenantDeactivate,
  runTenantList,
  runWebhookGet,
  runWebhookSetConfig,
} from "@/cli/admin.ts";
import { getTenantById } from "@/db/queries/tenants.ts";
import { findActiveKeyByHash } from "@/db/queries/api-keys.ts";
import { hashApiKey } from "@/services/tenants/api-keys.ts";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import type { DbHandle } from "@/db/client.ts";
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

const TEST_KEY_B64 = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=";

function ctxFrom(handle: DbHandle): AdminContext {
  return { db: handle, encryption: createEncryptionService(TEST_KEY_B64) };
}

function captureIo(): { io: CliIO; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return { io: { write: (l) => out.push(l), err: (l) => errs.push(l) }, out, errs };
}

async function createSampleTenant(ctx: AdminContext, name = "Acme"): Promise<string> {
  const io = captureIo();
  await runTenantCreate(ctx, ["--name", name], io.io);
  const line = io.out[0];
  assert(line !== undefined);
  return JSON.parse(line).id;
}

Deno.test({
  name: "cli: tenant:create prints JSON with id and name",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, out, errs } = captureIo();
      const code = await runTenantCreate(ctx, ["--name", "Acme Inc"], io);
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      assertEquals(out.length, 1);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.name, "Acme Inc");
      assert(typeof parsed.id === "string" && parsed.id.startsWith("tenant_"));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:create rejects missing --name with exit 2",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, errs } = captureIo();
      const code = await runTenantCreate(ctx, [], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("tenant:create")));
      assert(errs.some((e) => e.toLowerCase().includes("name")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:list outputs one JSON line per tenant, newest first",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      await runTenantCreate(ctx, ["--name", "First"], captureIo().io);
      await new Promise((r) => setTimeout(r, 10));
      await runTenantCreate(ctx, ["--name", "Second"], captureIo().io);

      const { io, out } = captureIo();
      const code = await runTenantList(ctx, [], io);
      assertEquals(code, 0);
      assertEquals(out.length, 2);
      const first = out[0];
      const second = out[1];
      assert(first !== undefined && second !== undefined);
      const names = [JSON.parse(first).name, JSON.parse(second).name];
      assertEquals(names, ["Second", "First"]);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:create prints raw key exactly once and stores only its hash",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);

      const { io, out, errs } = captureIo();
      const code = await runKeyCreate(ctx, [tenantId, "--env", "test"], io);
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assert(typeof parsed.rawKey === "string" && parsed.rawKey.startsWith("attesto_test_"));
      assertEquals(parsed.tenantId, tenantId);

      // keyPrefix in output matches first 8 chars of the random suffix.
      const suffix = parsed.rawKey.slice("attesto_test_".length);
      assertEquals(parsed.keyPrefix, suffix.slice(0, 8));

      // Hash lookup proves the raw key was stored correctly.
      const hashed = await hashApiKey(parsed.rawKey);
      const found = await findActiveKeyByHash(handle.db, hashed);
      assert(found !== null);
      assertEquals(found.id, parsed.id);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:create rejects invalid --env",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runKeyCreate(ctx, [tenantId, "--env", "staging"], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("env")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:create rejects malformed tenant_id before touching DB",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, errs } = captureIo();
      const code = await runKeyCreate(ctx, ["not-a-tenant-id"], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("tenantId")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:revoke rejects malformed key_id before touching DB",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, errs } = captureIo();
      const code = await runKeyRevoke(ctx, ["garbage"], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("keyId")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:revoke marks the key revoked and returns 1 on repeat",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);

      const io2 = captureIo();
      await runKeyCreate(ctx, [tenantId], io2.io);
      const keyLine = io2.out[0];
      assert(keyLine !== undefined);
      const keyId = JSON.parse(keyLine).id;

      const first = captureIo();
      const code1 = await runKeyRevoke(ctx, [keyId], first.io);
      assertEquals(code1, 0);
      const firstOut = first.out[0];
      assert(firstOut !== undefined);
      assert(JSON.parse(firstOut).revokedAt !== null);

      const second = captureIo();
      const code2 = await runKeyRevoke(ctx, [keyId], second.io);
      assertEquals(code2, 1);
      assert(second.errs[0]?.includes("not found or already revoked"));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:list shows keys with revocation state",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);

      const io2 = captureIo();
      await runKeyCreate(ctx, [tenantId, "--name", "prod"], io2.io);
      const keyLine = io2.out[0];
      assert(keyLine !== undefined);
      const keyId = JSON.parse(keyLine).id;
      await runKeyRevoke(ctx, [keyId], captureIo().io);

      const { io, out } = captureIo();
      const code = await runKeyList(ctx, [tenantId], io);
      assertEquals(code, 0);
      assertEquals(out.length, 1);
      const listedLine = out[0];
      assert(listedLine !== undefined);
      const listed = JSON.parse(listedLine);
      assertEquals(listed.name, "prod");
      assert(listed.revokedAt !== null);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: key:list respects --limit and --offset",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      for (let i = 0; i < 3; i++) {
        await runKeyCreate(ctx, [tenantId, "--name", `k${i}`], captureIo().io);
      }

      const limited = captureIo();
      await runKeyList(ctx, [tenantId, "--limit", "2"], limited.io);
      assertEquals(limited.out.length, 2);

      const offsetted = captureIo();
      await runKeyList(ctx, [tenantId, "--limit", "2", "--offset", "2"], offsetted.io);
      assertEquals(offsetted.out.length, 1);
    } finally {
      await teardown();
    }
  },
});

// ─── apple:set-credentials ────────────────────────────────────────────────────

import { runAppleSetCredentials } from "@/cli/admin.ts";
import { getAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { APPLE_PRIVATE_KEY_ENC_CONTEXT } from "@/services/apple/credentials-loader.ts";

async function writeP8Fixture(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let b64 = "";
  for (const byte of pkcs8) b64 += String.fromCharCode(byte);
  const encoded = btoa(b64).match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
  const path = await Deno.makeTempFile({ prefix: "attesto-p8-", suffix: ".p8" });
  await Deno.writeTextFile(path, pem);
  return path;
}

Deno.test({
  name: "cli: apple:set-credentials stores encrypted .p8 and returns tenant/kid",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);

      const { io, out, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
          "--environment",
          "sandbox",
        ],
        io,
      );
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.bundleId, "com.example.app");
      assertEquals(parsed.keyId, "ABC1234567");
      assertEquals(parsed.environment, "sandbox");

      // Stored row has ciphertext (not plaintext PEM); decryption returns original.
      const row = await getAppleCredentials(handle.db, tenantId);
      assert(row !== null);
      const plaintext = await ctx.encryption.decryptString(
        row.privateKeyEnc,
        APPLE_PRIVATE_KEY_ENC_CONTEXT,
      );
      assert(plaintext.includes("-----BEGIN PRIVATE KEY-----"));
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials accepts --app-apple-id and stores it",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, out } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
          "--environment",
          "production",
          "--app-apple-id",
          "1234567890",
        ],
        io,
      );
      assertEquals(code, 0);
      const parsed = JSON.parse(out[0]!);
      assertEquals(parsed.appAppleId, 1234567890);
      const row = await getAppleCredentials(handle.db, tenantId);
      assertEquals(row?.appAppleId, 1234567890);
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials warns on production env without --app-apple-id",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
          "--environment",
          "production",
        ],
        io,
      );
      assertEquals(code, 0); // succeeds — warning is not a hard block
      assert(
        errs.some((e) => e.includes("--app-apple-id not set")),
        `expected stderr to include the missing-app-apple-id warning, got: ${errs.join("\n")}`,
      );
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials sandbox env does NOT warn about --app-apple-id",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
          "--environment",
          "sandbox",
        ],
        io,
      );
      assertEquals(code, 0);
      assertEquals(errs.length, 0, `expected no warnings for sandbox env, got: ${errs.join("\n")}`);
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials rejects non-numeric --app-apple-id",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
          "--app-apple-id",
          "not-a-number",
        ],
        io,
      );
      assertEquals(code, 2); // Zod validation failure
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials rejects malformed Key ID (not 10 uppercase chars)",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const p8Path = await writeP8Fixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "abc", // too short and lowercase
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          p8Path,
        ],
        io,
      );
      assertEquals(code, 2);
      assert(errs.some((e) => e.toLowerCase().includes("keyid")));
    } finally {
      await Deno.remove(p8Path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials rejects non-existent key path",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          "/tmp/definitely-not-a-real-p8-file-xyz.p8",
        ],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("Failed to read")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: apple:set-credentials rejects PEM that is not parseable as ECDSA P-256",
  ignore: shouldSkipIntegration,
  async fn() {
    // The .p8 has the right markers but a body that won't import as a
    // valid EC P-256 key. The CLI should refuse to store it and surface
    // a clear error.
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const path = await Deno.makeTempFile({ prefix: "attesto-bad-p8-", suffix: ".p8" });
    await Deno.writeTextFile(
      path,
      "-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PRIVATE KEY-----\n",
    );
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runAppleSetCredentials(
        ctx,
        [
          tenantId,
          "--bundle-id",
          "com.example.app",
          "--key-id",
          "ABC1234567",
          "--issuer-id",
          "57246542-96fe-1a63-e053-0824d011072a",
          "--key-path",
          path,
        ],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("ECDSA P-256")));
    } finally {
      await Deno.remove(path).catch(() => {});
      await teardown();
    }
  },
});

// ─── google:set-credentials ───────────────────────────────────────────────────

import { runGoogleSetCredentials } from "@/cli/admin.ts";
import { getGoogleCredentials } from "@/db/queries/google-credentials.ts";
import { GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT } from "@/services/google/credentials-loader.ts";

async function generateRsaPkcs8Pem(): Promise<string> {
  // google:set-credentials now parse-validates the private_key as RSA
  // PKCS#8 before storing, so the test fixture needs a real key (a
  // throwaway one — generated per test run, never persisted, never
  // touches Google).
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
  let bin = "";
  for (const byte of pkcs8) bin += String.fromCharCode(byte);
  const encoded = btoa(bin).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
}

async function writeServiceAccountFixture(): Promise<string> {
  // Structurally valid service-account JSON with a real (throwaway) RSA
  // PKCS#8 private_key. The key is generated per call and never used
  // outside this test — it just satisfies the CLI's parse-validation.
  const payload = {
    type: "service_account",
    project_id: "test-project",
    private_key_id: "kid-123",
    private_key: await generateRsaPkcs8Pem(),
    client_email: "svc@test-project.iam.gserviceaccount.com",
    client_id: "1234567890",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  const path = await Deno.makeTempFile({ prefix: "attesto-sa-", suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify(payload));
  return path;
}

Deno.test({
  name: "cli: google:set-credentials stores encrypted service account JSON",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const saPath = await writeServiceAccountFixture();
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, out, errs } = captureIo();
      const code = await runGoogleSetCredentials(
        ctx,
        [tenantId, "--package-name", "com.example.app", "--service-account-path", saPath],
        io,
      );
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.tenantId, tenantId);
      assertEquals(parsed.packageName, "com.example.app");

      // The stored service_account JSON decrypts to the original payload.
      const row = await getGoogleCredentials(handle.db, tenantId);
      assert(row !== null);
      const decrypted = await ctx.encryption.decryptString(
        row.serviceAccountEnc,
        GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT,
      );
      const sa = JSON.parse(decrypted);
      assertEquals(sa.type, "service_account");
      assertEquals(sa.client_email, "svc@test-project.iam.gserviceaccount.com");
    } finally {
      await Deno.remove(saPath).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: google:set-credentials rejects unparseable RSA private_key",
  ignore: shouldSkipIntegration,
  async fn() {
    // Structurally valid service-account JSON, but private_key is a PEM
    // whose body won't import as RSA. Most-common real-world cause:
    // operator pasted JSON via a shell that escaped \n as the literal
    // characters \\n. The CLI should refuse to store it.
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const path = await Deno.makeTempFile({ prefix: "attesto-bad-sa-", suffix: ".json" });
    const payload = {
      type: "service_account",
      project_id: "test-project",
      private_key_id: "kid-bad",
      private_key: "-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PRIVATE KEY-----\n",
      client_email: "svc@test-project.iam.gserviceaccount.com",
      client_id: "1",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    await Deno.writeTextFile(path, JSON.stringify(payload));
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runGoogleSetCredentials(
        ctx,
        [tenantId, "--package-name", "com.example.app", "--service-account-path", path],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("unparseable private_key")));
    } finally {
      await Deno.remove(path).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: google:set-credentials rejects malformed JSON file",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const badPath = await Deno.makeTempFile({ prefix: "bad-sa-", suffix: ".json" });
    await Deno.writeTextFile(badPath, "{ not valid json");
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runGoogleSetCredentials(
        ctx,
        [tenantId, "--package-name", "com.example.app", "--service-account-path", badPath],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("not valid JSON")));
    } finally {
      await Deno.remove(badPath).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: google:set-credentials rejects JSON missing required service_account fields",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    const badPath = await Deno.makeTempFile({ prefix: "bad-sa-", suffix: ".json" });
    await Deno.writeTextFile(badPath, JSON.stringify({ type: "oauth_client", foo: "bar" }));
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runGoogleSetCredentials(
        ctx,
        [tenantId, "--package-name", "com.example.app", "--service-account-path", badPath],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("not a Google service-account JSON")));
    } finally {
      await Deno.remove(badPath).catch(() => {});
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: google:set-credentials rejects non-existent service account path",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runGoogleSetCredentials(
        ctx,
        [
          tenantId,
          "--package-name",
          "com.example.app",
          "--service-account-path",
          "/tmp/no-such-file-xyz.json",
        ],
        io,
      );
      assertEquals(code, 1);
      assert(errs.some((e) => e.includes("Failed to read")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:deactivate flips is_active=false on a fresh tenant",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, out, errs } = captureIo();
      const code = await runTenantDeactivate(ctx, [tenantId], io);
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.id, tenantId);
      assertEquals(parsed.isActive, false);
      assert(typeof parsed.deactivatedAt === "string");

      // Verify the row in the DB was actually flipped.
      const row = await getTenantById(handle.db, tenantId);
      assert(row !== null);
      assertEquals(row.isActive, false);
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:deactivate returns exit 1 on already-deactivated tenant",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      // First call succeeds.
      await runTenantDeactivate(ctx, [tenantId], captureIo().io);
      // Second call must surface "already deactivated" with exit 1 — not 0,
      // not 2, so scripts can distinguish the no-op case from a usage error.
      const { io, errs } = captureIo();
      const code = await runTenantDeactivate(ctx, [tenantId], io);
      assertEquals(code, 1);
      assert(errs.some((e) => e.toLowerCase().includes("already deactivated")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:deactivate returns exit 1 on non-existent tenant",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const fakeId = "tenant_01ABCDEFGHJKMNPQRSTVWXYZ23";
      const { io, errs } = captureIo();
      const code = await runTenantDeactivate(ctx, [fakeId], io);
      assertEquals(code, 1);
      assert(errs.some((e) => e.toLowerCase().includes("not found")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: tenant:deactivate rejects malformed tenant_id with exit 2",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, errs } = captureIo();
      const code = await runTenantDeactivate(ctx, ["garbage"], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("tenant:deactivate")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: webhook:get returns config metadata without secret",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const secret = "this-is-a-very-long-test-secret-at-least-32-chars";
      // Stand up a webhook config so there's something to GET.
      const setupCode = await runWebhookSetConfig(
        ctx,
        [
          tenantId,
          "--callback-url",
          "https://example.com/attesto-webhook",
          "--secret",
          secret,
        ],
        captureIo().io,
      );
      assertEquals(setupCode, 0);

      const { io, out, errs } = captureIo();
      const code = await runWebhookGet(ctx, [tenantId], io);
      assertEquals(code, 0);
      assertEquals(errs.length, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.tenantId, tenantId);
      assertEquals(parsed.callbackUrl, "https://example.com/attesto-webhook");
      assertEquals(parsed.isActive, true);
      assertEquals(parsed.hasSecret, true);
      assert(typeof parsed.updatedAt === "string");

      // CRITICAL: the plaintext secret MUST NOT appear in stdout. This is
      // the whole point of having a separate `webhook:get` rather than
      // dumping the row.
      assert(!line.includes(secret), "stdout must not contain plaintext secret");
      assert(!("secret" in parsed), "response must not include a 'secret' field");
      assert(!("secretEnc" in parsed), "response must not include the encrypted blob");
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: webhook:get returns exit 1 on tenant with no webhook config",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      const { io, errs } = captureIo();
      const code = await runWebhookGet(ctx, [tenantId], io);
      assertEquals(code, 1);
      assert(errs.some((e) => e.toLowerCase().includes("no webhook config")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: webhook:get rejects malformed tenant_id with exit 2",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const { io, errs } = captureIo();
      const code = await runWebhookGet(ctx, ["garbage"], io);
      assertEquals(code, 2);
      assert(errs.some((e) => e.includes("webhook:get")));
    } finally {
      await teardown();
    }
  },
});

Deno.test({
  name: "cli: webhook:get reports isActive: false when callback is disabled",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    const ctx = ctxFrom(handle);
    try {
      const tenantId = await createSampleTenant(ctx);
      await runWebhookSetConfig(
        ctx,
        [
          tenantId,
          "--callback-url",
          "https://example.com/attesto-webhook",
          "--secret",
          "this-is-a-very-long-test-secret-at-least-32-chars",
          "--is-active",
          "false",
        ],
        captureIo().io,
      );

      const { io, out } = captureIo();
      const code = await runWebhookGet(ctx, [tenantId], io);
      assertEquals(code, 0);
      const line = out[0];
      assert(line !== undefined);
      const parsed = JSON.parse(line);
      assertEquals(parsed.isActive, false);
      assertEquals(parsed.hasSecret, true);
    } finally {
      await teardown();
    }
  },
});

import { assert, assertEquals } from "@std/assert";
import type { AdminContext } from "@/cli/admin.ts";
import {
  type CliIO,
  runKeyCreate,
  runKeyList,
  runKeyRevoke,
  runTenantCreate,
  runTenantList,
} from "@/cli/admin.ts";
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

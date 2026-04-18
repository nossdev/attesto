import { assert, assertEquals } from "@std/assert";
import type { DbHandle } from "@/db/client.ts";
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
import { freshDb, shouldSkipIntegration } from "./_helpers.ts";

function captureIo(): { io: CliIO; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return { io: { write: (l) => out.push(l), err: (l) => errs.push(l) }, out, errs };
}

async function createSampleTenant(handle: DbHandle, name = "Acme"): Promise<string> {
  const io = captureIo();
  await runTenantCreate(handle, ["--name", name], io.io);
  const line = io.out[0];
  assert(line !== undefined);
  return JSON.parse(line).id;
}

Deno.test({
  name: "cli: tenant:create prints JSON with id and name",
  ignore: shouldSkipIntegration,
  async fn() {
    const { handle, teardown } = await freshDb();
    try {
      const { io, out, errs } = captureIo();
      const code = await runTenantCreate(handle, ["--name", "Acme Inc"], io);
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
    try {
      const { io, errs } = captureIo();
      const code = await runTenantCreate(handle, [], io);
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
    try {
      await runTenantCreate(handle, ["--name", "First"], captureIo().io);
      await new Promise((r) => setTimeout(r, 10));
      await runTenantCreate(handle, ["--name", "Second"], captureIo().io);

      const { io, out } = captureIo();
      const code = await runTenantList(handle, [], io);
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
    try {
      const tenantId = await createSampleTenant(handle);

      const { io, out, errs } = captureIo();
      const code = await runKeyCreate(handle, [tenantId, "--env", "test"], io);
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
    try {
      const tenantId = await createSampleTenant(handle);
      const { io, errs } = captureIo();
      const code = await runKeyCreate(handle, [tenantId, "--env", "staging"], io);
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
    try {
      const { io, errs } = captureIo();
      const code = await runKeyCreate(handle, ["not-a-tenant-id"], io);
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
    try {
      const { io, errs } = captureIo();
      const code = await runKeyRevoke(handle, ["garbage"], io);
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
    try {
      const tenantId = await createSampleTenant(handle);

      const io2 = captureIo();
      await runKeyCreate(handle, [tenantId], io2.io);
      const keyLine = io2.out[0];
      assert(keyLine !== undefined);
      const keyId = JSON.parse(keyLine).id;

      const first = captureIo();
      const code1 = await runKeyRevoke(handle, [keyId], first.io);
      assertEquals(code1, 0);
      const firstOut = first.out[0];
      assert(firstOut !== undefined);
      assert(JSON.parse(firstOut).revokedAt !== null);

      const second = captureIo();
      const code2 = await runKeyRevoke(handle, [keyId], second.io);
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
    try {
      const tenantId = await createSampleTenant(handle);

      const io2 = captureIo();
      await runKeyCreate(handle, [tenantId, "--name", "prod"], io2.io);
      const keyLine = io2.out[0];
      assert(keyLine !== undefined);
      const keyId = JSON.parse(keyLine).id;
      await runKeyRevoke(handle, [keyId], captureIo().io);

      const { io, out } = captureIo();
      const code = await runKeyList(handle, [tenantId], io);
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
    try {
      const tenantId = await createSampleTenant(handle);
      for (let i = 0; i < 3; i++) {
        await runKeyCreate(handle, [tenantId, "--name", `k${i}`], captureIo().io);
      }

      const limited = captureIo();
      await runKeyList(handle, [tenantId, "--limit", "2"], limited.io);
      assertEquals(limited.out.length, 2);

      const offsetted = captureIo();
      await runKeyList(handle, [tenantId, "--limit", "2", "--offset", "2"], offsetted.io);
      assertEquals(offsetted.out.length, 1);
    } finally {
      await teardown();
    }
  },
});

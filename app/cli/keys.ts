/**
 * API-key subcommands: create, list, revoke.
 *
 * See `shared.ts` for the handler contract these all follow.
 */
import {
  type AdminContext,
  type CliIO,
  defaultIo,
  parseArgs,
  reportZodIssues,
  TenantId,
} from "@/cli/shared.ts";
import { insertApiKey, listKeysForTenant, revokeApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { z } from "zod";

const KeyId = z.string().regex(/^key_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid key_id");
const KeyName = z.string().trim().min(1).max(200).optional();
const KeyEnv = z.enum(["live", "test"]).default("live");

const KeyCreateArgs = z.object({
  tenantId: TenantId,
  name: KeyName,
  env: KeyEnv,
});

export async function runKeyCreate(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = KeyCreateArgs.safeParse({ tenantId: positional[0], ...flags });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto key:create <tenant_id> [--name <label>] [--env live|test]",
      parsed.error,
    );
  }

  const generated = await generateApiKey(parsed.data.env);
  const stored = await insertApiKey(ctx.db.db, {
    tenantId: parsed.data.tenantId,
    keyHash: generated.hash,
    keyPrefix: generated.keyPrefix,
    name: parsed.data.name,
  });

  // The raw key is printed exactly once. Users MUST save it; it can't be recovered.
  io.write(
    JSON.stringify({
      id: stored.id,
      tenantId: stored.tenantId,
      keyPrefix: stored.keyPrefix,
      name: stored.name,
      rawKey: generated.raw,
      warning: "Save the rawKey — it cannot be recovered after this line.",
    }),
  );
  return 0;
}

const KeyRevokeArgs = z.object({ keyId: KeyId });

export async function runKeyRevoke(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = KeyRevokeArgs.safeParse({ keyId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto key:revoke <key_id>", parsed.error);
  }
  const revoked = await revokeApiKey(ctx.db.db, parsed.data.keyId);
  if (!revoked) {
    io.err(`Key not found or already revoked: ${parsed.data.keyId}`);
    return 1;
  }
  io.write(JSON.stringify({ id: revoked.id, revokedAt: revoked.revokedAt }));
  return 0;
}

const KeyListArgs = z.object({
  tenantId: TenantId,
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export async function runKeyList(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = KeyListArgs.safeParse({ tenantId: positional[0], ...flags });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto key:list <tenant_id> [--limit 100] [--offset 0]",
      parsed.error,
    );
  }
  const keys = await listKeysForTenant(ctx.db.db, parsed.data.tenantId, {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  for (const k of keys) {
    io.write(
      JSON.stringify({
        id: k.id,
        keyPrefix: k.keyPrefix,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      }),
    );
  }
  return 0;
}

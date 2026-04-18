/**
 * Admin CLI handlers — callable both from main.ts's subcommand dispatcher
 * and from tests. Handlers take a DbHandle + args array and emit human-
 * readable output via `write`. Returns the process exit code.
 *
 * Every subcommand validates its args through a Zod schema before touching
 * the DB, so malformed IDs / flags produce a clean usage error instead of a
 * Postgres driver exception (which could leak connection details).
 */
import { z } from "zod";
import type { DbHandle } from "@/db/client.ts";
import { createTenant, listTenants } from "@/db/queries/tenants.ts";
import { insertApiKey, listKeysForTenant, revokeApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";

export interface CliIO {
  write: (line: string) => void;
  err: (line: string) => void;
}

export const defaultIo: CliIO = {
  write: (line) => console.log(line),
  err: (line) => console.error(line),
};

// ─── Shared validators ────────────────────────────────────────────────────────

// tenant_<26-char Crockford ULID>. The ULID alphabet excludes I/L/O/U.
const TenantId = z.string().regex(/^tenant_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid tenant_id");
const KeyId = z.string().regex(/^key_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid key_id");
const TenantName = z.string().trim().min(1).max(200);
const KeyName = z.string().trim().min(1).max(200).optional();
const KeyEnv = z.enum(["live", "test"]).default("live");

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = "true"; // valueless flag; schema decides meaning
    }
  }
  return { positional, flags };
}

function reportZodIssues(io: CliIO, usage: string, err: z.ZodError): number {
  io.err(`${usage}`);
  for (const issue of err.issues) {
    io.err(`  - ${issue.path.join(".") || "(arg)"}: ${issue.message}`);
  }
  return 2;
}

// ─── Subcommand runners ───────────────────────────────────────────────────────

const TenantCreateArgs = z.object({ name: TenantName });

export async function runTenantCreate(
  handle: DbHandle,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { flags } = parseArgs(args);
  const parsed = TenantCreateArgs.safeParse(flags);
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto tenant:create --name <name>", parsed.error);
  }
  const tenant = await createTenant(handle.db, { name: parsed.data.name });
  io.write(JSON.stringify({ id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }));
  return 0;
}

export async function runTenantList(
  handle: DbHandle,
  _args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const tenants = await listTenants(handle.db);
  for (const t of tenants) {
    io.write(
      JSON.stringify({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        createdAt: t.createdAt,
      }),
    );
  }
  return 0;
}

const KeyCreateArgs = z.object({
  tenantId: TenantId,
  name: KeyName,
  env: KeyEnv,
});

export async function runKeyCreate(
  handle: DbHandle,
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
  const stored = await insertApiKey(handle.db, {
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
  handle: DbHandle,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = KeyRevokeArgs.safeParse({ keyId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto key:revoke <key_id>", parsed.error);
  }
  const revoked = await revokeApiKey(handle.db, parsed.data.keyId);
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
  handle: DbHandle,
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
  const keys = await listKeysForTenant(handle.db, parsed.data.tenantId, {
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

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const RUNNERS = {
  "tenant:create": runTenantCreate,
  "tenant:list": runTenantList,
  "key:create": runKeyCreate,
  "key:revoke": runKeyRevoke,
  "key:list": runKeyList,
} as const satisfies Record<string, (h: DbHandle, a: string[], io: CliIO) => Promise<number>>;

export type AdminSubcommand = keyof typeof RUNNERS;

export const ADMIN_SUBCOMMANDS = Object.keys(RUNNERS) as AdminSubcommand[];

export function isAdminSubcommand(s: string): s is AdminSubcommand {
  return s in RUNNERS;
}

export async function runAdminSubcommand(
  handle: DbHandle,
  subcommand: AdminSubcommand,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  return await RUNNERS[subcommand](handle, args, io);
}

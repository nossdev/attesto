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
import type { EncryptionService } from "@/services/crypto/encryption.ts";
import { createTenant, listTenants } from "@/db/queries/tenants.ts";
import { insertApiKey, listKeysForTenant, revokeApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { upsertAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { APPLE_PRIVATE_KEY_ENC_CONTEXT } from "@/services/apple/credentials-loader.ts";
import { upsertGoogleCredentials } from "@/db/queries/google-credentials.ts";
import { GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT } from "@/services/google/credentials-loader.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";

export interface AdminContext {
  db: DbHandle;
  encryption: EncryptionService;
}

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
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { flags } = parseArgs(args);
  const parsed = TenantCreateArgs.safeParse(flags);
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto tenant:create --name <name>", parsed.error);
  }
  const tenant = await createTenant(ctx.db.db, { name: parsed.data.name });
  io.write(JSON.stringify({ id: tenant.id, name: tenant.name, createdAt: tenant.createdAt }));
  return 0;
}

export async function runTenantList(
  ctx: AdminContext,
  _args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const tenants = await listTenants(ctx.db.db);
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

const AppleSetCredentialsArgs = z.object({
  tenantId: TenantId,
  bundleId: z.string().trim().min(1).max(200),
  keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, "expected 10-char uppercase alphanumeric"),
  issuerId: z.string().trim().uuid("expected App Store Connect issuer UUID"),
  keyPath: z.string().trim().min(1),
  environment: z.enum(["production", "sandbox", "auto"]).default("auto"),
});

export async function runAppleSetCredentials(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = AppleSetCredentialsArgs.safeParse({
    tenantId: positional[0],
    ...flags,
    // Support both --key-path and --key-id/--issuer-id/--bundle-id hyphenation.
    bundleId: flags.bundleId ?? flags["bundle-id"],
    keyId: flags.keyId ?? flags["key-id"],
    issuerId: flags.issuerId ?? flags["issuer-id"],
    keyPath: flags.keyPath ?? flags["key-path"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto apple:set-credentials <tenant_id> --bundle-id <com.example> " +
        "--key-id <ABCDEFGHIJ> --issuer-id <uuid> --key-path </path/to/AuthKey.p8> " +
        "[--environment auto|production|sandbox]",
      parsed.error,
    );
  }

  let pem: string;
  try {
    pem = await Deno.readTextFile(parsed.data.keyPath);
  } catch (err) {
    io.err(
      `Failed to read .p8 key from ${parsed.data.keyPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }
  if (!/-----BEGIN [^-]+-----/.test(pem)) {
    io.err(`File at ${parsed.data.keyPath} does not look like a PEM (missing BEGIN marker)`);
    return 1;
  }

  const privateKeyEnc = await ctx.encryption.encryptString(pem, APPLE_PRIVATE_KEY_ENC_CONTEXT);
  const row = await upsertAppleCredentials(ctx.db.db, {
    tenantId: parsed.data.tenantId,
    bundleId: parsed.data.bundleId,
    keyId: parsed.data.keyId,
    issuerId: parsed.data.issuerId,
    privateKeyEnc,
    environment: parsed.data.environment,
  });

  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      bundleId: row.bundleId,
      keyId: row.keyId,
      environment: row.environment,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const GoogleSetCredentialsArgs = z.object({
  tenantId: TenantId,
  packageName: z.string().trim().min(1).max(200),
  serviceAccountPath: z.string().trim().min(1),
});

export async function runGoogleSetCredentials(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = GoogleSetCredentialsArgs.safeParse({
    tenantId: positional[0],
    packageName: flags.packageName ?? flags["package-name"],
    serviceAccountPath: flags.serviceAccountPath ?? flags["service-account-path"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto google:set-credentials <tenant_id> --package-name <com.example> " +
        "--service-account-path </path/to/service-account.json>",
      parsed.error,
    );
  }

  let rawJson: string;
  try {
    rawJson = await Deno.readTextFile(parsed.data.serviceAccountPath);
  } catch (err) {
    io.err(
      `Failed to read service account JSON from ${parsed.data.serviceAccountPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  let sa: GoogleServiceAccount;
  try {
    sa = JSON.parse(rawJson) as GoogleServiceAccount;
  } catch {
    io.err(`File at ${parsed.data.serviceAccountPath} is not valid JSON`);
    return 1;
  }
  if (sa.type !== "service_account" || !sa.client_email || !sa.private_key || !sa.token_uri) {
    io.err(
      `File at ${parsed.data.serviceAccountPath} is not a Google service-account JSON ` +
        `(expected type=service_account with client_email, private_key, token_uri)`,
    );
    return 1;
  }

  const serviceAccountEnc = await ctx.encryption.encryptString(
    rawJson,
    GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT,
  );
  const row = await upsertGoogleCredentials(ctx.db.db, {
    tenantId: parsed.data.tenantId,
    packageName: parsed.data.packageName,
    serviceAccountEnc,
  });

  // Never print the raw JSON or the service-account email (user-controlled,
  // but reduces accidental paste into chat logs). Surface just tenant-scoped
  // identifiers.
  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      packageName: row.packageName,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

const RUNNERS = {
  "tenant:create": runTenantCreate,
  "tenant:list": runTenantList,
  "key:create": runKeyCreate,
  "key:revoke": runKeyRevoke,
  "key:list": runKeyList,
  "apple:set-credentials": runAppleSetCredentials,
  "google:set-credentials": runGoogleSetCredentials,
} as const satisfies Record<string, (c: AdminContext, a: string[], io: CliIO) => Promise<number>>;

export type AdminSubcommand = keyof typeof RUNNERS;

export const ADMIN_SUBCOMMANDS = Object.keys(RUNNERS) as AdminSubcommand[];

export function isAdminSubcommand(s: string): s is AdminSubcommand {
  return s in RUNNERS;
}

export async function runAdminSubcommand(
  ctx: AdminContext,
  subcommand: AdminSubcommand,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  return await RUNNERS[subcommand](ctx, args, io);
}

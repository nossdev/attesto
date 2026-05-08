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
import {
  createTenant,
  deactivateTenant,
  getTenantById,
  listTenants,
} from "@/db/queries/tenants.ts";
import { insertApiKey, listKeysForTenant, revokeApiKey } from "@/db/queries/api-keys.ts";
import { generateApiKey } from "@/services/tenants/api-keys.ts";
import { getAppleCredentials, upsertAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { APPLE_PRIVATE_KEY_ENC_CONTEXT } from "@/services/apple/credentials-loader.ts";
import { AppleApiError } from "@/services/apple/client.ts";
import { requestAppleTestNotification } from "@/services/apple/test-notification.ts";
import { upsertGoogleCredentials } from "@/db/queries/google-credentials.ts";
import { GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT } from "@/services/google/credentials-loader.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";
import {
  getWebhookConfig,
  listWebhookDeliveriesByTenant,
  listWebhookEventsByTenant,
  upsertWebhookConfig,
} from "@/db/queries/webhooks.ts";
import { listValidationAuditByTenant } from "@/db/queries/validation-audit.ts";
import { getSubscriberStats, type StatsPeriod, type SubscriberStats } from "@/db/queries/stats.ts";
import { extractSubject } from "@/services/webhooks/subject.ts";
import { WEBHOOK_SECRET_ENC_CONTEXT } from "@/services/webhooks/dispatcher.ts";
import { parsePkcs8Pem } from "@/lib/crypto-utils.ts";

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
  // Apple's numeric App ID. Optional at write time — sandbox-only / pre-launch
  // tenants don't need it. Required for production verifier construction;
  // verify path surfaces a clear remediation error if missing. Bounded by
  // MAX_SAFE_INTEGER so a future malformed input that JS can't represent
  // exactly (>2^53) fails with an explicit Zod error rather than silently
  // truncating the stored value.
  appAppleId: z.coerce.number().int().positive().lte(Number.MAX_SAFE_INTEGER).optional(),
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
    appAppleId: flags.appAppleId ?? flags["app-apple-id"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto apple:set-credentials <tenant_id> --bundle-id <com.example> " +
        "--key-id <ABCDEFGHIJ> --issuer-id <uuid> --key-path </path/to/AuthKey.p8> " +
        "[--environment auto|production|sandbox] [--app-apple-id <numeric_app_id>]",
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

  // Validate that the PEM actually parses as ECDSA P-256 BEFORE encrypt+store.
  // Without this we'd happily store any PEM-shaped file (e.g. an OpenSSH key,
  // an SEC1-converted .p8, or a corrupted download) and only fail at runtime
  // with an opaque "Failed to import .p8 as ECDSA P-256" buried in the verify
  // path. Catching it here gives the operator a clear error at the moment of
  // misconfiguration.
  try {
    const pkcs8 = parsePkcs8Pem(pem);
    await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    io.err(
      `File at ${parsed.data.keyPath} is not a valid ECDSA P-256 PKCS#8 key. ` +
        `Apple .p8 keys begin with '-----BEGIN PRIVATE KEY-----' (not 'EC PRIVATE KEY' — ` +
        `that's the SEC1 format from openssl ec). Re-download the original from App Store ` +
        `Connect without converting it. (${err instanceof Error ? err.message : String(err)})`,
    );
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
    appAppleId: parsed.data.appAppleId ?? null,
  });

  // Discoverability: warn at write time if the operator picked an environment
  // that will eventually need appAppleId but didn't provide one. Doesn't
  // block — sandbox-only and pre-launch (auto + sandbox-traffic-only) tenants
  // are legitimately fine without it.
  if (
    parsed.data.appAppleId == null &&
    (parsed.data.environment === "production" || parsed.data.environment === "auto")
  ) {
    io.err(
      `warning: --app-apple-id not set for environment=${parsed.data.environment}; ` +
        `production verifies will return CREDENTIALS_MISSING until you re-run with ` +
        `--app-apple-id <numeric_app_id> (find it in App Store Connect → My Apps → ` +
        `app → App Information → Apple ID)`,
    );
  }

  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      bundleId: row.bundleId,
      keyId: row.keyId,
      environment: row.environment,
      appAppleId: row.appAppleId,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

// ─── apple:get-credentials ────────────────────────────────────────────────────
// Inspect a tenant's Apple credential metadata for ops/debug. The encrypted
// `.p8` is intentionally NOT decrypted or surfaced — operators who need to
// rotate it must run `apple:set-credentials` again with a fresh download from
// App Store Connect. This mirrors webhook:get's hasSecret-only treatment.

const AppleGetCredentialsArgs = z.object({ tenantId: TenantId });

export async function runAppleGetCredentials(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = AppleGetCredentialsArgs.safeParse({ tenantId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto apple:get-credentials <tenant_id>", parsed.error);
  }
  const row = await getAppleCredentials(ctx.db.db, parsed.data.tenantId);
  if (!row) {
    io.err(`No Apple credentials for tenant: ${parsed.data.tenantId}`);
    return 1;
  }
  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      bundleId: row.bundleId,
      keyId: row.keyId,
      issuerId: row.issuerId,
      environment: row.environment,
      appAppleId: row.appAppleId,
      hasPrivateKey: row.privateKeyEnc != null && row.privateKeyEnc.length > 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

// ─── apple:request-test-notification ──────────────────────────────────────────
// Asks Apple to dispatch a synthetic V2 notification to the configured webhook
// URL. Useful for validating onboarding without waiting on a real sandbox
// purchase, and for re-probing a tenant's webhook plumbing after URL changes.
// Apple endpoint + behavior live in services/apple/test-notification.ts so a
// standalone script (scripts/apple-test-notification.ts) can share the logic.

const AppleRequestTestNotificationArgs = z.object({
  tenantId: TenantId,
  env: z.enum(["sandbox", "production"]).default("sandbox"),
});

export async function runAppleRequestTestNotification(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = AppleRequestTestNotificationArgs.safeParse({
    tenantId: positional[0],
    env: flags.env,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto apple:request-test-notification <tenant_id> [--env sandbox|production]",
      parsed.error,
    );
  }

  const row = await getAppleCredentials(ctx.db.db, parsed.data.tenantId);
  if (!row) {
    io.err(`No Apple credentials configured for tenant: ${parsed.data.tenantId}`);
    return 1;
  }
  const privateKeyPem = await ctx.encryption.decryptString(
    row.privateKeyEnc,
    APPLE_PRIVATE_KEY_ENC_CONTEXT,
  );

  try {
    const result = await requestAppleTestNotification({
      material: {
        bundleId: row.bundleId,
        keyId: row.keyId,
        issuerId: row.issuerId,
        privateKeyPem,
        appAppleId: row.appAppleId ?? null,
      },
      env: parsed.data.env,
    });
    io.write(
      JSON.stringify({
        env: parsed.data.env,
        testNotificationToken: result.testNotificationToken,
        hint:
          "Apple has dispatched the test notification. Watch the configured webhook URL for an inbound POST within ~15s.",
      }),
    );
    return 0;
  } catch (err) {
    if (err instanceof AppleApiError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const GoogleSetCredentialsArgs = z.object({
  tenantId: TenantId,
  packageName: z.string().trim().min(1).max(200),
  serviceAccountPath: z.string().trim().min(1),
  /**
   * Expected `aud` on Pub/Sub push OIDC JWTs. Whatever string you configured
   * as "Audience" when creating the push subscription in GCP. Leave unset to
   * skip aud enforcement (less secure).
   */
  pubsubAudience: z.string().trim().min(1).max(2048).optional(),
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
    pubsubAudience: flags.pubsubAudience ?? flags["pubsub-audience"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto google:set-credentials <tenant_id> --package-name <com.example> " +
        "--service-account-path </path/to/service-account.json> " +
        "[--pubsub-audience <expected-aud>]",
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

  // Validate that private_key is actually a parseable RSA PKCS#8 key BEFORE
  // encrypt+store. Without this we'd happily store a JSON whose private_key
  // is corrupted (most common: literal "\n" instead of real newlines after
  // someone copy-pasted via shell), and only fail at first OAuth exchange
  // with an opaque "Failed to import service-account private key". Mirror
  // of the Apple .p8 validation at line ~287.
  try {
    const pkcs8 = parsePkcs8Pem(sa.private_key);
    await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    io.err(
      `Service account at ${parsed.data.serviceAccountPath} has an unparseable private_key. ` +
        `Most common cause: literal "\\n" sequences in the JSON instead of real newlines (happens ` +
        `when the JSON was copy-pasted via a shell that escaped the newlines). Re-download the ` +
        `JSON directly from Google Cloud Console without modification. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
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
    pubsubAudience: parsed.data.pubsubAudience ?? null,
  });

  // Never print the raw JSON or the service-account email (user-controlled,
  // but reduces accidental paste into chat logs). Surface just tenant-scoped
  // identifiers.
  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      packageName: row.packageName,
      pubsubAudience: row.pubsubAudience,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

/**
 * Minimal SSRF guard: reject URLs that resolve statically to private or
 * link-local ranges. DNS-based bypass (attacker-controlled hostname pointed
 * at an internal IP) is not covered here — that requires IP-level checks at
 * request time in `delivery.ts`. For now we reject the most common mistakes:
 * literal private IPs, localhost, known cloud metadata hostnames.
 */
const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[0-1])(\.\d+){2}|169\.254(\.\d+){2}|\[::1\]|\[?fe80:.*\]?|metadata\.google\.internal|metadata)$/i;

function validateCallbackUrl(value: string): true | string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "must be https:// (or http:// for local dev)";
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    return `callback host "${parsed.hostname}" is private / metadata — refuse to configure (SSRF guard)`;
  }
  return true;
}

const WebhookSetConfigArgs = z.object({
  tenantId: TenantId,
  callbackUrl: z
    .string()
    .url()
    .max(2048)
    .refine((v) => validateCallbackUrl(v) === true, {
      message: "callback URL fails SSRF validation (private IP / metadata host / bad scheme)",
    }),
  /**
   * HMAC-SHA256 secret. Required min 32 chars so users who type a
   * memorable passphrase (low entropy) get a usage error, and so the
   * secret comfortably clears the 256-bit ideal when base64/hex encoded.
   * Recommended: `openssl rand -base64 32` (→ 44 chars).
   */
  secret: z.string().trim().min(32, "secret too short; use `openssl rand -base64 32`").max(512),
  isActive: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});

export async function runWebhookSetConfig(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = WebhookSetConfigArgs.safeParse({
    tenantId: positional[0],
    callbackUrl: flags.callbackUrl ?? flags["callback-url"],
    secret: flags.secret,
    isActive: flags.isActive ?? flags["is-active"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto webhook:set-config <tenant_id> " +
        "--callback-url <https://...> --secret <base64-or-hex-secret> " +
        "[--is-active true|false]",
      parsed.error,
    );
  }
  const secretEnc = await ctx.encryption.encryptString(
    parsed.data.secret,
    WEBHOOK_SECRET_ENC_CONTEXT,
  );
  const row = await upsertWebhookConfig(ctx.db.db, {
    tenantId: parsed.data.tenantId,
    callbackUrl: parsed.data.callbackUrl,
    secretEnc,
    isActive: parsed.data.isActive,
  });
  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      callbackUrl: row.callbackUrl,
      isActive: row.isActive,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}

const TenantDeactivateArgs = z.object({ tenantId: TenantId });

export async function runTenantDeactivate(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = TenantDeactivateArgs.safeParse({ tenantId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto tenant:deactivate <tenant_id>", parsed.error);
  }
  // Look up first so we can distinguish "not found" from "already inactive".
  const existing = await getTenantById(ctx.db.db, parsed.data.tenantId);
  if (!existing) {
    io.err(`Tenant not found: ${parsed.data.tenantId}`);
    return 1;
  }
  if (!existing.isActive) {
    io.err(`Tenant already deactivated: ${parsed.data.tenantId}`);
    return 1;
  }
  const ok = await deactivateTenant(ctx.db.db, parsed.data.tenantId);
  if (!ok) {
    // Race: someone else deactivated/deleted the row between SELECT and UPDATE.
    io.err(`Tenant not found or could not be deactivated: ${parsed.data.tenantId}`);
    return 1;
  }
  io.write(
    JSON.stringify({
      id: parsed.data.tenantId,
      isActive: false,
      deactivatedAt: new Date().toISOString(),
    }),
  );
  return 0;
}

const WebhookGetArgs = z.object({ tenantId: TenantId });

export async function runWebhookGet(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional } = parseArgs(args);
  const parsed = WebhookGetArgs.safeParse({ tenantId: positional[0] });
  if (!parsed.success) {
    return reportZodIssues(io, "Usage: attesto webhook:get <tenant_id>", parsed.error);
  }
  const config = await getWebhookConfig(ctx.db.db, parsed.data.tenantId);
  if (!config) {
    io.err(`No webhook config for tenant: ${parsed.data.tenantId}`);
    return 1;
  }
  // Deliberately omit `secretEnc` (encrypted) and never decrypt — operators
  // who lost the secret must mint a new one via webhook:set-config. The
  // boolean `hasSecret` is enough to confirm a secret IS configured without
  // exposing its content.
  io.write(
    JSON.stringify({
      tenantId: config.tenantId,
      callbackUrl: config.callbackUrl,
      isActive: config.isActive,
      hasSecret: config.secretEnc != null && config.secretEnc.length > 0,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    }),
  );
  return 0;
}

// ─── webhook:list-events ──────────────────────────────────────────────────────
// Read-only listing of recent webhook_events for a tenant. Surfaces just
// metadata + the unified `subject` extract — never the full raw / decoded
// payloads (those can be large; operators wanting them should query the DB
// directly with the eventId from this list).

// Per-call default; CLI hard ceiling matches the query-layer clamp in
// app/lib/list-utils.ts. Variation in the per-call default is meaningful —
// deliveries are noisier per event than events, so 10 is a saner first page.
const listLimit = (defaultValue: number) =>
  z.coerce.number().int().positive().max(500).default(defaultValue);

const WebhookListEventsArgs = z.object({
  tenantId: TenantId,
  limit: listLimit(20),
});

export async function runWebhookListEvents(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = WebhookListEventsArgs.safeParse({
    tenantId: positional[0],
    limit: flags.limit,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto webhook:list-events <tenant_id> [--limit 20]",
      parsed.error,
    );
  }
  const rows = await listWebhookEventsByTenant(ctx.db.db, parsed.data.tenantId, {
    limit: parsed.data.limit,
  });
  for (const r of rows) {
    const subject = extractSubject(
      r.source as "apple" | "google",
      r.decodedPayload,
    );
    io.write(
      JSON.stringify({
        id: r.id,
        source: r.source,
        eventType: r.eventType,
        reason: r.reason,
        platformEvent: r.platformEvent,
        externalId: r.externalId,
        subject,
        receivedAt: r.receivedAt,
      }),
    );
  }
  return 0;
}

// ─── webhook:list-deliveries ──────────────────────────────────────────────────
// Recent outbound delivery state for a tenant. Surfaces status / response
// code / truncated body / retry timing — the load-bearing fields for "did
// my callback receive this?" triage.

const WebhookListDeliveriesArgs = z.object({
  tenantId: TenantId,
  limit: listLimit(10),
});

export async function runWebhookListDeliveries(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = WebhookListDeliveriesArgs.safeParse({
    tenantId: positional[0],
    limit: flags.limit,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto webhook:list-deliveries <tenant_id> [--limit 10]",
      parsed.error,
    );
  }
  const rows = await listWebhookDeliveriesByTenant(ctx.db.db, parsed.data.tenantId, {
    limit: parsed.data.limit,
  });
  for (const r of rows) {
    io.write(
      JSON.stringify({
        id: r.id,
        eventId: r.eventId,
        status: r.status,
        attemptCount: r.attemptCount,
        lastResponseCode: r.lastResponseCode,
        // Truncate response body — tenants may echo PII / verbose stack traces
        // in their callback error responses; we cap at 120 chars for display.
        bodyPreview: r.lastResponseBody === null
          ? null
          : r.lastResponseBody.length > 120
          ? r.lastResponseBody.slice(0, 120) + "…"
          : r.lastResponseBody,
        nextAttemptAt: r.nextAttemptAt,
        deliveredAt: r.deliveredAt,
        failedAt: r.failedAt,
        createdAt: r.createdAt,
      }),
    );
  }
  return 0;
}

// ─── audit:list ───────────────────────────────────────────────────────────────
// Recent validation_audit rows for a tenant. The table is feature-flagged
// (ENABLE_VALIDATION_AUDIT_LOG=true) — when disabled, this command returns
// nothing. The `identifierHash` column is HMAC-keyed and never surfaced
// (recovering raw IDs requires the master encryption key, which CLI users
// shouldn't have).

const AuditListArgs = z.object({
  tenantId: TenantId,
  limit: listLimit(20),
});

export async function runAuditList(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = AuditListArgs.safeParse({
    tenantId: positional[0],
    limit: flags.limit,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto audit:list <tenant_id> [--limit 20]",
      parsed.error,
    );
  }
  const rows = await listValidationAuditByTenant(ctx.db.db, parsed.data.tenantId, {
    limit: parsed.data.limit,
  });
  for (const r of rows) {
    io.write(
      JSON.stringify({
        id: r.id,
        source: r.source,
        valid: r.valid,
        errorCode: r.errorCode,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
      }),
    );
  }
  return 0;
}

// ─── stats:subscribers ────────────────────────────────────────────────────────
// Operator-facing analytics: how many users have subscribed for a tenant.
// Two output formats — `pretty` (default, ASCII box-drawing table for at-a-
// glance reading) and `json` (single-line, for piping / future automation).
// Three counts side-by-side: net-new in period, active in period, lifetime.

const StatsPeriodEnum = z.enum(["day", "week", "month", "year"]);
const StatsFormatEnum = z.enum(["pretty", "json"]);

const StatsSubscribersArgs = z.object({
  tenantId: TenantId,
  period: StatsPeriodEnum.default("month"),
  format: StatsFormatEnum.default("pretty"),
});

/**
 * `now` is exposed as a 4th parameter so integration tests can pin the
 * trailing-N-days window deterministically. Production callers
 * (`runAdminSubcommand`) omit it and get `new Date()` per call.
 */
export async function runStatsSubscribers(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
  now: () => Date = () => new Date(),
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = StatsSubscribersArgs.safeParse({
    tenantId: positional[0],
    period: flags.period,
    format: flags.format,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto stats:subscribers <tenant_id> [--period day|week|month|year] [--format pretty|json]",
      parsed.error,
    );
  }
  const { tenantId, period, format } = parsed.data;
  const stats = await getSubscriberStats(ctx.db.db, tenantId, period, now);

  if (format === "json") {
    io.write(
      JSON.stringify({
        tenantId,
        period,
        periodStart: stats.periodStart.toISOString(),
        periodEnd: stats.periodEnd.toISOString(),
        subscribers: {
          newInPeriod: stats.newInPeriod,
          activeInPeriod: stats.activeInPeriod,
          lifetime: stats.lifetime,
        },
      }),
    );
    return 0;
  }

  // Pretty (default): each io.write call is one rendered line.
  for (const line of renderSubscriberStatsPretty(tenantId, period, stats)) {
    io.write(line);
  }
  return 0;
}

/**
 * Render a SubscriberStats result as an ASCII box-drawing table.
 *
 * Returned as an array of lines (one per `io.write`) so the runner can
 * preserve the existing "one io.write per line" convention used by all
 * other CLI subcommands. The label column is fixed to the longest known
 * label width; the count column right-aligns to the longest stringified
 * count so million-range totals still render cleanly.
 */
function renderSubscriberStatsPretty(
  tenantId: string,
  period: StatsPeriod,
  stats: SubscriberStats,
): string[] {
  const rows: Array<[label: string, count: number]> = [
    ["New in period", stats.newInPeriod],
    ["Active in period", stats.activeInPeriod],
    ["Lifetime", stats.lifetime],
  ];

  const LABEL_HEADER = "Metric";
  const COUNT_HEADER = "Count";
  const labelWidth = Math.max(
    LABEL_HEADER.length,
    ...rows.map(([label]) => label.length),
  );
  const countWidth = Math.max(
    COUNT_HEADER.length,
    ...rows.map(([, n]) => String(n).length),
  );

  // +2 inner padding (one space each side of the cell content).
  const labelBar = "─".repeat(labelWidth + 2);
  const countBar = "─".repeat(countWidth + 2);

  const headerCell = (text: string, width: number, align: "left" | "right") =>
    align === "left" ? text.padEnd(width) : text.padStart(width);

  return [
    `Tenant: ${tenantId}`,
    `Period: ${period} (${stats.periodStart.toISOString()} → ${stats.periodEnd.toISOString()})`,
    "",
    `┌${labelBar}┬${countBar}┐`,
    `│ ${headerCell(LABEL_HEADER, labelWidth, "left")} │ ${
      headerCell(COUNT_HEADER, countWidth, "right")
    } │`,
    `├${labelBar}┼${countBar}┤`,
    ...rows.map(
      ([label, n]) => `│ ${label.padEnd(labelWidth)} │ ${String(n).padStart(countWidth)} │`,
    ),
    `└${labelBar}┴${countBar}┘`,
  ];
}

const RUNNERS = {
  "tenant:create": runTenantCreate,
  "tenant:list": runTenantList,
  "tenant:deactivate": runTenantDeactivate,
  "key:create": runKeyCreate,
  "key:revoke": runKeyRevoke,
  "key:list": runKeyList,
  "apple:set-credentials": runAppleSetCredentials,
  "apple:get-credentials": runAppleGetCredentials,
  "apple:request-test-notification": runAppleRequestTestNotification,
  "google:set-credentials": runGoogleSetCredentials,
  "webhook:set-config": runWebhookSetConfig,
  "webhook:get": runWebhookGet,
  "webhook:list-events": runWebhookListEvents,
  "webhook:list-deliveries": runWebhookListDeliveries,
  "audit:list": runAuditList,
  "stats:subscribers": runStatsSubscribers,
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

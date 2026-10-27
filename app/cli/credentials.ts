/**
 * Store-credential subcommands for Apple and Google.
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
import { getAppleCredentials, upsertAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { upsertGoogleCredentials } from "@/db/queries/google-credentials.ts";
import { parsePkcs8Pem } from "@/lib/crypto-utils.ts";
import { AppleApiError } from "@/services/apple/client.ts";
import { APPLE_PRIVATE_KEY_ENC_CONTEXT } from "@/services/apple/credentials-loader.ts";
import { requestAppleTestNotification } from "@/services/apple/test-notification.ts";
import { GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT } from "@/services/google/credentials-loader.ts";
import { GoogleServiceAccount } from "@/services/google/types.ts";
import { z } from "zod";

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

// Loose check that catches the obvious paste mistakes (missing prefix, extra
// whitespace, wrong separator) while leaving the authoritative validation to
// Google's publish API — they reject malformed names with a clear error.
// Trying to fully replicate Google's per-segment rules here is fragile;
// pubsub-publisher.ts wraps a 404 with a clear "topic not found" message
// either way.
const PUBSUB_TOPIC_RE = /^projects\/\S+\/topics\/\S+$/;

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
  /**
   * Pub/Sub topic resource name (`projects/<project>/topics/<name>`) the
   * tenant's RTDN flows through. Required to use `webhook:probe` against the
   * Google side. Leave unset until you know the topic.
   */
  pubsubTopic: z
    .string()
    .trim()
    .regex(PUBSUB_TOPIC_RE, "must match projects/<project>/topics/<name>")
    .optional(),
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
    pubsubTopic: flags.pubsubTopic ?? flags["pubsub-topic"],
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto google:set-credentials <tenant_id> --package-name <com.example> " +
        "--service-account-path </path/to/service-account.json> " +
        "[--pubsub-audience <expected-aud>] " +
        "[--pubsub-topic projects/<project>/topics/<name>]",
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
    pubsubTopic: parsed.data.pubsubTopic ?? null,
  });

  // Never print the raw JSON or the service-account email (user-controlled,
  // but reduces accidental paste into chat logs). Surface just tenant-scoped
  // identifiers.
  io.write(
    JSON.stringify({
      tenantId: row.tenantId,
      packageName: row.packageName,
      pubsubAudience: row.pubsubAudience,
      pubsubTopic: row.pubsubTopic,
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

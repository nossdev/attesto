/**
 * Webhook subcommands: config, inspection, ping and end-to-end probe.
 *
 * Split out of `admin.ts`, which had grown past the repo's 800-line
 * ceiling; `admin.ts` keeps the subcommand registry and dispatch.
 */
import {
  type AdminContext,
  type CliIO,
  defaultIo,
  listLimit,
  parseArgs,
  reportZodIssues,
  TenantId,
} from "@/cli/shared.ts";
import { getAppleCredentials } from "@/db/queries/apple-credentials.ts";
import { getGoogleCredentials } from "@/db/queries/google-credentials.ts";
import {
  getWebhookConfig,
  listWebhookDeliveriesByTenant,
  listWebhookEventsByTenant,
  upsertWebhookConfig,
} from "@/db/queries/webhooks.ts";
import { makeId } from "@/lib/id.ts";
import { ATTESTO_VERSION_HEADER, VERSION } from "@/lib/version.ts";
import { AppleApiError } from "@/services/apple/client.ts";
import { APPLE_PRIVATE_KEY_ENC_CONTEXT } from "@/services/apple/credentials-loader.ts";
import { requestAppleTestNotification } from "@/services/apple/test-notification.ts";
import { GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT } from "@/services/google/credentials-loader.ts";
import { type AccessTokenProvider, createAccessTokenProvider } from "@/services/google/oauth.ts";
import { publishPubSubMessage, PubSubPublishError } from "@/services/google/pubsub-publisher.ts";
import { GoogleServiceAccount } from "@/services/google/types.ts";
import { WEBHOOK_SECRET_ENC_CONTEXT } from "@/services/webhooks/dispatcher.ts";
import {
  ATTESTO_EVENT_HEADER,
  ATTESTO_EVENT_ID_HEADER,
  ATTESTO_SIGNATURE_HEADER,
  ATTESTO_TIMESTAMP_HEADER,
  signWebhook,
} from "@/services/webhooks/signature.ts";
import { extractSubject } from "@/services/webhooks/subject.ts";
import { OutboundWebhookPayload } from "@/services/webhooks/types.ts";
import { z } from "zod";

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

// ─── webhook:ping ─────────────────────────────────────────────────────────────
// Synchronous, narrow counterpart to `webhook:probe`: builds a synthetic test
// payload, signs it with the tenant's HMAC secret, POSTs it directly to the
// configured callback URL, and reports the HTTP status + latency. Tests only
// the Attesto → backend leg (reachability + signature verification + 2xx) — no
// Apple/Google involved, and no `webhook_events` / `webhook_deliveries` rows
// written (zero DB side effects).

// Matches the dispatcher's default (delivery.ts DEFAULT_TIMEOUT_MS). A backend
// slow enough to time out a real delivery should time out the ping too.

const WEBHOOK_PING_TIMEOUT_MS = 10_000;

const WebhookPingArgs = z.object({
  tenantId: TenantId,
  format: z.enum(["pretty", "json"]).default("pretty"),
});

export async function runWebhookPing(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = WebhookPingArgs.safeParse({
    tenantId: positional[0],
    format: flags.format,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto webhook:ping <tenant_id> [--format pretty|json]",
      parsed.error,
    );
  }
  const { tenantId, format } = parsed.data;

  const config = await getWebhookConfig(ctx.db.db, tenantId);
  if (!config) {
    io.err(`No webhook config for tenant: ${tenantId}`);
    return 2;
  }
  if (!config.isActive) {
    io.err(
      `Webhook config for ${tenantId} is disabled — enable it via ` +
        `\`webhook:set-config ${tenantId} --is-active true\` before pinging.`,
    );
    return 2;
  }
  // Re-validate the stored URL. It was checked at config time, but a direct DB
  // edit could have slipped a private/metadata host in — re-checking keeps the
  // CLI from being turned into an SSRF tool when pointed at arbitrary tenants.
  const urlCheck = validateCallbackUrl(config.callbackUrl);
  if (urlCheck !== true) {
    io.err(`Stored callback URL for ${tenantId} fails validation: ${urlCheck}`);
    return 2;
  }

  const secret = await ctx.encryption.decryptString(
    config.secretEnc,
    WEBHOOK_SECRET_ENC_CONTEXT,
  );

  const payload: OutboundWebhookPayload = {
    event: "test",
    reason: null,
    // Identifiable in backend logs; distinct from "apple.test" / "google.test"
    // that webhook:probe produces. `source` must be a valid union member —
    // "apple" is an arbitrary placeholder for the synthetic path.
    platformEvent: "attesto.ping",
    eventId: makeId.event(),
    externalId: `ping-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    tenantId,
    source: "apple",
    subject: null,
    appUserId: null,
    data: { ping: true },
    raw: {},
  };
  const body = JSON.stringify(payload);
  const { timestamp, headerValue } = await signWebhook({ secret, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_PING_TIMEOUT_MS);
  const start = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(config.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ATTESTO_EVENT_HEADER]: payload.event,
        [ATTESTO_EVENT_ID_HEADER]: payload.eventId,
        [ATTESTO_TIMESTAMP_HEADER]: String(timestamp),
        [ATTESTO_SIGNATURE_HEADER]: headerValue,
        [ATTESTO_VERSION_HEADER]: VERSION,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    const reason = controller.signal.aborted
      ? `timed out after ${WEBHOOK_PING_TIMEOUT_MS}ms`
      : err instanceof Error
      ? err.message
      : String(err);
    if (format === "json") {
      // Same keys as the success branch — consumers switch on `ok` and read
      // `statusCode` (null here) / `error` (null on success) without `in` checks.
      io.write(
        JSON.stringify({
          tenantId,
          callbackUrl: config.callbackUrl,
          ok: false,
          statusCode: null,
          latencyMs,
          error: reason,
        }),
      );
    } else {
      io.write(`POST ${config.callbackUrl}`);
      io.write(`  ✗ connection failed: ${reason}`);
      io.write(`    is the URL reachable from the public internet?`);
    }
    return 1;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - start;
  const ok = response.ok;

  if (format === "json") {
    io.write(
      JSON.stringify({
        tenantId,
        callbackUrl: config.callbackUrl,
        ok,
        statusCode: response.status,
        latencyMs,
        error: null,
      }),
    );
    return ok ? 0 : 1;
  }

  io.write(`POST ${config.callbackUrl}`);
  io.write(`  → ${response.status} ${response.statusText} in ${latencyMs}ms`);
  if (ok) {
    io.write(`  ✓ backend accepted the test delivery`);
  } else {
    io.write(`  ✗ backend rejected the test delivery — check the HMAC secret matches`);
    io.write(`    what you configured via webhook:set-config`);
  }
  return ok ? 0 : 1;
}

// ─── webhook:list-events ──────────────────────────────────────────────────────
// Read-only listing of recent webhook_events for a tenant. Surfaces just
// metadata + the unified `subject` extract — never the full raw / decoded
// payloads (those can be large; operators wanting them should query the DB
// directly with the eventId from this list).

// Per-call default; CLI hard ceiling matches the query-layer clamp in
// app/lib/list-utils.ts. Variation in the per-call default is meaningful —
// deliveries are noisier per event than events, so 10 is a saner first page.
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

const ProbePlatformEnum = z.enum(["apple", "google", "auto"]);

const WebhookProbeArgs = z.object({
  tenantId: TenantId,
  platform: ProbePlatformEnum.default("auto"),
  env: z.enum(["sandbox", "production"]).default("sandbox"), // Apple-only
});

interface ProbeOutcome {
  platform: "apple" | "google";
  status: "ok" | "skipped" | "failed";
  message: string;
  hint?: string;
}

/** Test-only injection seams for `runWebhookProbe`. Both default to real impls. */
export interface WebhookProbeDeps {
  tokenProvider?: AccessTokenProvider;
  appleFetchImpl?: typeof fetch;
  googleFetchImpl?: typeof fetch;
}

export async function runWebhookProbe(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
  deps: WebhookProbeDeps = {},
): Promise<number> {
  const tokenProvider = deps.tokenProvider ?? createAccessTokenProvider();
  const { positional, flags } = parseArgs(args);
  const parsed = WebhookProbeArgs.safeParse({
    tenantId: positional[0],
    platform: flags.platform,
    env: flags.env,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto webhook:probe <tenant_id> [--platform apple|google|auto] " +
        "[--env sandbox|production]",
      parsed.error,
    );
  }

  const { tenantId, platform, env } = parsed.data;

  const [appleRow, googleRow] = await Promise.all([
    getAppleCredentials(ctx.db.db, tenantId),
    getGoogleCredentials(ctx.db.db, tenantId),
  ]);

  // Validate explicit-platform requests up front. In auto mode, missing creds
  // is informational (skipped, not error); in explicit mode the operator
  // asked specifically and silent skipping would be wrong.
  if (platform === "apple" && !appleRow) {
    io.err(`No Apple credentials configured for tenant: ${tenantId}`);
    return 2;
  }
  if (platform === "google") {
    if (!googleRow) {
      io.err(`No Google credentials configured for tenant: ${tenantId}`);
      return 2;
    }
    if (!googleRow.pubsubTopic) {
      io.err(
        `Google credentials for ${tenantId} have no pubsub_topic set. Run ` +
          `\`google:set-credentials ${tenantId} --pubsub-topic projects/<project>/topics/<name>\` first.`,
      );
      return 2;
    }
  }
  if (platform === "auto" && !appleRow && !googleRow) {
    io.err(
      `No credentials configured for tenant: ${tenantId} — set up via ` +
        `apple:set-credentials or google:set-credentials first.`,
    );
    return 2;
  }

  const targets: Array<"apple" | "google"> = platform === "auto" ? ["apple", "google"] : [platform];

  // Print the header BEFORE issuing any network calls so the operator sees
  // immediate feedback during the multi-second probe (Apple JWT-sign + HTTPS
  // round-trip + Google OAuth + publish are O(seconds) over real networks).
  io.write(`Probing ${tenantId}`);

  const outcomes: ProbeOutcome[] = [];
  for (const target of targets) {
    if (target === "apple") {
      outcomes.push(await probeApple(ctx, tenantId, env, appleRow, deps.appleFetchImpl));
    } else {
      outcomes.push(
        await probeGoogle(ctx, tenantId, googleRow, tokenProvider, deps.googleFetchImpl),
      );
    }
    const last = outcomes[outcomes.length - 1]!;
    for (const line of formatProbeOutcome(last)) io.write(line);
  }

  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

const PROBE_LABEL_WIDTH = 7; // length of "google:"

/**
 * Build the `failed: <reason>` line for a probe outcome.
 *
 * Only error types whose messages we control (PubSubPublishError,
 * AppleApiError, and our own `throw new Error(...)` sentinels above)
 * are surfaced verbatim — those are pre-scrubbed of upstream-body /
 * key-derived bytes / JSON.parse byte offsets. Anything else (an
 * unexpected throw from `decryptString` or a third-party lib) is
 * collapsed to a generic message: the operator gets enough to know
 * something failed without risking a leak in pasted output.
 */
function probeFailureMessage(err: unknown): string {
  if (err instanceof PubSubPublishError || err instanceof AppleApiError) {
    return `failed: ${err.message}`;
  }
  if (err instanceof Error && err.message.startsWith("stored ")) {
    return `failed: ${err.message}`;
  }
  return "failed: unexpected error (check Fly logs for details)";
}

function formatProbeOutcome(o: ProbeOutcome): string[] {
  const sym = o.status === "ok" ? "✓" : o.status === "skipped" ? "−" : "✗";
  const label = `${o.platform}:`.padEnd(PROBE_LABEL_WIDTH);
  const lines = [`${label} ${sym} ${o.message}`];
  if (o.hint) lines.push(`${" ".repeat(PROBE_LABEL_WIDTH + 3)}${o.hint}`);
  return lines;
}

async function probeApple(
  ctx: AdminContext,
  tenantId: string,
  env: "sandbox" | "production",
  row: Awaited<ReturnType<typeof getAppleCredentials>>,
  fetchImpl?: typeof fetch,
): Promise<ProbeOutcome> {
  if (!row) {
    return {
      platform: "apple",
      status: "skipped",
      message: "skipped: no Apple credentials configured",
      hint: `(run: cli apple:set-credentials ${tenantId} ...)`,
    };
  }
  try {
    const privateKeyPem = await ctx.encryption.decryptString(
      row.privateKeyEnc,
      APPLE_PRIVATE_KEY_ENC_CONTEXT,
    );
    const result = await requestAppleTestNotification({
      material: {
        bundleId: row.bundleId,
        keyId: row.keyId,
        issuerId: row.issuerId,
        privateKeyPem,
        appAppleId: row.appAppleId ?? null,
      },
      env,
      fetchImpl,
    });
    return {
      platform: "apple",
      status: "ok",
      message: `test notification queued (token: ${result.testNotificationToken})`,
      hint: `expect event: "test" delivered to webhook within ~15s`,
    };
  } catch (err) {
    return { platform: "apple", status: "failed", message: probeFailureMessage(err) };
  }
}

async function probeGoogle(
  ctx: AdminContext,
  tenantId: string,
  row: Awaited<ReturnType<typeof getGoogleCredentials>>,
  tokenProvider: AccessTokenProvider,
  fetchImpl?: typeof fetch,
): Promise<ProbeOutcome> {
  if (!row) {
    return {
      platform: "google",
      status: "skipped",
      message: "skipped: no Google credentials configured",
      hint: `(run: cli google:set-credentials ${tenantId} ...)`,
    };
  }
  if (!row.pubsubTopic) {
    return {
      platform: "google",
      status: "skipped",
      message: "skipped: no pubsub_topic configured",
      hint:
        `(run: cli google:set-credentials ${tenantId} --pubsub-topic projects/<project>/topics/<name>)`,
    };
  }
  try {
    const json = await ctx.encryption.decryptString(
      row.serviceAccountEnc,
      GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT,
    );
    let sa: GoogleServiceAccount;
    try {
      sa = JSON.parse(json) as GoogleServiceAccount;
    } catch {
      // Don't echo the raw JSON.parse error — it can include byte offsets
      // and a slice of the malformed (decrypted) JSON, i.e. the SA body.
      throw new Error(
        "stored Google service-account JSON is corrupt — re-run google:set-credentials for this tenant",
      );
    }
    const result = await publishPubSubMessage({
      tenantId,
      serviceAccount: sa,
      topic: row.pubsubTopic,
      tokenProvider,
      fetchImpl,
      data: {
        version: "1.0",
        packageName: row.packageName,
        eventTimeMillis: String(Date.now()),
        testNotification: { version: "1.0" },
      },
    });
    return {
      platform: "google",
      status: "ok",
      message: `test message published (messageId: ${result.messageId})`,
      hint: `expect event: "test" delivered to webhook within seconds`,
    };
  } catch (err) {
    return { platform: "google", status: "failed", message: probeFailureMessage(err) };
  }
}

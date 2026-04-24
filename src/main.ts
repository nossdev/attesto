import { loadConfig } from "@/config.ts";
import { createApp } from "@/app.ts";
import { createDb } from "@/db/client.ts";
import { runMigrations } from "@/db/migrate.ts";
import { ADMIN_SUBCOMMANDS, isAdminSubcommand, runAdminSubcommand } from "@/cli/admin.ts";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import { createAppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import {
  createAppleJwsVerifierCache,
  preloadAppleRootCerts,
} from "@/services/apple/jws-verifier.ts";
import { createGoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import { createAccessTokenProvider } from "@/services/google/oauth.ts";
import { createGoogleOidcVerifier } from "@/services/google/oidc-verifier.ts";
import { createDispatcher } from "@/services/webhooks/dispatcher.ts";
import { createAppleHttpClient } from "@/services/apple/client.ts";
import { createValidationAuditRecorder } from "@/services/audit/validation-audit.ts";

async function runServer(): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.DATABASE_URL);
  const encryption = createEncryptionService(config.ATTESTO_ENCRYPTION_KEY);
  const appleLoader = createAppleCredentialsLoader({ db: dbHandle.db, encryption });
  const googleLoader = createGoogleCredentialsLoader({ db: dbHandle.db, encryption });
  const googleTokenProvider = createAccessTokenProvider();

  // Fail-fast: load Apple root certs at boot rather than on the first webhook.
  await preloadAppleRootCerts();
  const appleVerifierCache = createAppleJwsVerifierCache({
    // OCSP disabled outside production — dev loops don't need the ~50ms
    // per-request hit to Apple's OCSP responder, and CI runs in sandboxed
    // environments where outbound connectivity is restricted.
    enableOnlineChecks: config.NODE_ENV === "production",
  });
  const googleOidcVerifier = createGoogleOidcVerifier({ db: dbHandle.db });
  const auditRecorder = createValidationAuditRecorder({
    db: dbHandle.db,
    encryption,
    enabled: config.ENABLE_VALIDATION_AUDIT_LOG,
  });
  if (config.ENABLE_VALIDATION_AUDIT_LOG) {
    // PLAN §5 flags the table as unbounded. Retention policy is tracked
    // for Phase 7+ — log-level reminder at boot so operators don't
    // discover the bloat on a pager.
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "validation_audit_enabled_no_retention",
      note:
        "ENABLE_VALIDATION_AUDIT_LOG=true — validation_audit grows unbounded; configure a retention job before long-running production use",
    }));
  }

  const app = createApp({
    db: dbHandle,
    decryptionKeyOk: () => config.ATTESTO_ENCRYPTION_KEY.length > 0,
    isProduction: config.NODE_ENV === "production",
    authenticated: {
      db: dbHandle.db,
      rateLimit: {
        refillPerSecond: config.RATE_LIMIT_PER_SECOND,
        burst: config.RATE_LIMIT_BURST,
      },
      apple: {
        credentialsLoader: appleLoader,
        clientFactory: (material) =>
          // Inline factory so the verify endpoint also runs through the
          // SDK's JWS verifier — defense in depth over TLS.
          createAppleHttpClient({
            credentials: material,
            verifierCache: appleVerifierCache,
          }),
        auditRecorder,
      },
      google: {
        credentialsLoader: googleLoader,
        tokenProvider: googleTokenProvider,
        auditRecorder,
      },
    },
    webhooks: {
      db: dbHandle.db,
      appleVerifierCache,
      googleOidcVerifier,
    },
  });

  const dispatcher = createDispatcher({
    db: dbHandle,
    encryption,
    intervalMs: config.WEBHOOK_RETRY_INITIAL_DELAY_SECONDS * 1000,
  });
  dispatcher.start();

  const controller = new AbortController();
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "shutdown", signal }),
      );
      controller.abort();
      await dispatcher.stop();
      await dbHandle.close();
    })();
    return shuttingDown;
  };

  Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));

  const server = Deno.serve(
    {
      port: config.PORT,
      signal: controller.signal,
      onListen: ({ port }) => {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: "listening",
          port,
          env: config.NODE_ENV,
        }));
      },
    },
    app.fetch,
  );

  await server.finished;
  if (shuttingDown) await shuttingDown;
}

async function runMigrateSubcommand(): Promise<void> {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is required");
    Deno.exit(1);
  }
  await runMigrations(url);
}

async function runAdmin(subcommand: string, args: string[]): Promise<number> {
  if (!isAdminSubcommand(subcommand)) {
    console.error(`Unknown admin subcommand: ${subcommand}`);
    console.error(`Available: ${ADMIN_SUBCOMMANDS.join(", ")}`);
    return 2;
  }
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL);
  const encryption = createEncryptionService(config.ATTESTO_ENCRYPTION_KEY);
  try {
    return await runAdminSubcommand({ db: handle, encryption }, subcommand, args);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = Deno.args;

  if (subcommand === undefined || subcommand === "serve") {
    await runServer();
    return;
  }
  if (subcommand === "migrate") {
    await runMigrateSubcommand();
    return;
  }
  if (isAdminSubcommand(subcommand)) {
    const code = await runAdmin(subcommand, rest);
    if (code !== 0) Deno.exit(code);
    return;
  }

  const all = ["serve", "migrate", ...ADMIN_SUBCOMMANDS].join("|");
  console.error(`Unknown subcommand: ${subcommand}\nUsage: attesto [${all}]`);
  Deno.exit(2);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "fatal",
        msg: "startup_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    Deno.exit(1);
  }
}

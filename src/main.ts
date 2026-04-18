import { loadConfig } from "@/config.ts";
import { createApp } from "@/app.ts";
import { createDb } from "@/db/client.ts";
import { runMigrations } from "@/db/migrate.ts";

async function runServer(): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.DATABASE_URL);

  const app = createApp({
    db: dbHandle,
    decryptionKeyOk: () => config.ATTESTO_ENCRYPTION_KEY.length > 0,
    isProduction: config.NODE_ENV === "production",
  });

  const controller = new AbortController();
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "shutdown", signal }),
      );
      controller.abort();
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

async function main(): Promise<void> {
  const subcommand = Deno.args[0];
  switch (subcommand) {
    case undefined:
    case "serve":
      await runServer();
      return;
    case "migrate":
      await runMigrateSubcommand();
      return;
    default:
      console.error(`Unknown subcommand: ${subcommand}\nUsage: attesto [serve|migrate]`);
      Deno.exit(2);
  }
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

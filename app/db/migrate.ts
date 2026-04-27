import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";

// Resolve the migrations folder relative to THIS file. Works in both
// `deno run` and `deno compile --include migrations` regardless of CWD.
// Mirrors the pattern in app/services/apple/jws-verifier.ts.
const MIGRATIONS_DIR_URL = new URL("../../migrations/", import.meta.url);
const JOURNAL_URL = new URL("./meta/_journal.json", MIGRATIONS_DIR_URL);

async function hasMigrations(): Promise<boolean> {
  try {
    await Deno.readTextFile(JOURNAL_URL);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function runMigrations(connectionString: string): Promise<void> {
  if (!(await hasMigrations())) {
    // Phase 1 shipped with an empty migrations/ dir; Drizzle's migrator
    // throws on missing meta/_journal.json rather than no-opping. Skip
    // cleanly so the docker-compose migrate sidecar succeeds before any
    // migration has been generated.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "migrate:skipped",
        reason: "no migrations present (run `deno task db:generate` to create one)",
      }),
    );
    return;
  }

  const sql = postgres(connectionString, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "migrate:start" }));
    await migrate(db, { migrationsFolder: fromFileUrl(MIGRATIONS_DIR_URL) });
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "migrate:done" }));
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "migrate:failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const MIGRATIONS_FOLDER = "./migrations";
const JOURNAL_PATH = `${MIGRATIONS_FOLDER}/meta/_journal.json`;

async function hasMigrations(): Promise<boolean> {
  try {
    const stat = await Deno.stat(JOURNAL_PATH);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function runMigrations(connectionString: string): Promise<void> {
  if (!(await hasMigrations())) {
    // Phase 1 ships with an empty migrations/ dir; Drizzle's migrator throws
    // on missing meta/_journal.json rather than no-opping. Skip cleanly so
    // the docker-compose migrate sidecar succeeds until Phase 2 runs
    // `deno task db:generate` and produces the journal + first SQL file.
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
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
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

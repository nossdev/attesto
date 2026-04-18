import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const MIGRATIONS_FOLDER = "./migrations";

export async function runMigrations(connectionString: string): Promise<void> {
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

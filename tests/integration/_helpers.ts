import { createDb, type DbHandle } from "@/db/client.ts";
import { runMigrations } from "@/db/migrate.ts";
import { apiKeys, tenants } from "@/db/schema.ts";

export const DATABASE_URL = Deno.env.get("DATABASE_URL");
export const shouldSkipIntegration = !DATABASE_URL;
export const skipReason =
  "DATABASE_URL not set — run `mise run db:up` then re-run tests against the local Postgres";

// Migrations are idempotent once applied; we still run them on every test
// suite start so a fresh DB (CI, cleared volume) is set up without separate
// orchestration in the workflow YAML.
let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (migrated || !DATABASE_URL) return;
  await runMigrations(DATABASE_URL);
  migrated = true;
}

/**
 * Open a DB handle and clear all tenant-scoped state. Because `api_keys` has
 * ON DELETE CASCADE from `tenants`, deleting tenants alone is sufficient, but
 * we delete both tables defensively for clarity.
 *
 * Caller must invoke `teardown()` to wipe state + close the connection. This
 * ensures every test starts and ends with an empty slate regardless of
 * failure path.
 */
export async function freshDb(): Promise<{
  handle: DbHandle;
  teardown: () => Promise<void>;
}> {
  if (!DATABASE_URL) throw new Error(skipReason);
  await ensureMigrated();
  const handle = createDb(DATABASE_URL);
  await handle.db.delete(apiKeys);
  await handle.db.delete(tenants);
  return {
    handle,
    teardown: async () => {
      await handle.db.delete(apiKeys);
      await handle.db.delete(tenants);
      await handle.close();
    },
  };
}

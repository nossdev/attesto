import { runMigrations } from "@/db/migrate.ts";

async function main() {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is required");
    Deno.exit(1);
  }
  await runMigrations(url);
}

if (import.meta.main) {
  await main();
}

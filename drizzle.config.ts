import type { Config } from "npm:drizzle-kit@^0.27";

export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: Deno.env.get("DATABASE_URL") ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;

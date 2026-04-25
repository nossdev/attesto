import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema.ts";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  sql: ReturnType<typeof postgres>;
  db: Database;
  close: () => Promise<void>;
}

export function createDb(connectionString: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(connectionString, {
    max: opts.max ?? 5,
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

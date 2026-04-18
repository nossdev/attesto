import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

export type Database = ReturnType<typeof drizzle>;

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
  const db = drizzle(sql);
  return {
    sql,
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

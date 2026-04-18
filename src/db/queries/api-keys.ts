import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { type ApiKey, apiKeys } from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";

export interface InsertApiKeyInput {
  tenantId: string;
  keyHash: string;
  keyPrefix: string;
  name?: string;
}

export async function insertApiKey(db: Database, input: InsertApiKeyInput): Promise<ApiKey> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: makeId.apiKey(),
      tenantId: input.tenantId,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      name: input.name,
    })
    .returning();
  if (!row) throw new Error("insertApiKey: insert returned no rows");
  return row;
}

export async function findActiveKeyByHash(
  db: Database,
  keyHash: string,
): Promise<ApiKey | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface ListKeysOptions {
  limit?: number;
  offset?: number;
}

export async function listKeysForTenant(
  db: Database,
  tenantId: string,
  opts: ListKeysOptions = {},
): Promise<ApiKey[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function revokeApiKey(db: Database, id: string): Promise<ApiKey | null> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning();
  return row ?? null;
}

/**
 * Update `last_used_at` on an *active* key. Scoped with `revoked_at IS NULL`
 * so a concurrent revocation doesn't produce misleading audit signal
 * ("revoked key was used"). Uses `SET last_used_at = now()` to stay at DB clock.
 */
export async function touchLastUsed(db: Database, id: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
}

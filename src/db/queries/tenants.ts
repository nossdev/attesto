import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { type Tenant, tenants } from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";

export interface CreateTenantInput {
  name: string;
  isActive?: boolean;
}

export async function createTenant(db: Database, input: CreateTenantInput): Promise<Tenant> {
  const [row] = await db
    .insert(tenants)
    .values({
      id: makeId.tenant(),
      name: input.name,
      isActive: input.isActive ?? true,
    })
    .returning();
  if (!row) throw new Error("createTenant: insert returned no rows");
  return row;
}

export async function getTenantById(db: Database, id: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listTenants(db: Database, limit = 100): Promise<Tenant[]> {
  return await db.select().from(tenants).orderBy(desc(tenants.createdAt)).limit(limit);
}

export async function deactivateTenant(db: Database, id: string): Promise<boolean> {
  const [row] = await db
    .update(tenants)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning({ id: tenants.id });
  return row !== undefined;
}

import { eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { type GoogleCredentials, googleCredentials } from "@/db/schema.ts";

export interface UpsertGoogleCredentialsInput {
  tenantId: string;
  packageName: string;
  serviceAccountEnc: Uint8Array;
}

export async function upsertGoogleCredentials(
  db: Database,
  input: UpsertGoogleCredentialsInput,
): Promise<GoogleCredentials> {
  const [row] = await db
    .insert(googleCredentials)
    .values({
      tenantId: input.tenantId,
      packageName: input.packageName,
      serviceAccountEnc: input.serviceAccountEnc,
    })
    .onConflictDoUpdate({
      target: googleCredentials.tenantId,
      set: {
        packageName: input.packageName,
        serviceAccountEnc: input.serviceAccountEnc,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsertGoogleCredentials: no row returned");
  return row;
}

export async function getGoogleCredentials(
  db: Database,
  tenantId: string,
): Promise<GoogleCredentials | null> {
  const rows = await db
    .select()
    .from(googleCredentials)
    .where(eq(googleCredentials.tenantId, tenantId))
    .limit(1);
  return rows[0] ?? null;
}

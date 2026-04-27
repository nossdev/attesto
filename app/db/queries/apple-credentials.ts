import { eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { type AppleCredentials, appleCredentials } from "@/db/schema.ts";

export type AppleEnvironment = "production" | "sandbox" | "auto";

export interface UpsertAppleCredentialsInput {
  tenantId: string;
  bundleId: string;
  keyId: string;
  issuerId: string;
  privateKeyEnc: Uint8Array;
  environment?: AppleEnvironment;
  /** Apple's numeric App ID. Required by the SDK for production-env verifier
   * construction; nullable for sandbox-only / pre-launch tenants. */
  appAppleId?: number | null;
}

export async function upsertAppleCredentials(
  db: Database,
  input: UpsertAppleCredentialsInput,
): Promise<AppleCredentials> {
  const [row] = await db
    .insert(appleCredentials)
    .values({
      tenantId: input.tenantId,
      bundleId: input.bundleId,
      keyId: input.keyId,
      issuerId: input.issuerId,
      privateKeyEnc: input.privateKeyEnc,
      environment: input.environment ?? "auto",
      appAppleId: input.appAppleId ?? null,
    })
    .onConflictDoUpdate({
      target: appleCredentials.tenantId,
      set: {
        bundleId: input.bundleId,
        keyId: input.keyId,
        issuerId: input.issuerId,
        privateKeyEnc: input.privateKeyEnc,
        environment: input.environment ?? "auto",
        appAppleId: input.appAppleId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("upsertAppleCredentials: no row returned");
  return row;
}

export async function getAppleCredentials(
  db: Database,
  tenantId: string,
): Promise<AppleCredentials | null> {
  const rows = await db
    .select()
    .from(appleCredentials)
    .where(eq(appleCredentials.tenantId, tenantId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteAppleCredentials(db: Database, tenantId: string): Promise<boolean> {
  const [row] = await db
    .delete(appleCredentials)
    .where(eq(appleCredentials.tenantId, tenantId))
    .returning({ tenantId: appleCredentials.tenantId });
  return row !== undefined;
}

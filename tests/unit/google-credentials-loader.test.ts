import { assert, assertEquals, assertRejects } from "@std/assert";
import { createEncryptionService } from "@/services/crypto/encryption.ts";
import {
  createGoogleCredentialsLoader,
  GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT,
} from "@/services/google/credentials-loader.ts";
import type { Database } from "@/db/client.ts";
import type { GoogleCredentials } from "@/db/schema.ts";

const TEST_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=";
const encryption = createEncryptionService(TEST_KEY);

// Minimal in-memory stand-in for Database. Only `getGoogleCredentials` is
// exercised by the loader, so we fake the one query the loader runs.
// We inject via monkey-patching the query module from the loader's perspective
// — in practice we just mock the db.select chain shape the getGoogleCredentials
// helper uses. Simpler: test the loader with a pre-fetched row by overriding
// getGoogleCredentials via the DB fake.

function makeFakeDb(row: GoogleCredentials | null): Database {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(row ? [row] : []),
      }),
    }),
  });
  return { select } as unknown as Database;
}

const SAMPLE_SA = {
  type: "service_account",
  project_id: "p",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\npk\n-----END PRIVATE KEY-----",
  client_email: "svc@p.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

async function encryptedRow(json: string): Promise<GoogleCredentials> {
  return {
    tenantId: "tenant_x",
    packageName: "com.example.app",
    serviceAccountEnc: await encryption.encryptString(json, GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT),
    pubsubAudience: null,
    pubsubTopic: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

Deno.test("google loader: decrypts and parses valid service_account JSON", async () => {
  const row = await encryptedRow(JSON.stringify(SAMPLE_SA));
  const loader = createGoogleCredentialsLoader({
    db: makeFakeDb(row),
    encryption,
  });
  const loaded = await loader.load("tenant_x");
  assert(loaded !== null);
  assertEquals(loaded.packageName, "com.example.app");
  assertEquals(loaded.serviceAccount.client_email, "svc@p.iam.gserviceaccount.com");
});

Deno.test("google loader: returns null when no row exists", async () => {
  const loader = createGoogleCredentialsLoader({
    db: makeFakeDb(null),
    encryption,
  });
  const loaded = await loader.load("tenant_nonexistent");
  assertEquals(loaded, null);
});

Deno.test("google loader: throws if stored JSON is corrupt (JSON.parse fails)", async () => {
  const row = await encryptedRow("{ this is not valid json");
  const loader = createGoogleCredentialsLoader({
    db: makeFakeDb(row),
    encryption,
  });
  await assertRejects(() => loader.load("tenant_x"), Error, "corrupt");
});

Deno.test("google loader: cache hit avoids re-decrypting", async () => {
  const row = await encryptedRow(JSON.stringify(SAMPLE_SA));
  let selectCount = 0;
  const db = {
    select: () => {
      selectCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      };
    },
  } as unknown as Database;
  const loader = createGoogleCredentialsLoader({ db, encryption });
  await loader.load("tenant_x");
  await loader.load("tenant_x");
  await loader.load("tenant_x");
  assertEquals(selectCount, 1);
});

Deno.test("google loader: invalidate() forces a re-fetch on next load", async () => {
  const row = await encryptedRow(JSON.stringify(SAMPLE_SA));
  let selectCount = 0;
  const db = {
    select: () => {
      selectCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      };
    },
  } as unknown as Database;
  const loader = createGoogleCredentialsLoader({ db, encryption });
  await loader.load("tenant_x");
  loader.invalidate("tenant_x");
  await loader.load("tenant_x");
  assertEquals(selectCount, 2);
});

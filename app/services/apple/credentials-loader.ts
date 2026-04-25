/**
 * Loads a tenant's Apple credentials: fetches from DB, decrypts the `.p8`,
 * caches the decrypted material in memory for a short TTL to avoid hammering
 * the DB + crypto path on every verify call.
 *
 * Uses `loadOrFetch` for in-flight dedup — N concurrent verifies for the same
 * tenant on a cold cache share one DB query + decryption, not N.
 *
 * Cache invalidation on credential update is the caller's job: call
 * `invalidate(tenantId)` after `upsertAppleCredentials`.
 */
import type { Database } from "@/db/client.ts";
import type { EncryptionService } from "@/services/crypto/encryption.ts";
import { createTtlCache, type TtlCache } from "@/lib/ttl-cache.ts";
import { getAppleCredentials } from "@/db/queries/apple-credentials.ts";
import type { AppleCredentials } from "@/db/schema.ts";
import type { AppleCredentialMaterial } from "@/services/apple/types.ts";
import type { AppleEnvironment } from "@/db/queries/apple-credentials.ts";

// Apple `.p8` is bound to an encryption context so a plaintext compromise of
// a .p8 can't decrypt any other encrypted column (Google service accounts,
// webhook secrets, etc.)
const ENCRYPTION_CONTEXT = "apple_credentials.private_key";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface LoadedAppleCredentials {
  material: AppleCredentialMaterial;
  environment: AppleEnvironment;
}

// Internal cache entry: tombstone misses so we don't repeatedly hammer the DB
// when a tenant is querying without configuring Apple creds.
type CacheEntry = { present: true; value: LoadedAppleCredentials } | { present: false };

export interface AppleCredentialsLoader {
  load(tenantId: string): Promise<LoadedAppleCredentials | null>;
  invalidate(tenantId: string): void;
  clear(): void;
}

export interface CreateAppleCredentialsLoaderOptions {
  db: Database;
  encryption: EncryptionService;
  ttlMs?: number;
}

export function createAppleCredentialsLoader(
  opts: CreateAppleCredentialsLoaderOptions,
): AppleCredentialsLoader {
  const cache: TtlCache<CacheEntry> = createTtlCache({
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
  });

  async function fetchFresh(tenantId: string): Promise<CacheEntry> {
    const row: AppleCredentials | null = await getAppleCredentials(opts.db, tenantId);
    if (!row) return { present: false };
    const pem = await opts.encryption.decryptString(row.privateKeyEnc, ENCRYPTION_CONTEXT);
    return {
      present: true,
      value: {
        material: {
          bundleId: row.bundleId,
          keyId: row.keyId,
          issuerId: row.issuerId,
          privateKeyPem: pem,
        },
        environment: row.environment as AppleEnvironment,
      },
    };
  }

  return {
    async load(tenantId) {
      const entry = await cache.loadOrFetch(tenantId, () => fetchFresh(tenantId));
      return entry.present ? entry.value : null;
    },
    invalidate(tenantId) {
      cache.delete(tenantId);
    },
    clear() {
      cache.clear();
    },
  };
}

export { ENCRYPTION_CONTEXT as APPLE_PRIVATE_KEY_ENC_CONTEXT };

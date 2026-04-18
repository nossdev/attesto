/**
 * Loads a tenant's Google credentials: decrypts the service-account JSON
 * from DB, caches the parsed object in memory with in-flight dedup. Matches
 * the Apple credentials-loader pattern.
 */
import type { Database } from "@/db/client.ts";
import type { EncryptionService } from "@/services/crypto/encryption.ts";
import { createTtlCache, type TtlCache } from "@/lib/ttl-cache.ts";
import { getGoogleCredentials } from "@/db/queries/google-credentials.ts";
import type { GoogleCredentialMaterial, GoogleServiceAccount } from "@/services/google/types.ts";

const ENCRYPTION_CONTEXT = "google_credentials.service_account";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { present: true; value: GoogleCredentialMaterial } | { present: false };

export interface GoogleCredentialsLoader {
  load(tenantId: string): Promise<GoogleCredentialMaterial | null>;
  invalidate(tenantId: string): void;
  clear(): void;
}

export interface CreateGoogleCredentialsLoaderOptions {
  db: Database;
  encryption: EncryptionService;
  ttlMs?: number;
}

export function createGoogleCredentialsLoader(
  opts: CreateGoogleCredentialsLoaderOptions,
): GoogleCredentialsLoader {
  const cache: TtlCache<CacheEntry> = createTtlCache({
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
  });

  async function fetchFresh(tenantId: string): Promise<CacheEntry> {
    const row = await getGoogleCredentials(opts.db, tenantId);
    if (!row) return { present: false };
    const json = await opts.encryption.decryptString(row.serviceAccountEnc, ENCRYPTION_CONTEXT);
    let serviceAccount: GoogleServiceAccount;
    try {
      serviceAccount = JSON.parse(json) as GoogleServiceAccount;
    } catch {
      throw new Error(
        "google: stored service_account JSON is corrupt (decryption succeeded but JSON.parse failed)",
      );
    }
    return {
      present: true,
      value: { packageName: row.packageName, serviceAccount },
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

export { ENCRYPTION_CONTEXT as GOOGLE_SERVICE_ACCOUNT_ENC_CONTEXT };

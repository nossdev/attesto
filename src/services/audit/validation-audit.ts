/**
 * Validation-request audit recorder. Off by default — PLAN §8 warns about
 * volume: at 1 req/s per tenant × 365 days you'd accumulate ~31M rows.
 *
 * When enabled (`ENABLE_VALIDATION_AUDIT_LOG=true`), every call to
 * `/v1/apple/verify` and `/v1/google/verify` writes one row.
 *
 * **Identifier privacy** — raw transactionIds / purchaseTokens are NOT
 * stored. Instead we compute `HMAC-SHA256(server-side-key, identifier)`:
 *   - `tenantId` path-separates so a tenant can't correlate another tenant's
 *     tokens even if they could read the column.
 *   - The HMAC key is derived via HKDF from `ATTESTO_ENCRYPTION_KEY` with
 *     context `"validation_audit.identifier"` — the same master key that
 *     encrypts the other sensitive columns. An operator with DB read access
 *     but no master-key access cannot recover identifiers by brute force
 *     (the key space for Apple transactionIds is small enough that plain
 *     SHA-256 would be reversible in minutes on a laptop).
 *
 * Writes are fire-and-forget by default: DB outages surface as warnings,
 * not as failed verify requests. Tests set `fireAndForget: false` to
 * assert propagation.
 */

import type { Database } from "@/db/client.ts";
import type { EncryptionService } from "@/services/crypto/encryption.ts";
import { validationAudit } from "@/db/schema.ts";
import { makeId } from "@/lib/id.ts";

const HMAC_CONTEXT = "validation_audit.identifier";

export interface ValidationAuditRecord {
  tenantId: string;
  source: "apple" | "google";
  /** Raw identifier — the recorder HMAC-hashes it before insert. */
  identifier: string;
  valid: boolean;
  errorCode?: string | null;
  latencyMs: number;
}

export interface ValidationAuditRecorder {
  record(input: ValidationAuditRecord): Promise<void>;
}

interface CreateValidationAuditRecorderOptions {
  db: Database;
  encryption: EncryptionService;
  enabled: boolean;
  /**
   * If true, errors writing to validation_audit are swallowed and logged
   * as warnings instead of propagating to the caller. Default true — audit
   * is a best-effort observability concern, not a correctness one, so we
   * don't want a full Postgres outage to break verify traffic just because
   * audit can't write. Tests set this to false to assert failures.
   */
  fireAndForget?: boolean;
}

export function createValidationAuditRecorder(
  opts: CreateValidationAuditRecorderOptions,
): ValidationAuditRecorder {
  if (!opts.enabled) {
    return { record: () => Promise.resolve() };
  }
  const fireAndForget = opts.fireAndForget ?? true;

  return {
    async record(input) {
      // Salt with tenantId so the same identifier under different tenants
      // doesn't produce the same hash — prevents cross-tenant correlation
      // even if an operator can read the table.
      const identifierHash = await opts.encryption.hmacHex(
        `${input.tenantId}:${input.source}:${input.identifier}`,
        HMAC_CONTEXT,
      );
      try {
        await opts.db.insert(validationAudit).values({
          id: makeId.audit(),
          tenantId: input.tenantId,
          source: input.source,
          identifierHash,
          valid: input.valid,
          errorCode: input.errorCode ?? null,
          latencyMs: input.latencyMs,
        });
      } catch (err) {
        if (!fireAndForget) throw err;
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "validation_audit_write_failed",
          tenantId: input.tenantId,
          source: input.source,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
  };
}

export type { CreateValidationAuditRecorderOptions };

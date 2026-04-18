import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Drizzle's native `bytea` support varies; define one that reads/writes Uint8Array.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

// ─── tenants ──────────────────────────────────────────────────────────────────

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(), // "tenant_<ULID>"
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export type Tenant = typeof tenants.$inferSelect;

// ─── api_keys ─────────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // "key_<ULID>"
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(), // SHA-256(raw_key) hex
    keyPrefix: text("key_prefix").notNull(), // first 8 chars of raw key material for identification
    name: text("name"), // optional human label: "production", "staging", etc.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    // Lookup path: Bearer token → SHA-256 → row. Partial index skips revoked.
    activeKeyHashIdx: uniqueIndex("api_keys_active_key_hash_idx")
      .on(t.keyHash)
      .where(sql`${t.revokedAt} IS NULL`),
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId),
  }),
);

export type ApiKey = typeof apiKeys.$inferSelect;

// ─── apple_credentials ────────────────────────────────────────────────────────

export const appleCredentials = pgTable("apple_credentials", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  bundleId: text("bundle_id").notNull(),
  keyId: text("key_id").notNull(), // Apple Key ID (10 char)
  issuerId: text("issuer_id").notNull(), // App Store Connect Issuer ID (UUID)
  privateKeyEnc: bytea("private_key_enc").notNull(), // AES-GCM ciphertext of .p8 PEM
  environment: text("environment").notNull().default("auto"), // 'production' | 'sandbox' | 'auto'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppleCredentials = typeof appleCredentials.$inferSelect;

// ─── google_credentials ───────────────────────────────────────────────────────

export const googleCredentials = pgTable("google_credentials", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  packageName: text("package_name").notNull(), // e.g. com.example.app
  serviceAccountEnc: bytea("service_account_enc").notNull(), // AES-GCM ct of service_account JSON
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GoogleCredentials = typeof googleCredentials.$inferSelect;

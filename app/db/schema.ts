import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  // Apple's numeric App ID (App Store Connect → My Apps → app → App Information).
  // Required by the SDK's SignedDataVerifier ctor for environment=production.
  // Nullable: sandbox-only / pre-launch tenants don't need it; the verify path
  // pre-flights and surfaces a clear error if a production verifier is needed
  // and this is missing. mode:"number" because Apple uses uint64 in their schema
  // but JS Number safely covers up to 2^53 (~9 quadrillion).
  appAppleId: bigint("app_apple_id", { mode: "number" }),
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
  /**
   * Expected `aud` claim on the OIDC JWT that Google signs when pushing
   * Pub/Sub messages to our webhook endpoint. Tenants set this to whatever
   * they configured as the "Audience" on their Pub/Sub push subscription.
   * NULL disables aud enforcement (accept any Google-signed JWT — not
   * recommended).
   */
  pubsubAudience: text("pubsub_audience"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GoogleCredentials = typeof googleCredentials.$inferSelect;

// ─── webhook_configs ──────────────────────────────────────────────────────────

export const webhookConfigs = pgTable("webhook_configs", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  callbackUrl: text("callback_url").notNull(),
  secretEnc: bytea("secret_enc").notNull(), // AES-GCM ct of HMAC secret
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WebhookConfig = typeof webhookConfigs.$inferSelect;

// ─── webhook_events (idempotent ingestion) ────────────────────────────────────

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(), // evt_<ULID>
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'apple' | 'google'
    externalId: text("external_id").notNull(), // notificationUUID | messageId
    eventType: text("event_type").notNull(), // unified: "subscription.renewed" etc. (see services/webhooks/normalize.ts)
    /**
     * Sub-classification populated when the upstream payload carries one
     * (Apple subtypes — e.g. "voluntary" / "billing_retry" for an expiry).
     * Null when the upstream is undifferentiated (Google's flat numeric
     * codes) or no subtype applies. See services/webhooks/normalize.ts
     * for the per-event-type reason vocabulary.
     */
    reason: text("reason"),
    /**
     * Original upstream identifier in Attesto's legacy normalized form —
     * `apple.<type>{.<subtype>}` / `google.subscription.<N>` /
     * `google.product.<N>` / `google.voided` / `google.test`. Preserved
     * for debugging, advanced routing, and audit logs alongside the
     * unified `event_type`.
     */
    platformEvent: text("platform_event"),
    rawPayload: jsonb("raw_payload").notNull().$type<Record<string, unknown>>(),
    decodedPayload: jsonb("decoded_payload").notNull().$type<Record<string, unknown>>(),
    /**
     * Resolved subject.key for this event, computed at receive time. Used as
     * an override when extracting the unified `subject` for the outbound
     * payload — see services/webhooks/subject.ts.
     *
     * Populated for Google subscription notifications after walking the
     * `linkedPurchaseToken` chain back to the root token (see
     * services/webhooks/google-chain.ts), so integrators see the same
     * stable identifier across all upgrade/downgrade events for a given
     * subscription. NULL for Apple events (originalTransactionId is
     * already stable across renewals — extracted from JWS at delivery
     * time as before), Google one-time products / voided / test events,
     * and any case where chain resolution failed.
     */
    subjectKey: text("subject_key"),
    /**
     * App-supplied user identifier extracted from the upstream payload at
     * receive time:
     *   - Apple: `appAccountToken` from the inner `signedTransactionInfo` JWS
     *   - Google: `obfuscatedExternalAccountId` from the SubscriptionPurchaseV2
     *     (or `oneTimeProductNotification.obfuscatedExternalAccountId` for
     *     one-time products)
     *
     * Surfaced on the outbound webhook payload as `appUserId` so integrators
     * can join directly on user identity (no `subject.key` upsert dance
     * needed). NULL when the original purchase did not carry one.
     */
    appUserId: text("app_user_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Apple retries failed notifications up to 5 times over 3 days; Google can
    // replay Pub/Sub. This unique constraint turns at-least-once → exactly-once.
    idemIdx: uniqueIndex("webhook_events_idempotency_idx").on(
      t.tenantId,
      t.source,
      t.externalId,
    ),
    tenantReceivedIdx: index("webhook_events_tenant_received_idx").on(
      t.tenantId,
      t.receivedAt,
    ),
  }),
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;

// ─── webhook_deliveries (outbound to tenant callback) ─────────────────────────

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(), // del_<ULID>
    eventId: text("event_id")
      .notNull()
      .references(() => webhookEvents.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Snapshot the callback_url at enqueue time — if the tenant edits their
    // config mid-retry, we deliver the event to the URL that was active when
    // the event was received.
    callbackUrl: text("callback_url").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    status: text("status").notNull().default("pending"), // 'pending' | 'delivered' | 'failed'
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastResponseCode: integer("last_response_code"),
    lastResponseBody: text("last_response_body"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Dispatcher polls for ready-to-send deliveries with this partial index.
    pendingIdx: index("webhook_deliveries_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

// ─── validation_audit (feature-flagged) ───────────────────────────────────────
//
// Append-only log of verify requests. OFF by default — PLAN §5 warns about
// volume. Identifiers are stored as HMAC-SHA256 hashes (keyed by an
// HKDF-derived subkey from ATTESTO_ENCRYPTION_KEY, salted with tenant+source)
// so an operator with DB read but no master key can neither see the raw
// transactionId/purchaseToken nor rebuild a rainbow table to correlate rows
// across tenants.

export const validationAudit = pgTable(
  "validation_audit",
  {
    id: text("id").primaryKey(), // aud_<ULID>
    tenantId: text("tenant_id").notNull(),
    source: text("source").notNull(), // 'apple' | 'google'
    identifierHash: text("identifier_hash").notNull(), // HMAC-SHA256 hex of `<tenantId>:<source>:<transactionId|purchaseToken>`
    valid: boolean("valid").notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index("validation_audit_tenant_created_idx").on(t.tenantId, t.createdAt),
  }),
);

export type ValidationAudit = typeof validationAudit.$inferSelect;

// ─── google_purchase_chains ───────────────────────────────────────────────────
//
// Tracks Google subscription upgrade/downgrade chains. When a user moves
// between SKUs within a subscription group (e.g. monthly → annual, basic →
// premium), Google issues a NEW `purchaseToken` and links it to the previous
// one via `linkedPurchaseToken` on the new SubscriptionPurchaseV2 record.
// The integrator's `(google, purchaseToken) → user_id` mapping table only
// has the original token; without help, every webhook for the new token
// would miss.
//
// To avoid pushing fallback logic onto every integrator, Attesto records
// the link as soon as it sees a new token with `linkedPurchaseToken`, then
// walks the chain back to the root when computing `webhook_events.subject_key`.
// Result: the unified `subject.key` on the outbound payload is always the
// integrator's first-seen original token, even after multiple upgrades.

export const googlePurchaseChains = pgTable(
  "google_purchase_chains",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Newer purchase token issued by Google for the upgrade. */
    currentToken: text("current_token").notNull(),
    /** The `linkedPurchaseToken` field from Google's SubscriptionPurchaseV2. */
    previousToken: text("previous_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.currentToken] }),
    /** Forward walks: "what tokens link forward to X?" — useful for ops
     * triage. Backward walks (the hot path during subject resolution)
     * use the primary key directly. */
    previousIdx: index("google_purchase_chains_previous_idx").on(t.tenantId, t.previousToken),
  }),
);

export type GooglePurchaseChain = typeof googlePurchaseChains.$inferSelect;

# Maintenance

Periodic operator tasks that need to happen on a calendar — not in response to
outages. The headline items: rotate keys regularly, prune unbounded tables,
upgrade Attesto itself when releases ship.

## Key rotation

### Apple `.p8` rotation

Rotate **annually** (low-pressure cadence — Apple `.p8` keys don't have a hard
expiry but rotating yearly bounds the blast radius if one leaks).

#### Procedure

1. **Generate a new key in App Store Connect** (you'll have the old and new key
   live simultaneously — Apple allows multiple active keys per team)
   - Users and Access → Integrations → App Store Connect API → In-App Purchase →
     Generate API Key
   - Download the new `.p8`, note the new Key ID
2. **Update the tenant in Attesto** (the issuer ID stays the same):
   ```bash
   mise run cli -- apple:set-credentials tenant_01HXY... \
     --bundle-id com.example.app \
     --key-id <NEW-KEY-ID> \
     --issuer-id <SAME-ISSUER-ID> \
     --key-path ~/Downloads/AuthKey_<new>.p8 \
     --environment auto
   ```
   `apple:set-credentials` is idempotent — running it again with new values
   overwrites the encrypted blob in `apple_credentials`.
3. **Smoke-test** with a real verify call to confirm the new key works
4. **Wait for any in-flight requests to drain** — Attesto's credential loader
   caches decrypted credentials with a TTL (~5 minutes). After the TTL expires,
   all new requests use the new key.
5. **Revoke the old key in App Store Connect** — at this point no Attesto
   instance will use it anymore

::: tip Zero-downtime rotation The credential loader cache is what makes this
zero-downtime. New requests transparently flip to the new key after the cache
TTL. If you want immediate cutover, restart the app — but the staggered approach
is safer (lets you spot issues with the new key before fully committing). :::

### Google service-account rotation

Rotate **every 90 days** (Google's recommended cadence for service account keys,
especially for production).

#### Procedure

1. **Generate a new key in Google Cloud Console**:
   - IAM & Admin → Service Accounts → click the existing service account → Keys
     → Add Key → Create new key → JSON
   - The same service account can have multiple active keys
2. **Update the tenant in Attesto** (the service account email stays the same;
   the package name stays the same):
   ```bash
   mise run cli -- google:set-credentials tenant_01HXY... \
     --package-name com.example.app \
     --service-account-path ~/Downloads/<new-key>.json \
     --pubsub-audience <same-as-before>
   ```
3. **Smoke-test** with a real verify call
4. **After ~5 minutes** (credential cache TTL) — confirm new requests use the
   new key by checking nothing's failing
5. **Delete the old key in Google Cloud Console** (Service Accounts → that
   account → Keys → trash the old one)

### Webhook secret rotation

This is **trickier** than the others because the secret is used by both sides of
the handshake — Attesto signs with it, your callback verifies with it.

#### Procedure (zero-downtime requires brief overlap)

1. **Generate a new secret**:
   ```bash
   NEW_SECRET="$(openssl rand -base64 32)"
   ```
2. **Configure your callback to accept BOTH the old and new secrets**. Modify
   your verifier:
   ```python
   def verify(body, header, old_secret, new_secret):
       return verify_one(body, header, new_secret) or verify_one(body, header, old_secret)
   ```
   Deploy this change and confirm both old-signed and new-signed events pass
   verification.
3. **Update Attesto**:
   ```bash
   mise run cli -- webhook:set-config tenant_01HXY... \
     --callback-url <unchanged> \
     --secret "$NEW_SECRET"
   ```
   Attesto starts signing all new deliveries with the new secret.
4. **Wait** until you're sure no in-flight deliveries are signed with the old
   secret. The retry schedule's longest delay is 6 hours, so waiting 24 hours is
   overkill-safe.
5. **Remove the old secret** from your verifier:
   ```python
   def verify(body, header, secret):
       return verify_one(body, header, secret)
   ```
   Deploy.

### `ATTESTO_ENCRYPTION_KEY` rotation

**Not supported in v0.1.0.** A future version will add a key-id-per-ciphertext
header, allowing rolling rotation without downtime. For now, the manual
procedure if absolutely needed:

1. Decrypt all credentials with the old key (write a one-off script reading
   `apple_credentials.private_key_enc` etc., decoding via the
   `EncryptionService`)
2. Generate a new master key
3. Re-encrypt every credential with the new key
4. Atomically swap `ATTESTO_ENCRYPTION_KEY` and the re-encrypted blobs

This is a **one-shot** operation — there's no support for "old and new master
key live simultaneously." Plan downtime if you ever need it.

The intended approach for v0.2 is to prepend a key-ID byte to every ciphertext
blob (`<keyId>||nonce||ciphertext||tag`), letting decryption try multiple master
keys based on the prefix. That's tracked as a hardening item.

## Retention jobs (you must schedule these)

Two tables grow **unbounded** and have no built-in retention:

### `webhook_events`

Every inbound Apple S2S V2 / Google RTDN event is persisted indefinitely. At a
high-traffic app's scale (thousands of events per day), this can balloon to GBs
of JSONB within months.

Recommended schedule: **prune events older than 90 days** (adjust based on your
audit needs):

```sql
-- Run daily via pg_cron, GitHub Actions, or your job scheduler
DELETE FROM webhook_deliveries
WHERE event_id IN (
  SELECT id FROM webhook_events WHERE received_at < now() - interval '90 days'
);

DELETE FROM webhook_events
WHERE received_at < now() - interval '90 days';
```

The `webhook_deliveries` cleanup must happen **first** because of the FK.

### `validation_audit`

Only grows when `ENABLE_VALIDATION_AUDIT_LOG=true`. At verify-heavy load
(thousands of verifies per minute), this table grows fastest.

Attesto emits a structured warning at boot when the flag is enabled:

```json
{ "level": "warn", "msg": "validation_audit_enabled_no_retention", "note": "…" }
```

so you don't forget. Recommended:

```sql
-- Daily prune
DELETE FROM validation_audit WHERE created_at < now() - interval '30 days';
```

The identifier hashes are HMAC-keyed; pruning old rows means losing the ability
to forensic-query historical verifies. Set the retention based on your
investigation needs and any compliance requirements (PCI-DSS typically requires
12 months of audit logs).

### Setting up pg_cron on Fly Postgres

Fly Postgres supports `pg_cron` (an extension you enable manually):

```sql
-- One-time setup
CREATE EXTENSION pg_cron;

-- Schedule the daily prune
SELECT cron.schedule(
  'prune-webhook-events',
  '0 3 * * *',
  $$
    DELETE FROM webhook_deliveries WHERE event_id IN (SELECT id FROM webhook_events WHERE received_at < now() - interval '90 days');
    DELETE FROM webhook_events WHERE received_at < now() - interval '90 days';
  $$
);

SELECT cron.schedule(
  'prune-validation-audit',
  '0 3 * * *',
  $$ DELETE FROM validation_audit WHERE created_at < now() - interval '30 days'; $$
);
```

For non-Fly Postgres, use whatever scheduler your platform offers (systemd
timer, Kubernetes CronJob, GitHub Actions cron, etc).

## Upgrading Attesto

### Reading the changelog

Every release bumps `CHANGELOG.md` with a header like `## [0.2.0] - 2026-MM-DD`.
Read it before upgrading — anything under `### Breaking changes` requires
action.

### Standard upgrade

For a self-hosted compose deploy:

```bash
git pull
docker compose pull
docker compose up -d
```

For Fly:

```bash
git pull
mise run deploy 0.2.0
```

(Watch the GitHub Actions run; staging deploys first, prod awaits your approval
click.)

### Migration rollback

Drizzle migrations are forward-only by design. If a deploy goes bad and the
migration was the cause:

1. **`fly releases rollback -a attesto`** — reverts the app to the previous
   version, but the migration is already applied
2. **Manually revert the migration** with a hand-written SQL rollback if the
   previous version's code can't run against the new schema
3. **Don't try to rerun `attesto migrate`** — Drizzle's migrator is idempotent
   and won't re-apply, but un-applying isn't supported

In practice, most migrations are additive (new columns, new tables) and the
previous version's code keeps working fine against the new schema. Plan additive
migrations whenever possible.

### Major version upgrades

For `v0.x → v1.x`-style upgrades, expect:

- One-shot data migrations (run as a sidecar Job before the app rolls)
- Changed config knobs (the changelog will spell out renames)
- API contract changes (gated behind versioned endpoints — e.g.
  `/v1/apple/verify` vs `/v2/apple/verify`)

Always upgrade staging first and let it bake for at least 24 hours before
promoting to prod.

## Routine checks

### Weekly

- [ ] Check Fly billing / Postgres usage — catches runaway query patterns early
- [ ] Skim `CHANGELOG.md` for new releases — patch upgrades are usually safe
- [ ] Confirm `webhook_deliveries.status='failed'` is empty or steady — a
      growing count means a tenant's callback is broken

### Monthly

- [ ] Review `api_keys.last_used_at` — revoke any keys unused for >90 days
      (`mise run cli -- key:revoke key_…`)
- [ ] Audit `tenants` list for stale tenants — deactivate any unused
- [ ] Review GitHub Actions secrets — delete unused tokens
- [ ] Review Apple App Store Connect keys list — delete any rotated-out

### Quarterly

- [ ] **Rotate Google service-account keys** (90-day cadence)
- [ ] Verify `ATTESTO_ENCRYPTION_KEY` is still backed up in your password
      manager (you'd be surprised how often the answer is "...where?")

### Annually

- [ ] **Rotate Apple `.p8` keys**
- [ ] Run a `pg_dump` and confirm you can restore it locally
- [ ] Run a full DR drill: nuke staging, restore from backup, verify

## What's next

- [Operations](./operations) — what to monitor between maintenance tasks
- [Troubleshooting](./troubleshooting) — common failure modes

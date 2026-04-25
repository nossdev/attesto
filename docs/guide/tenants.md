# Tenants

Every request to `/v1/*` is authenticated with a tenant-scoped API key. A
**tenant** represents one "customer" of an Attesto deployment — typically
one app, but you can also use tenants to separate environments
(staging vs production) or per-team isolation.

## Tenant model

```
tenant
  ├── api_keys          (one tenant → many keys)
  ├── apple_credentials (one tenant → 0 or 1)
  ├── google_credentials (one tenant → 0 or 1)
  └── webhook_configs   (one tenant → 0 or 1)
```

Each tenant has its own encrypted Apple `.p8`, Google service-account
JSON, and webhook secret. There's no cross-tenant data sharing — a
tenant's keys can't verify another tenant's transactions.

## Create a tenant

```bash
mise run cli -- tenant:create --name "My App"
```

For self-hosted Docker:

```bash
docker compose exec attesto attesto tenant:create --name "My App"
```

Output:

```json
{ "id": "tenant_01HXY...", "name": "My App", "createdAt": "2026-04-25T..." }
```

The `id` is a ULID-prefixed string (`tenant_<26-char ULID>`). Save it —
every subsequent command needs it.

The `name` is a human label only; it doesn't affect routing or auth. You
can list and rename tenants later.

## List tenants

```bash
mise run cli -- tenant:list
```

Output: one JSON object per tenant.

```
{ "id": "tenant_01HXY...", "name": "My App",  "isActive": true,  "createdAt": "..." }
{ "id": "tenant_01HXZ...", "name": "Test App","isActive": true,  "createdAt": "..." }
```

## API keys

API keys are how clients authenticate to the verify endpoints. They
follow this format:

```
attesto_<env>_<43-char-base64url>

attesto_live_8xYzKj2pNm4QrVtA9bC1dF6gH8jL0mN3pQ4rS6tU
attesto_test_3aB5cD7eF9gH1iJ3kL5mN7oP9qR1sT3uV5wX7yZ
```

The prefix tells you the **environment** (`live` or `test`), useful for:

- Spotting a wrong-env key in logs and error messages
- Allowing your client code to fail loudly if it's running with the
  wrong-env key (`if (key.startsWith("attesto_test_") && env === "production") throw …`)

The remaining 32 bytes are random; the entire key is cryptographically
unguessable.

### Mint a key

```bash
mise run cli -- key:create tenant_01HXY... --env test --name "dev machine"
```

Options:

| Flag           | Meaning                                      |
| -------------- | -------------------------------------------- |
| _(positional)_ | Tenant ID — required                         |
| `--env`        | `live` (default) or `test` — sets the prefix |
| `--name`       | Optional human label (shown in `key:list`)   |

Output:

```json
{
  "id": "key_01HXY...",
  "tenantId": "tenant_01HXY...",
  "keyPrefix": "a8Fz3Q1c",
  "name": "dev machine",
  "rawKey": "attesto_test_8xYz...",
  "warning": "Save the rawKey — it cannot be recovered after this line."
}
```

::: danger The `rawKey` is shown ONCE
Attesto stores only the **SHA-256 hash** of the key. There is no recovery
path. Lose the raw key and you have to mint a new one and revoke the old.
Save it immediately into a password manager or secret store.
:::

The `keyPrefix` is the first 8 characters of the random suffix — safe to
display in UIs / logs / dashboards as an identifier without exposing the
secret.

### List keys for a tenant

```bash
mise run cli -- key:list tenant_01HXY... [--limit 100] [--offset 0]
```

Each key prints one JSON object:

```json
{
  "id": "key_01HXY...",
  "tenantId": "tenant_01HXY...",
  "keyPrefix": "a8Fz3Q1c",
  "name": "dev machine",
  "createdAt": "2026-04-25T...",
  "lastUsedAt": "2026-04-25T...",
  "revokedAt": null
}
```

`lastUsedAt` is updated on every successful auth-middleware lookup (with
a small race-tolerant window so concurrent requests don't fight). It's
your audit trail for "is this key actually being used?"

### Revoke a key

```bash
mise run cli -- key:revoke key_01HXY...
```

Revocation is immediate. The partial unique index on `api_keys.key_hash`
is filtered to `WHERE revoked_at IS NULL`, so the next request with the
revoked key returns `401 UNAUTHENTICATED` on the very next lookup — no
cache window.

Re-running `key:revoke` on an already-revoked key returns a clear "already
revoked" message and exit code 1, so it's safe to use in idempotent
scripts.

## Multi-environment patterns

A few common ways to use tenants:

### One tenant per app, one key per environment

Simple and works for most teams:

```
tenant: "Acme Production"
  ├─ key (live, "production-backend")
  ├─ key (live, "ops-cli")
  └─ key (test, "staging-backend")
  apple_credentials: production .p8
  google_credentials: production service account
```

You'll have one set of credentials uploaded but multiple keys minted for
different consumers. Both `live` and `test` keys can call the same verify
endpoints — the prefix is informational.

### One tenant per environment

Cleaner separation, more credential management:

```
tenant: "Acme — Production"
  ├─ apple_credentials: production .p8
  └─ google_credentials: production service account

tenant: "Acme — Staging"
  ├─ apple_credentials: staging .p8 (or same file with --environment sandbox)
  └─ google_credentials: same JSON or staging account
```

Use this when staging and production have **different** Apple keys or
Google service accounts. Required if your staging Play Console app is a
separately-registered package (`com.acme.app.staging`).

### One tenant per customer (multi-tenant SaaS)

If you're running Attesto as a service for multiple downstream apps:

```
tenant: "Customer A — myapp"
  ├─ apple_credentials: their .p8
  └─ google_credentials: their service account

tenant: "Customer B — otherapp"
  ├─ apple_credentials: their .p8
  └─ google_credentials: their service account
```

Each customer's credentials are encrypted with column-scoped subkeys, so
a database leak doesn't cross-correlate plaintexts.

## Deactivate a tenant

To soft-delete a tenant (preserving historical audit data):

```bash
mise run cli -- tenant:deactivate tenant_01HXY...
```

This sets `is_active = false`, which causes:

- All API keys for the tenant to fail auth-middleware lookup with `401`
- All webhook receivers for the tenant to reject inbound events with
  `404 TENANT_NOT_FOUND`
- All outbound deliveries on existing `webhook_deliveries` rows to be
  abandoned on next dispatch tick (no longer retried)

Existing audit data, encrypted credentials, and event history are
preserved. This is **not a hard delete** — to fully remove the tenant
including its credentials you'd need to drop rows directly via SQL.

## What's next

- [Onboarding a tenant](./onboarding) — full procedure for adding a new
  tenant including pre-onboarding checklist, smoke tests, and handoff
- [Apple setup](./apple-setup) — install Apple credentials for a tenant
- [Google setup](./google-setup) — install Google credentials
- [Webhooks](./webhooks) — configure outbound webhook callback per tenant
- [Integration guide](./integration) — what you'll hand to the tenant's
  backend developer
- [Maintenance](./maintenance) — credential rotation and key hygiene

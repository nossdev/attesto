# Data retention

What Attesto stores, for how long, and how to make it store less.

This page is a **guarantee you can quote in a privacy policy**, not a
description of good intentions. The central claim — that a tenant with no
webhooks and the audit log off stores nothing per purchase — is enforced by a
test in `tests/integration/per-tenant-audit.test.ts` that fails if it ever
stops being true.

## The short version

| Tenant configuration                           | Stored per purchase                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| No webhook config, `audit_log_enabled = false` | **Nothing**                                                              |
| No webhook config, audit log on                | One `validation_audit` row per lookup                                    |
| Webhooks configured                            | One `webhook_events` row per notification, plus its `webhook_deliveries` |

Independently of the above, one row per **API key** is updated on every
authenticated request. See [What is always written](#what-is-always-written).

## The verify and status paths

`POST /v1/apple/verify`, `POST /v1/google/verify`,
`POST /v1/apple/subscription-status` and
`POST /v1/google/subscription-status` are read-only with respect to purchase
data. They load the tenant's credentials (cached in memory with a TTL), call
the store, and return the answer. **No row is written that is derived from the
transaction id or purchase token** — unless the validation audit log is on for
that tenant.

### Turning the audit log off for a tenant

The audit log is controlled **per tenant**. A tenant's own setting wins; the
deployment-wide `ENABLE_VALIDATION_AUDIT_LOG` only decides what happens for
tenants that express no preference.

```bash
# This tenant writes no audit rows, whatever the deployment default is
attesto tenant:set-audit-log tenant_01HXY... --enabled false

# This tenant writes them, even on a deployment that is otherwise silent
attesto tenant:set-audit-log tenant_01HXY... --enabled true

# Follow ENABLE_VALIDATION_AUDIT_LOG again
attesto tenant:set-audit-log tenant_01HXY... --enabled default
```

This matters on a **shared deployment**: one tenant can be promised that
nothing is kept while another is audited, without running two installations.

Note what the audit log stores even when it is on: the identifier is written
as `HMAC-SHA256(key, "<tenantId>:<source>:<identifier>")`, keyed by an
HKDF-derived subkey of `ATTESTO_ENCRYPTION_KEY`. The raw transaction id or
purchase token is never written to that table.

## What is always written

One thing, and it is not per purchase:

- **`api_keys.last_used_at`** — stamped on every successful authentication,
  for every endpoint. It records _that a key was used and when_, never what it
  was used for. There is no way to disable it; it is the signal operators rely
  on to spot a leaked or abandoned key.

Nothing else on the verify and status paths touches the database.

## The webhook path

Webhooks are the stateful half of Attesto, and a tenant that configures one is
asking Attesto to hold notifications on its behalf. For a tenant with **no
webhook config, none of this applies** — no row is ever created.

When webhooks are configured, each inbound notification writes:

| Table                    | Holds                                                          | Bounded by                     |
| ------------------------ | -------------------------------------------------------------- | ------------------------------ |
| `webhook_events`         | `raw_payload`, `decoded_payload`, `subject_key`, `app_user_id` | `WEBHOOK_EVENT_RETENTION_DAYS` |
| `webhook_deliveries`     | Attempt history for the outbound call                          | deleted with its event         |
| `google_purchase_chains` | `current_token` / `previous_token` **in plaintext**            | `GOOGLE_CHAIN_RETENTION_DAYS`  |

`google_purchase_chains` is the only table that holds purchase tokens in
plaintext at rest. It exists so an upgrade or downgrade keeps the same
`subject.key` for the integrator; see
[Webhooks](./webhooks). If you do not want tokens at rest at all, do not
configure webhooks.

### Not persisting raw payloads

```bash
WEBHOOK_PERSIST_RAW_PAYLOAD=false
```

Stores `{}` in `webhook_events.raw_payload` instead of the store's own body.
The decoded payload is still kept — delivery and subject extraction need it —
so the trade is specific: you lose the ability to re-inspect exactly what
Apple or Google sent, and **the outbound webhook's `raw` field arrives empty**.
Everything else about delivery is unchanged.

## The built-in purge

Set any of these and Attesto sweeps the matching table on a timer:

```bash
WEBHOOK_EVENT_RETENTION_DAYS=90       # also removes the event's deliveries
VALIDATION_AUDIT_RETENTION_DAYS=30
GOOGLE_CHAIN_RETENTION_DAYS=365
RETENTION_PURGE_INTERVAL_HOURS=24     # default
```

**Every window is unset by default**, meaning "keep forever" — upgrading
Attesto never silently starts deleting your data. A window must be at least
one day; `0` is rejected at boot, because it is far more likely to be a
mistake than a request to wipe the table on every sweep.

The sweep runs once at startup and then on the interval. It logs only when it
actually deleted something:

```json
{
  "level": "info",
  "msg": "retention_purge",
  "webhookEvents": 12,
  "webhookDeliveries": 12,
  "validationAudit": 480,
  "googlePurchaseChains": 0
}
```

A failed sweep logs `retention_purge_failed` and is retried on the next tick;
it never affects request handling.

If you would rather drive retention from the database, the manual SQL in
[Maintenance](./maintenance) still works — just leave these variables unset so
the two do not both run.

## Logging

No transaction id or purchase token is ever written to a log in plaintext.
Where a log line needs to refer to one, it carries a **fingerprint** instead:

```json
{
  "level": "warn",
  "msg": "google_chain_resolution_failed",
  "tenantId": "tenant_…",
  "purchaseToken": "fp:a3f81c0d94e2b517"
}
```

A fingerprint is an HMAC under a salt generated fresh at process start. That
means log lines from one process can be correlated with each other, and a
captured log can never be turned back into the identifiers — which matters
because Apple transaction ids are low-entropy enough that an unsalted hash
would be reversible.

Upstream error messages are scrubbed of URLs before logging, because a failed
`fetch` reports the full request URL and both stores put the identifier in the
URL path.

See [Operations → Logging](./operations#logging) for the full list of what is
and is not logged, including what the hosting platform records independently
of Attesto.

## What's next

- [Operations](./operations) — logging, metrics, incident response
- [Maintenance](./maintenance) — key rotation, upgrades, manual pruning SQL
- [Tenants](./tenants) — per-tenant configuration reference

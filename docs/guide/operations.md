# Operations

Day-2 concerns: what to monitor, how to log, when to alert, what to do
when something goes wrong. This page is the operational counterpart to
[Maintenance](./maintenance) (which covers periodic tasks like key
rotation).

## Health endpoints

Two endpoints expose service health:

| Endpoint      | Purpose   | What it checks                                      | Use for                              |
| ------------- | --------- | --------------------------------------------------- | ------------------------------------ |
| `GET /health` | Liveness  | Process is running and the HTTP server is reachable | Load balancer, container HEALTHCHECK |
| `GET /ready`  | Readiness | DB is reachable + encryption key decrypts           | Deploy gates, alert on outage        |

Both return JSON:

```json
// /health
{ "status": "ok" }

// /ready
{ "status": "ok", "checks": { "db": "ok", "encryption": "ok" } }
```

A degraded `/ready`:

```json
{ "status": "degraded", "checks": { "db": "fail: connection refused", "encryption": "ok" } }
```

::: tip Alert on `/ready`, not `/health`
`/health` will keep returning 200 even with a dead database — it only
proves the process is up. Always alert on `/ready` failures.
:::

### Health check configuration on Fly

`fly.toml` configures both:

- `/health` every 30s with 5s timeout (liveness probe)
- `/ready` every 60s with 10s timeout, 30s grace period (readiness probe)

A failing `/ready` during deploy aborts the rollout and keeps the old
machine serving. A failing `/ready` after deploy marks the machine as
unhealthy; Fly's load balancer stops routing to it.

## Logging

Structured JSON logs to stdout. Every line has at minimum `ts`, `level`,
and `msg`:

```json
{"ts":"2026-04-25T03:01:30.123Z","level":"info","msg":"listening","port":8080,"env":"production"}
{"ts":"2026-04-25T03:01:53.428Z","level":"info","msg":"http_request","reqId":"req_…","method":"POST","path":"/v1/apple/verify","status":200,"latencyMs":143,"tenantId":"tenant_…"}
{"ts":"2026-04-25T03:02:11.876Z","level":"warn","msg":"validation_audit_enabled_no_retention","note":"…"}
{"ts":"2026-04-25T03:02:31.122Z","level":"fatal","msg":"startup_failed","error":"…"}
```

### What gets logged

**Always:**

- `listening` once at startup (with port + env)
- `shutdown` once on SIGINT/SIGTERM (with signal)
- `http_request` per request with method, path, status, latency, tenantId
- `validation_audit_enabled_no_retention` once at boot (a periodic
  reminder if the audit log is enabled — see [Maintenance](./maintenance))

**On error:**

- `startup_failed` (fatal) for any boot-time configuration / init error
- Per-request errors include the AppError code in structured form, never
  the full stack trace in production (`NODE_ENV=production` redacts
  stack traces; only `errorClass` is kept)

### What is NOT logged

- Apple `.p8` contents
- Google service-account JSON
- Raw API keys
- Webhook secrets
- Full `signedPayload` bodies

If you see these in logs, that's a bug — open an issue.

### Log analysis tips

Common queries against Fly logs (or any log shipper):

```bash
# All errors in the last hour
fly logs -a attesto | jq -c 'select(.level=="error" or .level=="fatal")'

# Per-tenant verify volume
fly logs -a attesto | jq -c 'select(.path=="/v1/apple/verify") | .tenantId' | sort | uniq -c

# p99 latency by endpoint over last 100k requests
fly logs -a attesto | jq -c 'select(.msg=="http_request") | [.path, .latencyMs]' \
  | awk -F'"' '{ count[$2]++; arr[$2 NR]=$3 } …'

# Rate-limit denials
fly logs -a attesto | jq -c 'select(.error=="RATE_LIMITED")'
```

## Metrics worth watching

Attesto doesn't ship a Prometheus endpoint in v0.1.0; use Fly's built-in
metrics or scrape these from logs:

| Metric                                      | Healthy range       | Why                                                                         |
| ------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `/v1/apple/verify` p99 latency              | <500ms              | Mostly bounded by Apple's API; spikes mean Apple is slow or your DB is slow |
| `/v1/google/verify` p99 latency             | <800ms              | Google's API is slower than Apple's; OAuth refreshes add up                 |
| HTTP 5xx rate                               | <0.1%               | Anything above suggests upstream or DB issues                               |
| `RATE_LIMITED` denials                      | 0 in normal traffic | Spikes mean a tenant is misbehaving or your limits are too tight            |
| Webhook delivery success rate               | >99%                | Persistent failures indicate a tenant's callback URL is broken              |
| `webhook_deliveries.status='pending'` count | <100 typical        | Backlog; if growing, the dispatcher is wedged                               |

## Scaling

### Vertical (stronger machines)

For most loads, the default Fly `shared-cpu-1x / 512MB RAM` machine is
sufficient. Bump up if:

- Sustained CPU >70% (check `fly logs -a … | jq …` or Fly metrics)
- Heap usage >300MB (increase memory)
- Apple/Google verify p99 climbing without external cause (check upstream
  metrics first)

### Horizontal (more machines)

Attesto's verify path is fully stateless — adding machines scales it
linearly. Scale via:

```bash
fly scale count 3 -a attesto
```

::: warning Webhook dispatcher caveat
The webhook dispatcher is **single-instance** in v0.1.0. If you scale
horizontally, all replicas will pick up `pending` rows from
`webhook_deliveries` and double-deliver to your callbacks.

Until the v0.2 multi-instance dispatcher (`FOR UPDATE SKIP LOCKED`) lands:

- For verify-heavy workloads with light webhooks: scale freely; the
  webhook dupes are tolerable
- For webhook-heavy workloads: stay at `count 1` for the dispatcher
  :::

A workaround pattern: run two Fly apps from the same image — `attesto-verify`
(scaled to N replicas, `WEBHOOK_DISPATCHER_DISABLED=1` if such a flag
existed; today, just rely on most traffic being verify) and `attesto-webhooks`
(replica count 1).

### Rate-limit tuning

Defaults: `RATE_LIMIT_PER_SECOND=100`, `RATE_LIMIT_BURST=200` per tenant
per process. With N machines, the **effective** cap per tenant is
`N × RATE_LIMIT_BURST`.

If you scale to 4 machines but want each tenant capped at the equivalent
of 100 RPS overall:

```bash
fly secrets set -a attesto RATE_LIMIT_PER_SECOND=25 RATE_LIMIT_BURST=50
```

Or accept the multiplier as a soft ceiling — exceeding 100 × N is unlikely
for most tenants.

### Database pool sizing

`DATABASE_URL` accepts standard Postgres connection params. The internal
pool defaults to ~10 connections per process; for high-concurrency
deployments tune via the connection URL:

```
postgres://user:pass@host/db?max=20&idle_timeout=30
```

For Fly Postgres, monitor connection count vs the configured `max_connections`
(default 100 on the smallest cluster). If you're approaching the cap,
either raise it on the Postgres side or use PgBouncer in front.

## Backup and disaster recovery

### Database backups

Fly Postgres takes daily snapshots automatically (retained 7 days on the
free tier, 30 on paid). To recover:

```bash
fly postgres backup list -a attesto-db
fly postgres backup restore -a attesto-db <backup-id>
```

For self-hosted, use `pg_dump` on a schedule:

```bash
docker compose exec db pg_dump -U attesto attesto | gzip > backup-$(date +%F).sql.gz
```

### Encryption key recovery

There is no key recovery. Lose `ATTESTO_ENCRYPTION_KEY` and every
encrypted credential becomes unrecoverable. The mitigation is **good
backup hygiene**:

- Store the key in a password manager BEFORE first deploy
- For team setups, use a shared password manager with controlled access
- Document who has access in your runbook so you know who to call when
  it's needed at 2am

### Tenant data restore

If a tenant accidentally deletes their credentials (or needs them
restored from a backup):

```sql
-- in psql against a restored backup
INSERT INTO apple_credentials
SELECT * FROM old_backup.apple_credentials WHERE tenant_id = 'tenant_…';
```

Then ask the tenant to verify a transaction to confirm.

## Incident response patterns

### Apple / Google API outage

Symptoms: spike in `APPLE_API_ERROR` or `GOOGLE_API_ERROR` (502 status).
Action:

1. Check [Apple Developer System Status](https://developer.apple.com/system-status/)
   or [Google Cloud Status](https://status.cloud.google.com/)
2. If the upstream is degraded, your tenants are queued — Attesto will
   continue retrying. Communicate to tenants that verifications are
   delayed.
3. Don't restart the service unless `/ready` is failing. Apple/Google
   outages don't affect Attesto's own health.

### DB outage

Symptoms: `/ready` fails with `db: fail: connection refused`. Action:

1. Check Fly Postgres status: `fly status -a attesto-db`
2. If down: scale Postgres back up or restore from backup
3. The Attesto app keeps running — `/health` returns 200, `/ready`
   returns 503. New verify requests fail open with `INTERNAL_ERROR`;
   webhook deliveries are queued in-memory but lost if the app restarts

### Bad deploy

Symptoms: deploy completed, but `/ready` flapping or new errors in logs.
Action:

1. `fly releases list -a attesto` — find the previous good release
2. `fly releases rollback -a attesto v<previous>`
3. Investigate the failed release in a feature branch, not in prod

### Webhook callback URL is failing

Symptoms: a tenant's `webhook_deliveries.status='failed'` count climbs.
Action:

1. Look at `last_response_code` and `last_response_body` for that
   tenant's deliveries — typical values: `404` (URL changed), `500`
   (their backend is broken), connect-refused (their service is down)
2. Reach out to the tenant
3. Once they fix it, their incoming events from now on will deliver
   normally; failed deliveries don't auto-retry beyond the 7h12m schedule

## What's next

- [Maintenance](./maintenance) — periodic tasks (key rotation, retention)
- [Troubleshooting](./troubleshooting) — symptom-keyed problem-solving
- [Testing](./testing) — running tests in CI and locally

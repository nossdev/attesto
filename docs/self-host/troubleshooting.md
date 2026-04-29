# Troubleshooting

Symptom-keyed problem-solving. Search the page for the error message or behavior
you're seeing; the resolution is below it.

## Boot / startup

### `startup_failed: path not found: readfile '/tmp/deno-compile-attesto/app/services/apple/roots/AppleIncRootCertificate.cer'`

The compiled binary doesn't have Apple root CA `.cer` files embedded. This is a
Dockerfile bug — the `deno compile` command needs
`--include
app/services/apple/roots`. If you're seeing this on a self-built
image, your Dockerfile is missing that flag. The official
`ghcr.io/nossdev/attesto:latest` image always includes it.

### `Invalid configuration: ATTESTO_ENCRYPTION_KEY must decode to exactly 32 bytes`

You probably ran `openssl rand -hex 32` (which gives 64 hex chars) instead of
`openssl rand -base64 32` (which gives 44 base64 chars decoding to 32 bytes).
Regenerate with the right command and retry.

### `startup_failed: Error: Connection refused (DATABASE_URL)`

Postgres isn't reachable. Check:

- `DATABASE_URL` is set correctly (no trailing whitespace, port number matches
  your DB)
- The DB is up: `docker compose ps` (local) / `fly status -a attesto-db` (Fly)
- Network connectivity if cross-VPC: firewall rules, security groups, etc.

### `INFO Main child exited normally with code: 1` then immediate restart

App is crash-looping. Usually one of:

- Missing required env var (check `fly logs` or `docker logs` for the Zod
  validation error message)
- Database not reachable (see above)
- Apple cert files not embedded (see above)

Fly restarts the machine automatically up to 5 times; after that, the deploy is
marked failed and the machine stays stopped.

## Deploy

### `timeout reached waiting for health checks to pass for machine`

Fly's deploy gave up waiting for the new machine to pass `/health` and `/ready`.
Common causes:

1. **App is crash-looping** — `fly logs -a attesto` will show the actual crash
   reason in the line above the timeout. Fix that first.
2. **DB migration failed** — the `release_command` ran but exited non-zero.
   Check the logs for the migrate output.
3. **Slow startup** — increase `grace_period` in `fly.toml` (default 30s on
   `/ready`).

The previous version stays serving while the new deploy is failing — you don't
get a partial outage. After fixing the issue, retry with:

```bash
fly deploy --remote-only
# or trigger via GitHub Actions: re-run the failed workflow
```

### `failed to release lease for machine`

Cosmetic warning during deploy; not a real failure. Fly's API has a small race
in their lease-release path. Ignore it unless the deploy itself also failed.

### CI deploy job fails with `flyctl: error: ... (auth)`

`FLY_API_TOKEN_*` is missing or wrong. Verify in GitHub:

- **Repo secret** `FLY_API_TOKEN_STAGING` exists
- **Environment** `production` exists with secret `FLY_API_TOKEN_PROD` (not at
  repo level — must be inside the environment)

Generate fresh tokens via `fly tokens create deploy -a <app>`.

## API requests

### `401 UNAUTHENTICATED` despite a valid key

Walk through these in order:

1. **Tenant active?** `mise run cli -- tenant:list` — confirm `isActive: true`
2. **Key not revoked?** `mise run cli -- key:list <tenant_id>` — confirm
   `revokedAt: null`
3. **Using the raw key?** The header value should start with `attesto_live_` or
   `attesto_test_`, not the `id` field (`key_01HXY…`) or the `keyPrefix` field
4. **No trailing whitespace?** Some shells / config managers add a newline when
   copying — strip it

### `400 CREDENTIALS_MISSING` on Apple verify

Tenant doesn't have Apple credentials installed. Run:

```bash
mise run cli -- apple:set-credentials <tenant_id> \
  --bundle-id … --key-id … --issuer-id … --key-path … --environment auto
```

Same for Google: `google:set-credentials`.

### `400 INVALID_REQUEST` with `details.maxBytes`

Your request body exceeds the 16KB cap on `/v1/*/verify`. The endpoints expect
small JSON payloads — anything larger is almost certainly malformed. Verify your
request body shape.

### `429 RATE_LIMITED`

This tenant exceeded `RATE_LIMIT_BURST`. The response includes a `Retry-After`
header with seconds to wait.

If you see this in normal traffic, increase `RATE_LIMIT_PER_SECOND` /
`RATE_LIMIT_BURST` via `fly secrets set` (then redeploy):

```bash
fly secrets set -a attesto RATE_LIMIT_PER_SECOND=200 RATE_LIMIT_BURST=400
fly deploy
```

### `502 APPLE_API_ERROR` or `502 GOOGLE_API_ERROR`

Upstream Apple/Google returned an unexpected status. Check:

- Apple:
  [https://developer.apple.com/system-status/](https://developer.apple.com/system-status/)
- Google: [https://status.cloud.google.com/](https://status.cloud.google.com/)

If those pages are clean, look at the `details.status` in the response — 401/403
from Apple or Google usually means stale / revoked credentials on the tenant.
Re-run `apple:set-credentials` / `google:set-credentials` with current keys.

## Apple-specific

### `apple:set-credentials` fails with "EC PRIVATE KEY format not supported"

Apple gives you a PKCS#8 `.p8` (header `-----BEGIN PRIVATE KEY-----`). Your
file's header is `-----BEGIN EC PRIVATE KEY-----` — that's the OpenSSL-converted
SEC1 form. Re-download the original `.p8` from App Store Connect; **don't** run
any `openssl ec` conversions on it.

### `BUNDLE_ID_MISMATCH` on a transaction you know is right

The tenant's configured `bundleId` doesn't match the JWS's. Common gotchas:

- Watch extension or App Clip has its own bundle ID
  (`com.example.app.watchkitapp`) — needs a separate tenant or update
- TestFlight builds and prod builds can drift if you have separate bundle IDs
  per build configuration

Re-check via `apple:set-credentials` with the correct bundle.

### `SIGNATURE_INVALID` on Apple webhooks

The JWS signature didn't verify against pinned Apple roots. Causes:

- Tenant's Apple credentials aren't installed (`CREDENTIALS_MISSING` is what
  you'd see for verify; webhook receivers fall back to `SIGNATURE_INVALID`
  because the receiver requires creds for the bundle-ID match). → Run
  `apple:set-credentials` for this tenant.
- Apple has rotated certs and the `@apple/app-store-server-library` version we
  use is outdated. → Upgrade Attesto to the latest release.
- Genuine forged payload — extremely rare; check Apple's recent notification log
  to confirm.

## Google-specific

### `GOOGLE_API_ERROR details.status: 401`

Service account isn't granted in Play Console. Revisit
[Google setup](./google-setup) step 2 — Users and permissions, paste
service-account email, grant app permissions.

### `GOOGLE_API_ERROR details.status: 403`

Either:

1. The Google Play Android Developer API isn't enabled for your project → Cloud
   Console → APIs & Services → Library → search → Enable
2. The service account is missing `roles/androidpublisher.user` (or a superset
   like Editor) → IAM & Admin → IAM → grant the role

### `PURCHASE_NOT_FOUND` for a brand-new purchase

Google takes up to ~30s post-purchase to make the token queryable via the
Developer API. Wait 30s and retry. If it persists:

- Confirm the package name matches the tenant's configured package
- Confirm the test purchase was made in a track the service account has
  visibility on (internal / closed track recommended for testing)

### `webhook returns 401 SIGNATURE_INVALID` from Google

OIDC JWT verification failed. Causes:

1. **Audience mismatch** — `pubsub_audience` in your tenant's Google credentials
   doesn't match the `aud` claim in the JWT. Update `google:set-credentials`
   with the right `--pubsub-audience` (the exact string you set in the Pub/Sub
   push subscription).
2. **No audience configured but Google's JWT has one** — odd, but possible. Add
   `--pubsub-audience`.
3. **Token expired** — Pub/Sub retries 5 minutes later with the same JWT, which
   by then has expired. Should auto-resolve on next push.

## Webhook delivery

### My callback never receives anything

In order:

1. **Tenant has webhook config?** `webhook_configs` row exists with
   `is_active = true`. Check via:
   ```bash
   docker compose exec attesto attesto webhook:get tenant_…
   ```
   (or directly in the DB)
2. **Apple/Google sending?** Check their respective consoles — Apple's "App
   Store Server Notifications" page shows delivery attempts; Google Pub/Sub
   topic shows publish counts.
3. **Inbound URL configured?** Check the URL Apple / Google has matches
   `https://<host>/v1/webhooks/{apple|google}/<tenant_id>` exactly.
4. **Origin verification rejecting?** Check Attesto logs for `SIGNATURE_INVALID`
   — see Apple/Google sections above.
5. **Outbound failing?** Check `webhook_deliveries` for rows with
   `status='failed'` or `attempt_count > 0` — these will have
   `last_response_code` and `last_response_body` indicating why.

### Callback fires multiple times for the same event

Not a bug if it's a few duplicates — Apple/Google are at-least-once, and Attesto
retries on non-2xx responses. Your callback should be idempotent on
`X-Attesto-Event-Id`.

If it's many duplicates per event (>3), check that you're running only **one**
Attesto replica with the dispatcher enabled. The single-instance dispatcher is a
v0.1.0 limitation; multi-replica deploys can double-dispatch.

### Signature verification fails on my end

Common causes:

- **Re-serialized body** — your framework parsed the JSON, then you stringified
  it back, and the byte sequence differs. Capture the raw request body before
  parsing.
- **Wrong secret** — confirm you have the **same** secret you passed to
  `webhook:set-config`. Attesto won't echo it back; if you've lost your copy,
  rotate via the [Maintenance](./maintenance) procedure.
- **Wrong sign string** — must be `<ts>.<body>` (single dot, no whitespace, body
  bytes raw)
- **Timestamp drift** — your server's clock is off by >5 minutes from Attesto's.
  Run NTP.

## Database

### `mise run db:migrate` fails with `ECONNREFUSED`

Postgres isn't running. Either:

- `mise run db:up` first
- Or check `docker compose ps` if it's mysteriously stopped

### Migration applied but app still using old schema

You probably restarted the app before the migration finished. The
`release_command` runs migrations as a separate step in Fly; if your DB is slow,
give it more time. Restart the app cleanly:

```bash
fly deploy --remote-only
```

### `relation "tenants" does not exist`

Migrations weren't applied. Run:

```bash
mise run db:migrate     # local
docker run --rm -e DATABASE_URL=… ghcr.io/nossdev/attesto:latest attesto migrate   # self-hosted
fly deploy              # Fly (release_command does it)
```

## Local dev

### `deno: command not found`

Run `mise install` from the repo root to install Deno per `mise.toml`. If `mise`
itself is missing, follow
[mise installation](https://mise.jdx.dev/getting-started.html).

### `mise install` says "all tools are installed" but commands still don't work

Your shell hasn't picked up the mise hook. Check `mise activate` is in your
shell rc:

```bash
echo 'eval "$(mise activate bash)"' >> ~/.bashrc       # bash
echo 'eval "$(mise activate zsh)"'  >> ~/.zshrc        # zsh
```

Then restart your shell.

### Tests pass but `mise run dev` fails

Likely a runtime-only path: the test suite uses mocked Apple/Google clients, but
`mise run dev` reaches out to the real DB. Confirm:

- `DATABASE_URL` is set
- `mise run db:up` is running
- Migrations are applied: `mise run db:migrate`

### `/ready` returns `{"checks":{}}` with `status: "degraded"`

The app booted without any readiness checks wired. This happens if something
tried to start the app without the standard `CreateAppOptions` — shouldn't
happen in normal flows. If you see it, restart and report it as a bug.

## When all else fails

- **Search GitHub Issues** —
  [github.com/nossdev/attesto/issues](https://github.com/nossdev/attesto/issues)
- **Open a new issue** with: error message, deployment context (Fly / Docker /
  local), and `fly logs` output (with anything sensitive redacted)
- **Check the changelog** —
  [`CHANGELOG.md`](https://github.com/nossdev/attesto/blob/main/CHANGELOG.md)
  for recent changes that might explain new behavior

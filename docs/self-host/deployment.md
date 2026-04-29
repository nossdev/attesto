# Deployment

Attesto ships three supported deployment paths:

1. **Fly.io** (managed, recommended) — `fly.toml` + `fly.staging.toml` are
   tracked in the repo. CI handles staging auto-deploy + manually-gated prod.
2. **Self-hosted Docker compose** — bundled `docker-compose.yml` with app +
   Postgres. Best for small-scale single-instance hosting.
3. **Self-hosted on any container platform** — pull
   `ghcr.io/nossdev/attesto:<tag>` and run anywhere. Kubernetes, Nomad, ECS,
   etc. all work.

## Required environment variables

Same set across all deployment paths:

| Variable                            | Required? | Default       | Notes                                                                                                       |
| ----------------------------------- | --------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | yes       | —             | Postgres 16+ connection string                                                                              |
| `ATTESTO_ENCRYPTION_KEY`            | yes       | —             | Base64, decodes to exactly 32 bytes (`openssl rand -base64 32`)                                             |
| `PORT`                              | no        | `8080`        | HTTP listen port                                                                                            |
| `LOG_LEVEL`                         | no        | `info`        | `trace` / `debug` / `info` / `warn` / `error`                                                               |
| `NODE_ENV`                          | no        | `development` | Set to `production` for prod hardening (OCSP on, stack-trace redaction, etc.)                               |
| `RATE_LIMIT_PER_SECOND`             | no        | `100`         | Per-tenant token bucket refill rate                                                                         |
| `RATE_LIMIT_BURST`                  | no        | `200`         | Per-tenant token bucket burst capacity                                                                      |
| `WEBHOOK_MAX_RETRIES`               | no        | `5`           | Cap on retry attempts (excluding the first attempt). Bounded by the hardcoded backoff schedule (5 entries). |
| `WEBHOOK_DISPATCH_INTERVAL_SECONDS` | no        | `10`          | Dispatcher poll cadence — how often the loop scans for due deliveries. NOT a retry delay.                   |
| `WEBHOOK_DISPATCH_CONCURRENCY`      | no        | `10`          | Max concurrent in-flight outbound deliveries per tick.                                                      |
| `WEBHOOK_TIMEOUT_SECONDS`           | no        | `10`          | Per-attempt request timeout                                                                                 |
| `ENABLE_VALIDATION_AUDIT_LOG`       | no        | `false`       | Append-only verify audit log; grows unbounded — see [Maintenance](./maintenance)                            |

::: warning Back up `ATTESTO_ENCRYPTION_KEY`

Losing this key makes every encrypted tenant credential (Apple `.p8`, Google
service account, webhook secrets) **permanently undecryptable**. Store it in a
password manager BEFORE first deploy. Treat it like a TLS private key.

:::

## Fly.io (recommended)

### One-time bootstrap

```bash
fly auth login

# Create the apps (use --copy-config to honor the existing fly.toml /
# fly.staging.toml in the repo — answer "N" when fly launch asks to
# tweak settings).
fly launch --no-deploy --copy-config --name attesto-staging --region iad
fly launch --no-deploy --copy-config --name attesto         --region iad

# Attach managed Postgres to each app.
fly postgres create --name attesto-staging-db --region iad \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach --app attesto-staging attesto-staging-db

fly postgres create --name attesto-db --region iad \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 3
fly postgres attach --app attesto attesto-db

# Set the encryption key per app — DIFFERENT keys for staging and prod.
fly secrets set -a attesto-staging ATTESTO_ENCRYPTION_KEY="$(openssl rand -base64 32)"
fly secrets set -a attesto         ATTESTO_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

### CI-driven deploys

Two GitHub Actions workflows handle ongoing deploys:

- **`.github/workflows/docker.yml`** — on every `v*` tag push, builds a
  multi-arch image (`linux/amd64` and `linux/arm64`) and publishes to
  `ghcr.io/nossdev/attesto:<tag>`. Self-hosters can pull this directly.
- **`.github/workflows/deploy.yml`** — also triggered on `v*` tag push:
  1. `deploy-staging` runs first using `FLY_API_TOKEN_STAGING`
  2. `deploy-production` runs only after staging succeeds AND the tag is a
     non-prerelease semver (`vN.N.N`, no `-rc` / `-beta` suffix), gated by the
     `production` GitHub environment (required-reviewer rule)

### Required GitHub configuration

In **Settings → Secrets and variables → Actions**:

- **Repository secret** `FLY_API_TOKEN_STAGING` — generate via
  `fly tokens create deploy -a attesto-staging`
- **Environment** `production` (Settings → Environments → New environment)
  - **Required reviewers** — add yourself
  - **Environment secret** `FLY_API_TOKEN_PROD` — generate via
    `fly tokens create deploy -a attesto`. Setting it inside the environment
    (not at repo level) ensures only `environment: production` jobs can read it.

### Tagging a release

The repo ships a `mise run deploy <semver>` task that validates and pushes the
tag:

```bash
mise run deploy 0.1.0
```

It checks the working tree is clean, you're on `main`, in sync with origin, and
the tag doesn't already exist — then runs `git tag` + `git push`. GitHub Actions
handles the rest.

You'll see notifications appear in your Discord channel (configured via
`DISCORD_WEBHOOK` repo secret) for image-published, staging-deployed, and
production-deployed events.

### `fly.toml` configuration highlights

- **Region**: `iad` (Ashburn, VA) — Fly's best-connected region for both Apple
  and Google APIs and most North American backends. See
  [`fly.toml`](https://github.com/nossdev/attesto/blob/main/fly.toml) for the
  rationale comment.
- **`auto_stop_machines = "suspend"`** with `min_machines_running = 1` —
  scale-to-zero, but keep one warm machine to avoid cold-start latency on
  webhook delivery.
- **`release_command = "/usr/local/bin/attesto migrate"`** — runs all pending
  Drizzle migrations before swapping the new machine. If migrations fail, the
  deploy aborts and the old machine stays live.
- **Health checks** — `/health` every 30s (cheap), `/ready` every 60s (deeper —
  touches DB + decryption). Fly rolls back the deploy if `/ready` fails.

### Running admin commands on Fly

Fly machines don't have `mise` and there's no `docker compose exec` — just the
compiled `attesto` binary on `$PATH`. SSH in and run subcommands directly:

```bash
fly ssh console -a attesto
# (interactive remote shell)
attesto tenant:create --name "Acme"
attesto webhook:set-config tenant_01HXY... \
  --callback-url https://their-backend.example.com/attesto-webhook \
  --secret "$(openssl rand -base64 32)"
attesto webhook:get tenant_01HXY...
```

Tab completion works, multi-line commands are pleasant, and the rawKey output
from `tenant:create` / `key:create` stays in your terminal scrollback as long as
the session is open.

For staging operations, swap the app name: `-a attesto-staging`.

::: tip Scripted / non-interactive use

If you're automating an admin operation (CI, a wrapper script, etc.), use the
`-C` flag to run a single command non-interactively and capture stdout:

```bash
fly ssh console -a attesto -C "attesto webhook:get tenant_01HXY..."
```

Otherwise prefer the interactive shell.

:::

::: warning rawKey is shown ONCE

`tenant:create` and `key:create` emit the raw secret in their JSON output and
Attesto only stores its SHA-256 hash. Capture the value into a password manager
from your terminal scrollback before closing the session — there's no recovery
path.

:::

For staging operations, swap the app name: `-a attesto-staging`.

### Custom domain on Fly.io

Once your apps are running on `*.fly.dev`, point a custom subdomain at each one.
Five minutes per app:

```bash
# 1. Tell Fly you want this domain on your prod app
fly certs add api.attesto.example.com -a attesto

# Output gives DNS instructions — usually a CNAME:
#   CNAME: api.attesto.example.com → attesto.fly.dev
# OR an A/AAAA pair if your DNS provider doesn't allow CNAMEs at the
# host level you want.

# 2. Add the DNS record at your registrar (manual — Fly doesn't write DNS)
#    Type: CNAME
#    Name: api.attesto
#    Value: attesto.fly.dev
#    TTL: 300 (5 min)

# 3. Wait ~30 seconds for DNS to propagate, then verify
fly certs check api.attesto.example.com -a attesto
# → "Certificate has been issued" once Let's Encrypt provisions
#   (typically 1-5 min after DNS propagates)

# 4. Smoke test
curl https://api.attesto.example.com/health
# → {"status":"ok"}
```

Repeat for staging:

```bash
fly certs add api-staging.attesto.example.com -a attesto-staging
# CNAME api-staging.attesto → attesto-staging.fly.dev
fly certs check api-staging.attesto.example.com -a attesto-staging
```

Notes:

- **Use CNAME at a subdomain** rather than A/AAAA at the apex. The DNS spec
  doesn't allow CNAME at zone roots; modern DNS providers offer workarounds
  (Cloudflare's CNAME flattening, Route 53 Alias) but a real subdomain (`api.`,
  `api-staging.`) is simpler and avoids Fly-IP changes propagating.
- **The `*.fly.dev` URL keeps working** alongside the custom domain — Fly serves
  both. Fine for internal traffic; communicate the custom domain to tenants.
- **TLS is auto-renewing via Let's Encrypt** — Fly handles cert rotation
  transparently as long as the DNS record stays in place.

## Self-hosted Docker compose

The bundled `docker-compose.yml` is suitable for small-scale single-instance
hosting (one app + one local Postgres):

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
cp .env.example .env
# edit .env: set ATTESTO_ENCRYPTION_KEY at minimum

docker compose up -d
docker compose ps
# both services should be "healthy"
```

The compose file:

- Pulls Postgres 16 with healthcheck
- Builds the local Dockerfile
- Runs `attesto migrate` as a separate sidecar container before the app starts,
  so the app never starts against an unmigrated DB
- Mounts a Postgres volume `pgdata/` (gitignored) for durability

For production self-hosting at meaningful scale, consider:

- **Externalize Postgres** — point `DATABASE_URL` at a managed Postgres (RDS,
  Cloud SQL, Supabase, Neon, etc.). The bundled local Postgres is dev-grade.
- **Run multiple `attesto` containers** behind a load balancer for HA. The rate
  limiter is per-process so the effective burst becomes `N × RATE_LIMIT_BURST`.
- **Persistent secrets** — use your platform's secret-management primitive
  rather than `.env` files.

## Self-hosted on any container platform

Pull the image and run:

```bash
# Migration (run once per deploy, before app starts)
docker run --rm \
  -e DATABASE_URL=postgres://… \
  ghcr.io/nossdev/attesto:latest \
  attesto migrate

# Server
docker run -d \
  -e DATABASE_URL=postgres://… \
  -e ATTESTO_ENCRYPTION_KEY=… \
  -p 8080:8080 \
  ghcr.io/nossdev/attesto:latest
```

The image:

- Multi-arch: `linux/amd64` and `linux/arm64`
- Runs as non-root `attesto` user
- `tini` as PID 1 (correct signal handling, zombie-process reaping)
- `attesto` binary at `/usr/local/bin/attesto`, default CMD is the server
- Exposes port 8080
- Built-in `HEALTHCHECK` calls `/health` every 30s

### Kubernetes hints

A bare-bones Deployment + Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: attesto
spec:
  replicas: 2
  selector:
    matchLabels: { app: attesto }
  template:
    metadata:
      labels: { app: attesto }
    spec:
      containers:
        - name: attesto
          image: ghcr.io/nossdev/attesto:v0.1.0
          ports:
            - { containerPort: 8080 }
          env:
            - {
                name: DATABASE_URL,
                valueFrom: {
                  secretKeyRef: { name: attesto-secrets, key: database-url },
                },
              }
            - {
                name: ATTESTO_ENCRYPTION_KEY,
                valueFrom: {
                  secretKeyRef: { name: attesto-secrets, key: encryption-key },
                },
              }
            - { name: NODE_ENV, value: production }
          readinessProbe:
            httpGet: { path: /ready, port: 8080 }
            periodSeconds: 15
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
            periodSeconds: 30
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { cpu: 500m, memory: 512Mi }
---
apiVersion: batch/v1
kind: Job
metadata:
  name: attesto-migrate
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/nossdev/attesto:v0.1.0
          command: ["/usr/local/bin/attesto", "migrate"]
          env:
            - {
                name: DATABASE_URL,
                valueFrom: {
                  secretKeyRef: { name: attesto-secrets, key: database-url },
                },
              }
```

Run the migrate Job before rolling out the Deployment update. Use Argo / Flux /
Helm hooks to enforce that order in your pipeline.

::: tip Multi-replica caveat

The webhook dispatcher is currently single-instance — multi-replica deployments
could double-deliver outbound webhooks because both replicas will pick up
`pending` rows. v0.2 will introduce `FOR UPDATE SKIP LOCKED` to safely scale
dispatchers; for now, run one replica or accept the double-delivery risk.

The verification path is fully stateless and scales horizontally fine.

:::

## What's next

- [Operations](./operations) — monitoring, logging, scaling
- [Maintenance](./maintenance) — key rotation, retention jobs, upgrades
- [Troubleshooting](./troubleshooting) — common deploy / runtime failures

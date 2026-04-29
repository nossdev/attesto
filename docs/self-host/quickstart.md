# Quickstart

Two paths: **local dev** (run from source against Postgres in Docker) and
**self-hosted** (Docker compose with the published image). Both get you to "a
verified Apple sandbox transaction" in roughly 5–10 minutes once you have Apple
credentials in hand.

## Local dev — from source

### Prerequisites

- [**mise**](https://mise.jdx.dev/getting-started.html) — toolchain manager.
  Pins Deno, flyctl, Node, and pnpm to repeatable versions.
- **Docker** — for local Postgres (the dev container is just Postgres; the app
  runs natively under `deno`).

### Setup

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
mise install                             # installs Deno 2.7.12 + flyctl + Node 20 + pnpm 9
cp .mise.local.toml.example .mise.local.toml
```

Edit `.mise.local.toml` and set at minimum:

```toml
[env]
DATABASE_URL          = "postgres://attesto:attesto@localhost:5432/attesto"
ATTESTO_ENCRYPTION_KEY = "<run: openssl rand -base64 32>"
```

Generate the encryption key:

```bash
openssl rand -base64 32
```

Paste the output into `.mise.local.toml`. **Don't lose this** — losing it makes
every encrypted tenant credential unrecoverable.

### Boot it

```bash
mise run db:up                            # starts Postgres in Docker (port 5432)
mise run db:migrate                       # applies all migrations
mise run dev                              # starts Attesto on :8080
```

Smoke-test in a second terminal:

```bash
curl http://localhost:8080/health
# → {"status":"ok"}

curl http://localhost:8080/ready
# → {"status":"ok","checks":{"db":"ok","encryption":"ok"}}
```

Both `200 OK` means the binary boots, the DB is reachable, and the encryption
key decodes correctly.

### Create your first tenant

```bash
mise run cli -- tenant:create --name "My First App"
```

Output:

```json
{
  "id": "tenant_01HXY...",
  "name": "My First App",
  "createdAt": "2026-04-25T..."
}
```

Copy the `id` — you'll need it.

### Mint an API key

```bash
mise run cli -- key:create tenant_01HXY... --env test --name "dev machine"
```

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

**The `rawKey` is shown exactly once.** Save it into your `.mise.local.toml` or
a password manager:

```toml
ATTESTO_KEY = "attesto_test_8xYz..."
```

### Test an authenticated endpoint

Once you have Apple or Google credentials configured (see
[Apple setup](./apple-setup) / [Google setup](./google-setup)), you can verify a
transaction:

```bash
curl -X POST http://localhost:8080/v1/apple/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

That's the local dev loop. From here go to [Apple setup](./apple-setup) or
[Google setup](./google-setup) to wire up real verification.

## Self-hosted — Docker compose

Best for trying out Attesto without installing Deno on your machine, or as the
starting point for a production self-host.

### Prerequisites

- **Docker** + **Docker Compose** (most modern Docker installs include compose
  v2)

### Setup

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
cp .env.example .env
```

Edit `.env`:

```bash
ATTESTO_ENCRYPTION_KEY=<run: openssl rand -base64 32>
```

The bundled `docker-compose.yml` defines the app + Postgres with healthchecks
and migrate-on-start. Bring it up:

```bash
docker compose up -d
docker compose ps
# → app and db both "healthy"
```

Smoke-test:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

### Run admin operations against the running container

The same `attesto` binary handles `serve`, `migrate`, and admin subcommands. For
self-hosted setups, exec into the container:

```bash
docker compose exec attesto attesto tenant:create --name "My First App"
docker compose exec attesto attesto key:create tenant_01HXY... --env test
```

For production self-hosting, see [Deployment](./deployment).

## Pull the image directly

If you don't want the bundled compose stack — for example you have your own
Postgres — just pull the image:

```bash
docker pull ghcr.io/nossdev/attesto:latest
```

Run it directly with your own `DATABASE_URL` and `ATTESTO_ENCRYPTION_KEY`:

```bash
docker run --rm -e DATABASE_URL=postgres://… ghcr.io/nossdev/attesto:latest attesto migrate
docker run -d \
  -e DATABASE_URL=postgres://… \
  -e ATTESTO_ENCRYPTION_KEY=… \
  -p 8080:8080 \
  ghcr.io/nossdev/attesto:latest
```

The image is multi-arch (amd64 + arm64), runs as non-root with `tini` as PID 1,
and exposes the `attesto` binary as the entrypoint.

## Next steps

- [Apple setup](./apple-setup) — wire up your first Apple verification
- [Google setup](./google-setup) — wire up Google Play
- [Webhooks](/guide/webhooks) — receive Apple S2S / Google RTDN events
- [Architecture](/guide/architecture) — what's actually happening under the hood

# Attesto

> Thin, open-source receipt validation for Apple App Store and Google Play in-app purchases.

[![CI](https://github.com/nossdev/attesto/actions/workflows/ci.yml/badge.svg)](https://github.com/nossdev/attesto/actions/workflows/ci.yml)
[![Docker](https://github.com/nossdev/attesto/actions/workflows/docker.yml/badge.svg)](https://github.com/nossdev/attesto/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Deno](https://img.shields.io/badge/Deno-2.7+-000?logo=deno)](https://deno.com)

Attesto is a trusted proxy that verifies purchase tokens with Apple and Google on your behalf and returns verified transaction data. It does **one thing**: confirm that a transaction is real. Your backend decides what that means for your users.

```
Client app  ─►  Your backend  ─►  Attesto  ─►  Apple / Google
                                     │
                                     └─►  Verified payload returned to your backend
```

## Why Attesto exists

Every app that sells anything via the App Store or Google Play needs server-side receipt validation. The actual implementation involves:

- ES256 JWT signing with `.p8` keys
- JWS chain verification against pinned Apple roots (G1/G2/G3) with OCSP
- Google service-account OAuth flows with token caching
- Webhook ingestion (Apple S2S V2, Google Pub/Sub RTDN) with cryptographic origin verification
- Constant API churn from Apple/Google

Most teams reinvent this badly or skip it entirely. Attesto removes the burden — drop it in, configure your credentials once, and stop thinking about receipt cryptography.

## What Attesto does

- ✅ Verify Apple `transactionId` via App Store Server API + JWS signature verification (SDK-backed, pinned roots, OCSP)
- ✅ Verify Google `purchaseToken` via Google Play Developer API (subscription + product)
- ✅ Auto-detect sandbox vs production for Apple
- ✅ Receive Apple App Store Server Notifications V2 webhooks (JWS-verified)
- ✅ Receive Google Real-Time Developer Notifications via Pub/Sub (OIDC JWT-verified)
- ✅ Forward verified webhook events to your callback URL with HMAC signatures + retry/backoff
- ✅ Per-tenant credential isolation (encrypted at rest, AES-256-GCM with HKDF-derived per-context subkeys)
- ✅ Simple API-key auth model with per-tenant rate limiting
- ✅ Optional append-only audit log (HMAC-keyed identifier hashes — DB-read alone can't correlate purchases across tenants)

## What Attesto explicitly does NOT do

- ❌ Manage entitlements ("is user X premium right now?")
- ❌ Track subscription state machines (grace periods, billing retry, lifecycle)
- ❌ Store purchase history as source of truth
- ❌ Analytics, revenue tracking, or dashboards
- ❌ Offer codes, promotional logic, or trials
- ❌ Make business decisions — it returns verified data; you interpret it

If you need those things, use [RevenueCat](https://revenuecat.com) or [iaptic](https://iaptic.com). Attesto is deliberately thin and that boundary is non-negotiable.

## Client integration (optional)

Attesto is **client-agnostic** — any backend that can speak HTTPS can call it. If you're already shipping native StoreKit / Google Play Billing flows, your client doesn't need to change.

If you're building on **Capacitor**, [`@nossdev/iap`](https://iap.nossdev.com) is the companion client library. It orchestrates the purchase flow on the client, forwards receipts to your backend (which calls Attesto), and caches entitlements locally — no phantom grants, full restore support.

## Example: verifying an Apple transaction

```bash
curl -X POST https://your-attesto.example.com/v1/apple/verify \
  -H "Authorization: Bearer attesto_live_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{"transactionId": "2000000123456789"}'
```

Response (verified):

```json
{
  "valid": true,
  "environment": "production",
  "transaction": {
    "transactionId": "2000000123456789",
    "originalTransactionId": "2000000000123456",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "purchaseDate": "2026-04-10T14:22:10.000Z",
    "expiresDate": "2026-05-10T14:22:10.000Z",
    "type": "Auto-Renewable Subscription",
    "price": 9990,
    "currency": "USD",
    "signedTransactionInfo": "<original JWS>",
    "rawDecodedPayload": { "...": "..." }
  }
}
```

Response (not found):

```json
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Transaction ID not found in production or sandbox"
}
```

Full API reference: [`docs/reference/api.md`](docs/reference/api.md). Webhooks: [`docs/guide/webhooks.md`](docs/guide/webhooks.md).

## Quickstart — local dev

**Prerequisites:** [mise](https://mise.jdx.dev/getting-started.html) (manages Deno + flyctl) and Docker.

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
mise install                             # install Deno + flyctl pinned in mise.toml
cp .mise.local.toml.example .mise.local.toml
# edit .mise.local.toml — at minimum set ATTESTO_ENCRYPTION_KEY (`openssl rand -base64 32`)
mise run db:up                           # start Postgres in Docker
mise run db:migrate                      # apply schema
mise run dev                             # start Attesto in watch mode
curl http://localhost:8080/health        # → {"status":"ok"}
```

Create a tenant + API key:

```bash
mise run cli -- tenant:create --name "My App"        # → tenant_XXXX...
mise run cli -- key:create tenant_XXXX --env test    # → raw key, shown ONCE
```

Set up per-tenant Apple / Google credentials: see the [Apple setup](docs/guide/apple-setup.md) and [Google setup](docs/guide/google-setup.md) guides.

## Quickstart — self-hosting (Docker)

The published image is on GitHub Container Registry:

```bash
docker pull ghcr.io/nossdev/attesto:latest
```

Or use the bundled `docker-compose.yml` (app + Postgres + healthchecks):

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
cp .env.example .env
# edit .env — set ATTESTO_ENCRYPTION_KEY at minimum
docker compose up -d
```

App boots on `:8080`. Run admin operations via the same image:

```bash
docker compose exec attesto attesto tenant:create --name "My App"
```

## Production deployment (Fly.io)

Attesto ships with `fly.toml` (prod) and `fly.staging.toml` (staging). The CI pipeline auto-deploys staging on `v*` tag push and gates production behind GitHub environment approval.

```bash
fly auth login
fly launch --no-deploy --copy-config --name attesto --region iad
fly postgres create --name attesto-db --region iad
fly postgres attach --app attesto attesto-db
fly secrets set -a attesto ATTESTO_ENCRYPTION_KEY="$(openssl rand -base64 32)"
fly deploy
```

Full guide: [`docs/guide/deployment.md`](docs/guide/deployment.md).

## Architecture at a glance

- **Stateless validation path** — `/v1/apple/verify` and `/v1/google/verify` only read tenant credentials (cached in-memory with TTL). No DB writes per request.
- **Stateful webhook path** — Apple/Google webhooks are JWS- or OIDC-verified, persisted with idempotency keys (`notificationUUID` / `messageId`), and dispatched to your callback with HMAC signatures + exponential-backoff retry.
- **Per-tenant credential isolation** — Apple `.p8` keys, Google service-account JSONs, and webhook secrets are encrypted at rest with AES-256-GCM. Each column uses an HKDF-derived subkey so plaintext compromise of one column doesn't weaken any other.
- **Outbound webhook signing** — `X-Attesto-Signature: t=<unix_ts>,v1=<hex_hmac>`, signed value is `timestamp + "." + body`. Reject events older than 5 minutes to prevent replay.

Full design rationale: [`docs/guide/architecture.md`](docs/guide/architecture.md).

## Tech stack

| Layer               | Choice                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime             | [Deno 2](https://deno.com) — TypeScript native, secure-by-default permissions, single-binary `deno compile` output |
| Web framework       | [Hono](https://hono.dev) — tiny, fast, runtime-portable                                                            |
| Database            | PostgreSQL 16+                                                                                                     |
| ORM                 | [Drizzle](https://orm.drizzle.team)                                                                                |
| Validation          | [Zod](https://zod.dev)                                                                                             |
| Apple verification  | [`@apple/app-store-server-library`](https://github.com/apple/app-store-server-library-node) (official)             |
| Google verification | [`googleapis`](https://github.com/googleapis/google-api-nodejs-client) (official)                                  |

## Documentation

The full documentation is a [VitePress site](docs/) deployed on Netlify. Highlights:

- [What is Attesto?](docs/guide/what-is-attesto.md) — positioning + scope
- [Quickstart](docs/guide/quickstart.md) — local dev or self-host in 5 minutes
- [Architecture](docs/guide/architecture.md) — request flows, data model, threat model
- [Apple setup](docs/guide/apple-setup.md) / [Google setup](docs/guide/google-setup.md) — credential install walkthroughs
- [Tenants](docs/guide/tenants.md) — multi-app / multi-environment patterns
- [Webhooks](docs/guide/webhooks.md) — inbound + outbound HMAC pipeline
- [Deployment](docs/guide/deployment.md) — Fly.io + Docker compose + Kubernetes
- [Operations](docs/guide/operations.md) — what to monitor, how to scale
- [Maintenance](docs/guide/maintenance.md) — key rotation, retention, upgrades
- [Testing](docs/guide/testing.md) / [Troubleshooting](docs/guide/troubleshooting.md)
- [API reference](docs/reference/api.md) / [Error codes](docs/reference/error-codes.md)
- [`PLAN.md`](PLAN.md) — original spec and roadmap (historical)
- [`CHANGELOG.md`](CHANGELOG.md) — what has shipped

## Managed offering

A hosted version of Attesto is available from [Night Owl Software Studios](https://nossdev.com) for teams that don't want to operate their own validation infrastructure. The self-hosted version is and will remain free + fully functional under MIT.

## Contributing

PRs welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — the scope guardrails (what Attesto does and doesn't do) are strictly enforced. Security issues: see [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

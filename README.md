# Attesto

> Thin, open-source receipt validation for Apple App Store and Google Play in-app purchases.

Attesto is a trusted proxy that verifies purchase tokens with Apple and Google on your behalf and returns verified transaction data. It does **one thing**: confirm that a transaction is real. Your backend decides what that means for your users.

## Status

Pre-release. Building toward **v0.1.0**. See `PLAN.md` for the full roadmap and `CHANGELOG.md` for what has shipped.

## What Attesto does

- Verify Apple `transactionId` via App Store Server API + local JWS verification
- Verify Google `purchaseToken` via Google Play Developer API
- Auto-detect sandbox vs production for Apple
- Receive Apple App Store Server Notifications V2 webhooks
- Receive Google Real-Time Developer Notifications via Pub/Sub
- Forward verified webhook events to your callback URL with HMAC signatures
- Per-tenant credential isolation (bundle IDs, `.p8` keys, service account JSONs)
- Simple API-key auth model

## What Attesto explicitly does NOT do

- Manage entitlements ("is user X premium right now?")
- Track subscription state machines (grace periods, billing retry)
- Store purchase history as source of truth
- Analytics, revenue tracking, or dashboards
- Offer codes, promotional logic, or trials
- Make business decisions — it returns verified data; you interpret it

If you need those things, use [RevenueCat](https://revenuecat.com) or [iaptic](https://iaptic.com). Attesto is deliberately thin.

## Quickstart (local dev)

**Prerequisites:** [mise](https://mise.jdx.dev/getting-started.html), Docker.

```bash
git clone https://github.com/nossdev/attesto.git
cd attesto
mise install                             # install Deno + flyctl pinned in mise.toml
cp .mise.local.toml.example .mise.local.toml
# edit .mise.local.toml — at minimum set ATTESTO_ENCRYPTION_KEY (openssl rand -base64 32)
mise run db:up                           # start Postgres in Docker
mise run db:migrate                      # apply schema
mise run dev                             # start Attesto in watch mode
curl http://localhost:8080/health        # → {"status":"ok"}
```

## Self-hosting

```bash
docker compose up -d
```

See `docs/deployment.md` (shipping in Phase 7) for details.

## Contributing

See `CONTRIBUTING.md`. Security issues: see `SECURITY.md`.

## License

MIT — see `LICENSE`.

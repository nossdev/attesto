# Self-host Attesto

Attesto is open-source under MIT and runs anywhere you can run a Deno container
with a Postgres connection. Self-hosting gives you full control of your data
path and zero recurring cost — at the price of running the validation
infrastructure yourself.

::: tip Most teams should use the managed service

The hosted Attesto at `api.attesto.nossdev.com` is run by
[Night Owl Software Studios](https://nossdev.com) — Apple key rotations, Google
service-account management, monitoring, and upstream-API change tracking are all
handled. If you'd rather ship features than operate validation infra,
[get integrated](/guide/quickstart) instead.

Self-hosting is the right path when you have ops capacity, need data residency
you control, or want to fork the codebase.

:::

## What you'll need

- A Deno 2 runtime (or the published Docker image at `ghcr.io/nossdev/attesto`)
- PostgreSQL 16+
- Apple `.p8` key for App Store Server API access (per app)
- Google service-account JSON for Play Developer API (per app)
- A 32-byte symmetric encryption key (`openssl rand -base64 32`) for the
  credential vault

## Three paths from here

### 1. Try it locally

[Quickstart](./quickstart) walks through cloning the repo, running Postgres in
Docker, and booting Attesto in watch mode. ~5 minutes.

### 2. Set up your first tenant

Once Attesto is running (locally or deployed),
[Onboarding a tenant](./onboarding) is the operator runbook for enrolling a new
app: mint the API key, install Apple/Google credentials, configure webhooks,
hand off to the integrator.

### 3. Deploy to production

[Deployment](./deployment) covers Fly.io (the reference deploy used by the
managed service), Docker compose, and Kubernetes. [Operations](./operations) and
[Maintenance](./maintenance) cover day-2 concerns once you're live.

## Section map

**Getting started**

- [Quickstart](./quickstart) — local dev in 5 minutes

**Tenant setup**

- [Onboarding a tenant](./onboarding) — full operator runbook
- [Apple setup](./apple-setup) — install `.p8` keys per tenant
- [Google setup](./google-setup) — install service-account JSONs per tenant
- [Webhooks](./webhooks) — register Apple S2S / Google Pub/Sub URLs and
  per-tenant callbacks
- [Tenants](./tenants) — multi-app, multi-environment patterns

**Operating it**

- [Deployment](./deployment) — Fly / Docker / Kubernetes
- [Operations](./operations) — what to monitor, how to scale
- [Maintenance](./maintenance) — key rotation, retention, upgrades
- [Testing](./testing) — running the test suite before release
- [Load testing](./load-testing) — capacity validation
- [Troubleshooting](./troubleshooting) — symptom-keyed problem-solving

## Reference

- [API reference](/reference/api) — every endpoint, request/response shapes
- [Error codes](/reference/error-codes) — every code, with caller actions
- [Architecture](/guide/architecture) — request flows, data model, threat model

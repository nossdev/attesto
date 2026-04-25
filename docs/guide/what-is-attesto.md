# What is Attesto?

Attesto is a **thin, open-source receipt validation proxy** for in-app
purchases on Apple App Store and Google Play. Your backend POSTs a transaction
identifier; Attesto verifies it with Apple or Google, returning the verified
payload. Webhooks from the stores get cryptographically authenticated,
deduplicated, and forwarded to your callback with HMAC signatures.

That's it. No entitlement state, no subscription state machines, no offer-code
business logic. Attesto answers one question well — _"is this transaction
real and what does it say?"_ — and leaves the interpretation to you.

## Who Attesto is for

- **App teams who sell anything via App Store or Google Play** and need
  server-side receipt validation. The UI handles the purchase; your backend
  needs to confirm it before granting access to paid content. Attesto is the
  piece in the middle.
- **Solo developers and small studios** without the resources to maintain
  bespoke JWT signing, JWS chain verification, OAuth token caching, and
  Pub/Sub OIDC verification — all of which evolve quietly as Apple and Google
  ship API changes.
- **Privacy-conscious teams** who want their receipt-validation traffic to
  stay self-hosted on infrastructure they control rather than passing through
  a third-party SaaS that sees every purchase.

## Why it exists

Server-side receipt validation is **hard to do badly and easy to do
incorrectly**. The actual implementation involves:

- ES256 JWT signing with Apple `.p8` keys (rotated, scoped per app)
- JWS chain verification against pinned Apple roots (G1 / G2 / G3) with OCSP
  revocation checks
- Google service-account OAuth with token caching across an expiry-aware TTL
- Apple App Store Server Notifications V2 (JWS-signed payloads) and
  Google Real-Time Developer Notifications via Pub/Sub (OIDC-JWT-signed push)
- Constant API churn from Apple and Google — cert rotations, deprecated
  endpoints, new fields appearing in subscription responses

Most teams either reinvent this badly (no JWS verification, no
revocation checks, no replay protection) or skip it entirely (trusting
client-supplied receipts, which is a fraud vector). Attesto removes the
burden — drop it in, configure your credentials once, and stop thinking
about receipt cryptography.

## What Attesto does

- ✅ **Verify Apple `transactionId`** via the App Store Server API + JWS
  signature verification (SDK-backed, pinned roots, OCSP)
- ✅ **Verify Google `purchaseToken`** via the Google Play Developer API
  (subscriptions and one-shot products)
- ✅ **Auto-detect sandbox vs production** for Apple
- ✅ **Receive Apple S2S V2 webhooks** with cryptographic origin
  authentication
- ✅ **Receive Google Pub/Sub RTDN** with OIDC-JWT origin authentication
- ✅ **Forward verified events to your callback URL** with HMAC signatures,
  exponential-backoff retry, and idempotency
- ✅ **Per-tenant credential isolation** — Apple `.p8` keys, Google
  service-account JSONs, and webhook secrets encrypted at rest with
  AES-256-GCM and HKDF-derived per-context subkeys
- ✅ **Simple API-key auth model** with per-tenant rate limiting
- ✅ **Optional append-only audit log** with HMAC-keyed identifier hashes —
  DB-read alone can't correlate purchases across tenants

## What Attesto explicitly does NOT do

- ❌ Manage entitlements ("is user X premium right now?")
- ❌ Track subscription state machines (grace periods, billing retry, lifecycle)
- ❌ Store purchase history as source of truth
- ❌ Analytics, revenue tracking, or dashboards
- ❌ Offer codes, promotional logic, or trials
- ❌ Make business decisions — it returns verified data; you interpret it

If you need entitlement management, subscription analytics, or
cross-platform paywall tooling, you almost certainly want
[RevenueCat](https://revenuecat.com) or [iaptic](https://iaptic.com).
Attesto is **deliberately thin**, and that boundary is non-negotiable.

## How it fits into your architecture

```
Mobile client
    │  user completes a purchase
    ▼
Apple / Google Play         (authoritative source)
    │
    │  client receives transactionId / purchaseToken
    ▼
Your backend
    │  POST /v1/apple/verify  { transactionId }
    │  Authorization: Bearer attesto_live_…
    ▼
Attesto
    │  signs JWT, calls App Store Server API,
    │  verifies JWS against pinned Apple roots,
    │  returns normalized + raw payload
    ▼
Your backend
    │  decides what the verified data means
    │  (grant access, update subscription state, etc.)
    ▼
Mobile client
```

Attesto is the **vertical bar in the middle** — small, focused, and
auditable. Your backend remains the source of truth for entitlements; Attesto
just answers the cryptographic question on its behalf.

## Next steps

- [Quickstart](./quickstart) — get a local instance running in 5 minutes
- [Architecture](./architecture) — request flows, data model, threat model
- [Apple setup](./apple-setup) — configure your first tenant for Apple
- [Google setup](./google-setup) — configure for Google Play

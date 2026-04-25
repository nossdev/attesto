---
layout: home
title: Attesto
titleTemplate: Receipt validation, without the headache.

hero:
  name: Attesto
  text: Receipt validation, without the headache.
  tagline: Drop in. Configure once. Stop thinking about JWS chains, OCSP, and OAuth.
  image:
    src: /attesto-logo-full.svg
    alt: Attesto
  actions:
    - theme: brand
      text: Get started
      link: /guide/quickstart
    - theme: alt
      text: Integrate with Attesto
      link: /guide/integration
    - theme: alt
      text: View on GitHub
      link: https://github.com/nossdev/attesto

features:
  - icon:
      src: /icons/apple.svg
      alt: Apple
      width: 48
      height: 48
    title: Verify Apple in one call
    details: POST a transactionId, get a verified payload. SDK-backed JWS verification with pinned roots, OCSP, and sandbox auto-detection.
  - icon:
      src: /icons/google.svg
      alt: Google
      width: 48
      height: 48
    title: Verify Google in one call
    details: Subscriptions and one-shots via the Play Developer API. OAuth + caching handled. Returns the raw response so your backend keeps full fidelity.
  - icon: 📨
    title: Webhooks done right
    details: Apple S2S V2 + Google Pub/Sub RTDN ingested, deduplicated, then forwarded to your callback with HMAC signatures and exponential-backoff retry.
  - icon: 🛡️
    title: Per-tenant isolation
    details: Apple keys, Google service accounts, and webhook secrets encrypted at rest with AES-256-GCM and HKDF-derived per-context subkeys. One tenant's compromise doesn't widen the blast radius.
---

## See it in action

A complete Apple verification — request and response. No SDK install, no
client library, just HTTP:

```bash
curl -X POST https://attesto.your-host.com/v1/apple/verify \
  -H "Authorization: Bearer attesto_live_…" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

```json
{
  "valid": true,
  "environment": "production",
  "transaction": {
    "transactionId": "2000000123456789",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "purchaseDate": "2026-04-10T14:22:10.000Z",
    "expiresDate": "2026-05-10T14:22:10.000Z",
    "type": "Auto-Renewable Subscription",
    "currency": "USD",
    "price": 9990,
    "signedTransactionInfo": "<original Apple JWS>",
    "rawDecodedPayload": { "...": "..." }
  }
}
```

Google verification has the same shape — different request fields,
identical response envelope. See the
[API reference](/reference/api) for every endpoint.

## Why thin?

Receipt validation is a commodity. Every app that sells anything via the
App Store or Google Play needs server-side verification, and the actual
implementation involves ES256 JWT signing, JWS chain verification
against pinned roots, OCSP revocation checks, Google service-account
OAuth, and constant API churn from Apple and Google.

Most teams reinvent this badly or skip it entirely. Attesto removes
the burden — drop it in, configure your credentials once, and stop
thinking about receipt cryptography.

**Attesto explicitly is NOT** RevenueCat or iaptic. It does not manage
entitlements, track subscription state machines, or interpret business
logic. It answers one question well — "is this transaction real and
what does it say?" — and leaves the interpretation to you. If you need
entitlement management, paywalls, or revenue analytics, look elsewhere.

[Read the full positioning →](/guide/what-is-attesto)

## Open source. Battle-tested.

Attesto is [MIT-licensed](https://github.com/nossdev/attesto/blob/main/LICENSE)
and [public on GitHub](https://github.com/nossdev/attesto). The full source
of every line that touches your `.p8` keys and webhook secrets is
auditable today. No closed-source backend, no proprietary "magic."

- 232 unit + integration tests
- SDK-backed Apple JWS verification with pinned root CAs
- Google OIDC JWT verification with JWKS caching
- AES-256-GCM with HKDF-derived per-context encryption subkeys
- Cryptographic origin verification on every inbound webhook

[Browse the changelog](https://github.com/nossdev/attesto/blob/main/CHANGELOG.md)
to see what's shipped.

## Two ways to use Attesto

<div class="paths-grid">
  <div class="path-card">
    <h3>Self-host (free, MIT)</h3>
    <p>
      Clone, configure your encryption key, deploy to Fly.io / Docker /
      Kubernetes / your own infrastructure. Full control, zero recurring
      cost. Recommended if you have an ops team and want to control your
      own data path.
    </p>
    <p>
      <a href="/guide/quickstart" class="vp-button">Self-host setup →</a>
    </p>
  </div>
  <div class="path-card">
    <h3>Managed (we operate it)</h3>
    <p>
      We run Attesto for you. Apple key rotations, Google service-account
      management, monitoring, upstream-API change tracking — all handled.
      You get an API key and a webhook callback URL. Recommended for
      teams who'd rather ship features than operate validation infra.
    </p>
    <p>
      <a href="/guide/integration" class="vp-button">Integrate →</a>
    </p>
  </div>
</div>

<ContactSection />

## Ready to get started?

Five minutes from `git clone` to a verified sandbox transaction:

<div style="text-align: center; margin: 2rem 0;">
  <a href="/guide/quickstart" class="vp-button-primary">Read the quickstart →</a>
</div>

<style scoped>
.paths-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
  margin: 2rem 0;
}

@media (min-width: 768px) {
  .paths-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.path-card {
  padding: 1.75rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}

.path-card h3 {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}

.vp-button {
  display: inline-block;
  padding: 0.5rem 1.25rem;
  background: transparent;
  color: var(--vp-c-brand-1);
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 20px;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.2s, color 0.2s;
}

.vp-button:hover {
  background: var(--vp-c-brand-1);
  color: white;
}

.vp-button-primary {
  display: inline-block;
  padding: 0.75rem 2rem;
  background: var(--vp-c-brand-1);
  color: white;
  border-radius: 22px;
  font-weight: 600;
  font-size: 1.05rem;
  text-decoration: none;
  transition: background 0.2s;
}

.vp-button-primary:hover {
  background: var(--vp-c-brand-2);
}
</style>


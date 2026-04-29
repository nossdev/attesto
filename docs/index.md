---
layout: home
title: Attesto
titleTemplate: Receipt validation, without the headache.

hero:
  name: Attesto
  text: Receipt validation, without the headache.
  tagline: Drop in. Configure once. Stop thinking about JWS chains, OCSP, and OAuth.
  image:
    src: /attesto-logo.svg
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
    details: Apple keys, Google service accounts, and webhook secrets encrypted at rest with AES-256-GCM and HKDF-derived per-context subkeys.
---

<section class="home-section home-section--soft">
<div class="home-inner">

<div class="section-eyebrow">See it in action</div>

# One HTTP call. Verified payload back.

<p class="section-lead">
No SDK, no client library. Your backend POSTs a transaction ID, Attesto signs the JWT, calls Apple, verifies the JWS chain, and returns the decoded transaction.
</p>

<div class="demo-grid">
<div class="demo-col">

<div class="demo-label">Request</div>

```bash
curl -X POST https://{{ATTESTO_API_HOST}}/v1/apple/verify \
  -H "Authorization: Bearer attesto_live_…" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

</div>
<div class="demo-col">

<div class="demo-label">Response</div>

```json
{
  "valid": true,
  "environment": "production",
  "transaction": {
    "transactionId": "2000000123456789",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "expiresDate": "2026-05-10T14:22:10.000Z",
    "currency": "USD",
    "price": 9990,
    "rawDecodedPayload": { "...": "..." }
  }
}
```

</div>
</div>

<p class="section-foot">
Google verification has the same shape — different request fields, identical envelope.
<a href="/reference/api">See the full API reference →</a>
</p>

</div>
</section>

<section class="home-section">
<div class="home-inner">

<div class="section-eyebrow">Thin by design</div>

# Receipt validation. Nothing else.

<p class="section-lead">
Attesto answers one question well — <em>"is this transaction real and what does it say?"</em> — and leaves the interpretation to you. If you need entitlements, paywalls, or analytics, look at <a href="https://revenuecat.com">RevenueCat</a> or <a href="https://iaptic.com">iaptic</a>.
</p>

<div class="comparison-grid">
<div class="comparison-col comparison-col--positive">

<div class="comparison-header">Attesto does</div>

<ul>
<li>Verify Apple <code>transactionId</code> with JWS chain + OCSP</li>
<li>Verify Google <code>purchaseToken</code> (subscription + product)</li>
<li>Receive Apple S2S V2 webhooks (JWS-verified)</li>
<li>Receive Google Pub/Sub RTDN (OIDC JWT-verified)</li>
<li>Forward HMAC-signed events with retry/backoff</li>
<li>Per-tenant credential vault (encrypted at rest)</li>
<li>Fail closed on every signature/auth failure</li>
</ul>

</div>
<div class="comparison-col comparison-col--negative">

<div class="comparison-header">Attesto doesn't</div>

<ul>
<li>Manage entitlements ("is user X premium?")</li>
<li>Track subscription state machines</li>
<li>Store purchase history as source of truth</li>
<li>Analytics, revenue tracking, dashboards</li>
<li>Offer codes, promotional logic, trials</li>
<li>A/B testing for IAPs</li>
<li>Make business decisions on your behalf</li>
</ul>

</div>
</div>

<p class="section-foot">
This boundary is non-negotiable.
<a href="/guide/what-is-attesto">Read the full positioning →</a>
</p>

</div>
</section>

<section class="home-section home-section--soft">
<div class="home-inner">

<div class="section-eyebrow">Open source</div>

# Auditable. Self-hostable. MIT.

<p class="section-lead">
Every line that touches your <code>.p8</code> keys and webhook secrets is reviewable today. No closed-source backend, no proprietary magic.
</p>

<div class="stats-grid">
<div class="stat">
<div class="stat-num">MIT</div>
<div class="stat-label">License — fork it, host it, modify it</div>
</div>
<div class="stat">
<div class="stat-num">232</div>
<div class="stat-label">Tests — unit + integration</div>
</div>
<div class="stat">
<div class="stat-num">100%</div>
<div class="stat-label">Public on GitHub — every line auditable</div>
</div>
</div>

<ul class="security-list">
<li>SDK-backed Apple JWS verification with pinned root CAs</li>
<li>Google OIDC JWT verification with JWKS caching</li>
<li>AES-256-GCM encryption with HKDF-derived per-context subkeys</li>
<li>Cryptographic origin verification on every inbound webhook</li>
</ul>

<div class="cta-row">
<a href="https://github.com/nossdev/attesto" class="vp-button vp-button--brand">Browse on GitHub →</a>
<a href="https://github.com/nossdev/attesto/blob/main/CHANGELOG.md" class="vp-button">Changelog</a>
</div>

</div>
</section>

<section class="home-section">
<div class="home-inner">

<div class="section-eyebrow">Two ways to run it</div>

# Self-host or let us operate it.

<div class="paths-grid">
<div class="path-card">

<div class="path-tag">Free, forever</div>

### Self-host

Clone the repo, configure your encryption key, deploy to Fly / Docker / Kubernetes / your own infra. Full control, zero recurring cost.

Recommended if you have ops capacity and want to control your own data path.

<a href="/guide/quickstart" class="vp-button">Self-host setup →</a>

</div>
<div class="path-card path-card--brand">

<div class="path-tag path-tag--brand">Hosted by Night Owl</div>

### Managed

We operate Attesto for you. Apple key rotations, Google service-account management, monitoring, upstream-API change tracking — all handled. You get an API key and a webhook callback URL.

Recommended for teams who'd rather ship features than operate validation infra.

<a href="/guide/integration" class="vp-button vp-button--brand">Integrate with us →</a>

</div>
</div>

</div>
</section>

<section class="home-section home-section--soft">
<div class="home-inner">

<div class="section-eyebrow">Companion library</div>

# `@nossdev/iap` — Capacitor client SDK

<p class="section-lead">
Building a Capacitor app? <a href="https://iap.nossdev.com">@nossdev/iap</a> is the open-source client SDK that pairs with Attesto. It handles the "client → your backend" leg of the architecture: native purchase + restore, receipt forwarding, and entitlement caching with recovery across app launches.
</p>

<div class="cta-row">
<a href="https://iap.nossdev.com" class="vp-button vp-button--brand">View iap docs →</a>
<a href="https://github.com/nossdev/iap" class="vp-button">Source on GitHub</a>
</div>

</div>
</section>

<section class="home-section home-section--final">
<div class="home-inner">

<ContactSection />

</div>
</section>

<style scoped>
/* ─── Full-bleed sections ──────────────────────────────────────────────────
 * VitePress wraps below-frontmatter markdown in `.vp-doc.container` with a
 * narrow max-width for prose. We escape that constraint with the classic
 * 100vw + negative-margin technique so each section can fill the viewport
 * width, with content centered inside an inner wrapper at a wider max.
 */
.home-section {
  width: 100vw;
  margin-left: calc(-50vw + 50%);
  /* 6rem (was 5rem) gives enough breathing room above each section that
   * adjacent elements (e.g. the VitePress feature cards above the first
   * section) don't visually touch the section's content edge. */
  padding: 6rem 1.5rem;
  /* border-top removed: the alternating bg / bg-soft backgrounds
   * provide visual section separation in light mode. On dark mode where
   * the contrast is subtler, the increased padding gives enough
   * breathing room without needing a hard 1px line that was visually
   * touching the previous section's bottom edge. */
}

.home-section--soft {
  background: var(--vp-c-bg-soft);
}

.home-section--final {
  border-bottom: none;
}

.home-inner {
  max-width: 1152px;
  margin: 0 auto;
}

/* Section typography. Override vp-doc's default h1/h2 underlining + margins. */
.home-section .section-eyebrow {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  margin-bottom: 0.75rem;
}

.home-section h1 {
  margin: 0 0 1rem;
  border: none;
  padding: 0;
  font-size: clamp(1.875rem, 4vw, 2.75rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--vp-c-text-1);
}

.home-section h2,
.home-section h3 {
  border: none;
  padding-top: 0;
}

.home-section .section-lead {
  font-size: 1.125rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 720px;
  /* 3.5rem of space below the lead so the boxes / cards / stats grid
   * below have clear breathing room. The previous 2.5rem felt cramped. */
  margin: 0 0 3.5rem;
}

.home-section .section-foot {
  margin-top: 2rem;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
}

/* ─── See-it-in-action: side-by-side request/response ──────────────────── */
.demo-grid {
  display: grid;
  grid-template-columns: 1fr;
  /* 2rem gap between request and response columns (and between stacked
   * blocks on mobile). Tighter than this looked cramped against the
   * 1.5rem sections elsewhere on the page. */
  gap: 2rem;
}

/* Critical for mobile: grid items default to `min-width: auto`, which
 * means a code block with long lines will expand its column past the
 * grid's intended track width and push the whole layout. `min-width: 0`
 * forces the column to obey its 1fr share; the code block then scrolls
 * horizontally INSIDE itself instead. */
.demo-col,
.demo-grid > * {
  min-width: 0;
}

@media (min-width: 960px) {
  .demo-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.demo-col :deep(.language-bash),
.demo-col :deep(.language-json) {
  margin: 0;
}

.demo-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin-bottom: 0.5rem;
}

/* ─── Comparison: does / doesn't ───────────────────────────────────────── */
.comparison-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
}

@media (min-width: 768px) {
  .comparison-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.comparison-col {
  padding: 1.75rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
}

.comparison-col--positive {
  border-color: var(--vp-c-brand-1);
  border-width: 1px;
}

.comparison-header {
  font-size: 0.875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.comparison-col--positive .comparison-header {
  color: var(--vp-c-brand-1);
  border-bottom-color: var(--vp-c-brand-soft);
}

.comparison-col--negative .comparison-header {
  color: var(--vp-c-text-3);
}

.comparison-col ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.comparison-col li {
  position: relative;
  padding: 0.55rem 0 0.55rem 1.85rem;
  border-bottom: 1px solid var(--vp-c-divider-light, var(--vp-c-divider));
  line-height: 1.5;
  font-size: 0.95rem;
}

.comparison-col li:last-child {
  border-bottom: none;
}

.comparison-col li::before {
  position: absolute;
  left: 0;
  font-weight: 700;
  font-size: 1.1rem;
  line-height: 1;
  top: 0.65rem;
}

.comparison-col--positive li::before {
  content: "✓";
  color: var(--vp-c-brand-1);
}

.comparison-col--negative li::before {
  content: "✗";
  color: var(--vp-c-text-3);
  opacity: 0.6;
}

/* ─── Stats row + security feature list ─────────────────────────────── */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
  margin-bottom: 2.5rem;
}

@media (min-width: 768px) {
  .stats-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.stat {
  text-align: center;
  padding: 2rem 1rem;
  background: var(--vp-c-bg);
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
}

.stat-num {
  font-size: 2.5rem;
  font-weight: 800;
  color: var(--vp-c-brand-1);
  line-height: 1;
  letter-spacing: -0.02em;
}

.stat-label {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--vp-c-text-2);
}

.security-list {
  margin: 0 0 2rem;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.5rem;
}

.security-list li {
  position: relative;
  padding-left: 1.5rem;
  font-size: 0.95rem;
  line-height: 1.5;
}

.security-list li::before {
  content: "🔒";
  position: absolute;
  left: 0;
}

/* ─── Path cards (self-host vs managed) ────────────────────────────────── */
.paths-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
}

@media (min-width: 768px) {
  .paths-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.path-card {
  padding: 2rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
}

.path-card--brand {
  border-color: var(--vp-c-brand-1);
  border-width: 2px;
  background: linear-gradient(180deg, var(--vp-c-brand-soft) 0%, var(--vp-c-bg) 100%);
}

.path-card h3 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
  font-weight: 700;
}

.path-card p {
  flex: 1;
  margin: 0 0 1rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.path-tag {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  margin-bottom: 1rem;
  align-self: flex-start;
}

.path-tag--brand {
  background: var(--vp-c-brand-1);
  color: white;
}

.path-card .vp-button {
  align-self: flex-start;
  margin-top: 0.5rem;
}

/* ─── Buttons ──────────────────────────────────────────────────────────── */
.vp-button {
  display: inline-block;
  padding: 0.625rem 1.5rem;
  background: transparent;
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
  border-radius: 22px;
  font-weight: 600;
  font-size: 0.95rem;
  text-decoration: none;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
  margin-right: 0.5rem;
}

.vp-button:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-text-2);
}

.vp-button--brand {
  background: var(--vp-c-brand-1);
  color: white;
  border-color: var(--vp-c-brand-1);
}

.vp-button--brand:hover {
  background: var(--vp-c-brand-2);
  color: white;
  border-color: var(--vp-c-brand-2);
}

.cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* ─── Override vp-doc reset for our sections ──────────────────────────── */
:deep(.vp-doc.container) {
  padding-bottom: 0;
}
</style>

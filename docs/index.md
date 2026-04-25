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
  - icon: 🍏
    title: Verify Apple in one call
    details: POST a transactionId, get a verified payload. SDK-backed JWS verification with pinned roots, OCSP, and sandbox auto-detection.
  - icon: 🤖
    title: Verify Google in one call
    details: Subscriptions and one-shots via the Play Developer API. OAuth + caching handled. Returns the raw response so your backend keeps full fidelity.
  - icon: 📨
    title: Webhooks done right
    details: Apple S2S V2 + Google Pub/Sub RTDN ingested, deduplicated, then forwarded to your callback with HMAC signatures and exponential-backoff retry.
  - icon: 🛡️
    title: Per-tenant isolation
    details: Apple keys, Google service accounts, and webhook secrets encrypted at rest with AES-256-GCM and HKDF-derived per-context subkeys. One tenant's compromise doesn't widen the blast radius.
---

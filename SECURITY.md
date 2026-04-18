# Security Policy

## Reporting a vulnerability

Please do **not** file security issues as public GitHub issues.

Email: **security@nossdev.example** _(replace with real address before v0.1.0)_

Include:

- A description of the issue
- Steps to reproduce (or a proof of concept)
- The affected version/commit
- Any known mitigations

We aim to acknowledge within 72 hours and provide a timeline within 7 days.

## Supported versions

Attesto is pre-release. Only the `main` branch receives security fixes.

## Security model

Attesto handles sensitive credentials: Apple `.p8` signing keys, Google service-account JSONs, tenant API keys, webhook HMAC secrets. Our commitments:

- All per-tenant credentials are **encrypted at rest** with AES-256-GCM, using a master key from `ATTESTO_ENCRYPTION_KEY` and a per-column HKDF-derived subkey.
- API keys are stored as **SHA-256 hashes**. The raw key is shown only at creation.
- Inbound webhooks verify publisher signatures (Apple JWS, Google OIDC JWT on Pub/Sub push).
- Outbound webhooks are signed with HMAC-SHA256 and a timestamp to prevent replay.
- Structured logs **never** include `.p8` contents, service-account JSONs, API keys, or webhook secrets.
- Failures to verify signatures or decrypt credentials always **fail closed**.

## Out of scope (for this project)

- Entitlement decisions and business logic are the client's responsibility.
- Attesto will not attempt to detect fraud beyond cryptographic signature verification.

See `PLAN.md` §6 for the complete security specification.

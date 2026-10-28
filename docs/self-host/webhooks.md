# Webhooks (operator setup)

> **Operator-side configuration.** This page covers wiring Apple S2S V2 and
> Google Pub/Sub RTDN into Attesto's inbound endpoints, plus configuring
> per-tenant outbound callback URLs. If you're an integrator receiving events
> from Attesto, see the [Webhooks reference](/reference/webhooks) for the
> outbound delivery format and signature verification, plus the
> [backend recipes](/recipes/) for per-language receiver implementations.

Webhooks are a **two-hop pipeline**:

1. **Inbound** — Apple / Google POST to Attesto's public webhook URL. Attesto
   verifies the cryptographic origin, decodes, deduplicates, and persists.
2. **Outbound** — Attesto POSTs an HMAC-signed delivery to the tenant's callback
   URL. Non-2xx responses trigger exponential-backoff retry.

```
Apple S2S V2          Google Pub/Sub RTDN
       │                       │
       │ JWS-signed            │ OIDC JWT bearer + base64 envelope
       ▼                       ▼
       /v1/webhooks/apple/:tid  /v1/webhooks/google/:tid
                  │
                  ▼
           Attesto verifies signature/JWT → persists → enqueues
                  │
                  ▼
           Attesto signs (HMAC) → POSTs the tenant's callback URL
                  │
                  ▼ retry on non-2xx: [30s, 2m, 10m, 1h, 6h]
              TENANT'S BACKEND
```

## Configure a tenant's callback

Before Apple or Google can push events to Attesto, the tenant needs a callback
URL configured:

```bash
mise run cli -- webhook:set-config tenant_01HXY... \
  --callback-url https://their-backend.example.com/attesto-webhook \
  --secret "$(openssl rand -base64 32)"
```

For self-hosted Docker:

```bash
docker compose exec attesto attesto webhook:set-config tenant_01HXY... \
  --callback-url https://… \
  --secret "$(openssl rand -base64 32)"
```

For Fly.io — SSH into the app and run `attesto` directly:

```bash
fly ssh console -a attesto
# (interactive shell)
attesto webhook:set-config tenant_01HXY... \
  --callback-url https://… \
  --secret "$(openssl rand -base64 32)"
```

See
[Deployment § Running admin commands on Fly](./deployment#running-admin-commands-on-fly)
for the full pattern (including the `-C` non-interactive form for scripts).

### Options

| Flag             | Meaning                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| _(positional)_   | Tenant ID — required                                                                                                                    |
| `--callback-url` | Tenant's backend webhook receiver. Must be `https://` in production (basic SSRF guard rejects private/link-local/cloud-metadata hosts). |
| `--secret`       | At least 32 characters, high-entropy. Use `openssl rand -base64 32`.                                                                    |

::: warning Save the secret — you'll need to share it

The secret is encrypted at rest in `webhook_configs` and shown only at config
time (Attesto won't echo it back). Save it; the tenant needs it to verify
Attesto's outbound HMAC signatures on their end.

:::

## Register inbound URLs with Apple

In [App Store Connect](https://appstoreconnect.apple.com):

1. **Your app → App Store Server Notifications**
2. Set both **Production Server URL** and **Sandbox Server URL** to:

   ```
   https://attesto.yourdomain.com/v1/webhooks/apple/<tenant_id>
   ```

   Apple sends to whichever URL matches the environment of the transaction;
   pointing both at the same path is fine — Attesto auto-detects via the JWS
   payload's `environment` claim.

3. **Version** — set to **Version 2** (V1 is deprecated and not supported)

Apple will start sending notifications immediately for events on that app:
renewals, refunds, billing retries, plan changes, etc.

### Test it

App Store Connect has a **Request a Test Notification** button (right next to
the URL fields). Click it; you should see a `200 OK` come back from Attesto, and
the tenant's callback URL should receive the event within seconds.

## Register inbound URLs with Google

Google's flow involves Pub/Sub, which is the trickiest setup in all of Attesto.

### One-time GCP setup

Pub/Sub has to be enabled on the project before any of this works. The Cloud
Console enables it for you the first time you open the Pub/Sub section, so
clicking through never hits this — but `gcloud` does not, and a topic name
Attesto has already stored is not proof the topic exists:

```bash
gcloud services enable pubsub.googleapis.com
```

1. **Google Cloud Console → Pub/Sub → Topics → Create topic**
   - Topic ID: e.g. `attesto-notifications`
   - Default settings otherwise
2. **Still on the topic → Permissions → Add principal** — grant **Pub/Sub
   Publisher** (`roles/pubsub.publisher`) to both of the following. Do it at
   topic level, not project-wide:
   - `google-play-developer-notifications@system.gserviceaccount.com` — Google
     Play's notification service agent. Play Console validates this grant when
     you paste the topic name below, and rejects the topic outright without it.
   - The service account from [Google setup](./google-setup) (e.g.
     `attesto-prod@<project>.iam.gserviceaccount.com`) — needed only for
     `webhook:probe`, which publishes a synthetic notification to this topic
     from Attesto. Verification and live inbound delivery don't use it.

   Neither of these is the Play Console permission grant from
   [Google setup](./google-setup): that one authorizes Play **API** calls, these
   authorize **Pub/Sub** publishing. The two fail at different moments — see the
   warning after the test notification below.
3. **Click the topic → Subscriptions → Create subscription**
   - Subscription ID: e.g. `attesto-notifications-push`
   - **Delivery type**: Push
   - **Endpoint URL**:
     `https://attesto.yourdomain.com/v1/webhooks/google/<tenant_id>`
   - **Authentication**: enable. Choose the same service account you set up in
     [Google setup](./google-setup) — Google will sign Pub/Sub pushes with this
     service account's credentials.
   - **Audience**: paste the same endpoint URL. This is the value you should
     also set as `--pubsub-audience` in `google:set-credentials`.
   - **Acknowledgement deadline**: 60 seconds (default)
   - **Retry policy**: Exponential backoff (default)

### Wire the topic to the app

4. In [Play Console](https://play.google.com/console) → the app → **Monetize →
   Monetization setup → Real-time developer notifications**
5. Paste the Pub/Sub topic name in the format:
   ```
   projects/<gcp-project>/topics/attesto-notifications
   ```
6. Click **Send test notification**

You should see the test event arrive at the tenant's callback URL within a few
seconds (Pub/Sub adds some latency vs Apple's direct POST).

::: warning A test notification does not exercise your Play API access

Attesto deliberately skips the Play Developer API for `test`, one-time product
and voided notifications, to avoid spending quota on events that can't benefit
from it. So a test event that arrives successfully proves the Pub/Sub path —
topic, subscription, audience — and says nothing about whether the service
account's Play Console app permissions are right. That grant is first exercised
by a real `subscriptionNotification`, or by a `/v1/google/verify` call with a
real purchase token.

:::

## Origin authentication (cryptographic)

Attesto verifies both inbound webhook origins before persisting anything.

### Apple

The `signedPayload` JWS is validated against Apple's pinned root CAs (Apple Inc.
Root + G2 + G3, bundled with the binary) via
[`@apple/app-store-server-library`'s `SignedDataVerifier`](https://github.com/apple/app-store-server-library-node).
In production, OCSP revocation checks run against Apple's responder.

A tampered or forged payload is rejected with `401 SIGNATURE_INVALID` **before
Attesto touches the database**. Verification requires the tenant to have Apple
credentials configured (`apple:set-credentials`) — the `bundleId` from those
credentials is checked against the JWS so one tenant's creds can't authenticate
another tenant's webhooks.

### Google

The `Authorization: Bearer <oidc-jwt>` header is verified against Google's JWKS
(fetched from `oauth2.googleapis.com/oauth2/v3/certs`, cached for 1 hour).

- `iss` must be `accounts.google.com`
- `exp` must be in the future (with 60s skew tolerance)
- If the tenant configured `pubsub_audience` via `google:set-credentials`, `aud`
  must match it exactly

::: tip Always set `pubsub_audience`

Without an audience binding, Attesto accepts **any** Google-signed JWT — meaning
any Google service account anywhere could in principle reach a tenant's webhook
endpoint with valid-looking authentication. Setting `pubsub_audience` to the
callback URL closes this loophole.

:::

## What's next

- [Operations](./operations) — monitoring webhook delivery health
- [Troubleshooting](./troubleshooting) — common webhook failure modes
- [Maintenance](./maintenance) — webhook secret rotation and retention
- [Webhooks reference](/reference/webhooks) — the outbound delivery format your
  tenants will receive

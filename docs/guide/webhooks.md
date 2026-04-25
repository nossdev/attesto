# Webhooks

Webhooks are a **two-hop pipeline**:

1. **Inbound** — Apple / Google POST to Attesto's public webhook URL.
   Attesto verifies the cryptographic origin, decodes, deduplicates, and
   persists.
2. **Outbound** — Attesto POSTs an HMAC-signed delivery to your callback
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
           Attesto signs (HMAC) → POSTs your callback URL
                  │
                  ▼ retry on non-2xx: [30s, 2m, 10m, 1h, 6h]
              YOUR BACKEND
```

## Configure your callback

Before Apple or Google can push events to Attesto, you need a callback URL
configured for the tenant:

```bash
mise run cli -- webhook:set-config tenant_01HXY... \
  --callback-url https://your-backend.example.com/attesto-webhook \
  --secret "$(openssl rand -base64 32)"
```

For self-hosted Docker:

```bash
docker compose exec attesto attesto webhook:set-config tenant_01HXY... \
  --callback-url https://… \
  --secret "$(openssl rand -base64 32)"
```

### Options

| Flag | Meaning |
|---|---|
| _(positional)_ | Tenant ID — required |
| `--callback-url` | Your backend's webhook receiver. Must be `https://` in production (basic SSRF guard rejects private/link-local/cloud-metadata hosts). |
| `--secret` | At least 32 characters, high-entropy. Use `openssl rand -base64 32`. |

::: warning Save the secret on your end
The secret is encrypted at rest in `webhook_configs` and shown only at
config time (Attesto won't echo it back). Save it on your backend too —
you'll use it to verify Attesto's outbound HMAC.
:::

## Register inbound URLs with Apple

In [App Store Connect](https://appstoreconnect.apple.com):

1. **Your app → App Store Server Notifications**
2. Set both **Production Server URL** and **Sandbox Server URL** to:

   ```
   https://attesto.yourdomain.com/v1/webhooks/apple/<tenant_id>
   ```

   Apple sends to whichever URL matches the environment of the
   transaction; pointing both at the same path is fine — Attesto auto-
   detects via the JWS payload's `environment` claim.

3. **Version** — set to **Version 2** (V1 is deprecated and not supported)

Apple will start sending notifications immediately for events on that
app: renewals, refunds, billing retries, plan changes, etc.

### Test it

App Store Connect has a **Request a Test Notification** button (right
next to the URL fields). Click it; you should see a `200 OK` come back
from Attesto, and your callback URL should receive the event within
seconds.

## Register inbound URLs with Google

Google's flow involves Pub/Sub, which is the trickiest setup in all of
Attesto.

### One-time GCP setup

1. **Google Cloud Console → Pub/Sub → Topics → Create topic**
   - Topic ID: e.g. `attesto-notifications`
   - Default settings otherwise
2. **Click the topic → Subscriptions → Create subscription**
   - Subscription ID: e.g. `attesto-notifications-push`
   - **Delivery type**: Push
   - **Endpoint URL**: `https://attesto.yourdomain.com/v1/webhooks/google/<tenant_id>`
   - **Authentication**: enable. Choose the same service account you set
     up in [Google setup](./google-setup) — Google will sign Pub/Sub
     pushes with this service account's credentials.
   - **Audience**: paste the same endpoint URL. This is the value you
     should also set as `--pubsub-audience` in `google:set-credentials`.
   - **Acknowledgement deadline**: 60 seconds (default)
   - **Retry policy**: Exponential backoff (default)

### Wire the topic to your app

3. In [Play Console](https://play.google.com/console) → your app →
   **Monetize → Monetization setup → Real-time developer notifications**
4. Paste the Pub/Sub topic name in the format:
   ```
   projects/<gcp-project>/topics/attesto-notifications
   ```
5. Click **Send test notification**

You should see the test event arrive at your callback URL within a few
seconds (Pub/Sub adds some latency vs Apple's direct POST).

## Outbound delivery format

Attesto POSTs to your callback URL with these headers:

| Header | Example | Meaning |
|---|---|---|
| `X-Attesto-Event` | `apple.did_renew.auto_renew_enabled` | Normalized event type |
| `X-Attesto-Event-Id` | `evt_01HX...` | Attesto-internal event ULID |
| `X-Attesto-Timestamp` | `1744464130` | Unix seconds at sign time |
| `X-Attesto-Signature` | `t=1744464130,v1=<hex-hmac-sha256>` | Signature over `<ts>.<body>` |

Body (JSON):

```json
{
  "event": "apple.did_renew.auto_renew_enabled",
  "eventId": "evt_01HX...",
  "externalId": "<apple notificationUUID or google messageId>",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "tenantId": "tenant_01HX...",
  "source": "apple",
  "data": { /* normalized event payload */ },
  "raw": { /* original decoded payload from Apple/Google */ }
}
```

The `data` field is the cleaned-up payload Attesto recommends consuming.
The `raw` field is the original decoded JWS / Pub/Sub envelope, included
so power users can read fields Attesto doesn't surface in `data`.

## Verify the signature

**Always verify the signature.** Attesto's outbound delivery is
authenticated only by HMAC; an unauthenticated callback endpoint would be
spoofable by anyone who guessed the URL.

### JavaScript / Node.js

```typescript
import crypto from "node:crypto";

function verifyAttestoSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(ts) || !sig) return false;

  // Reject anything older than 5 minutes (replay guard)
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(sig),
  );
}
```

### Python

```python
import hmac
import hashlib
import time

def verify_attesto_signature(body_bytes: bytes, header: str | None, secret: str) -> bool:
    if not header:
        return False
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
        sig = parts["v1"]
    except (KeyError, ValueError):
        return False

    # Replay guard: 5-minute window
    if abs(time.time() - ts) > 300:
        return False

    expected = hmac.new(
        secret.encode(),
        f"{ts}.{body_bytes.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)
```

### Go

```go
package webhook

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "strconv"
    "strings"
    "time"
)

func VerifyAttestoSignature(body []byte, header, secret string) bool {
    if header == "" {
        return false
    }
    parts := map[string]string{}
    for _, p := range strings.Split(header, ",") {
        kv := strings.SplitN(p, "=", 2)
        if len(kv) == 2 {
            parts[kv[0]] = kv[1]
        }
    }
    tsRaw, sig := parts["t"], parts["v1"]
    ts, err := strconv.ParseInt(tsRaw, 10, 64)
    if err != nil || sig == "" {
        return false
    }

    // Replay guard: 5-minute window
    if abs64(time.Now().Unix()-ts) > 300 {
        return false
    }

    mac := hmac.New(sha256.New, []byte(secret))
    fmt.Fprintf(mac, "%d.%s", ts, body)
    expected := hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(sig))
}

func abs64(n int64) int64 {
    if n < 0 {
        return -n
    }
    return n
}
```

::: tip Use the raw request body
The signature is computed over the **exact bytes** Attesto sent, not over
a re-serialized parsed-then-stringified version. If your framework parses
JSON automatically, capture the raw body bytes _before_ parsing.
:::

## Retry schedule

If your callback returns anything non-2xx (or doesn't respond within 10
seconds), Attesto retries with this schedule:

| Attempt | Delay since previous | Cumulative |
|---|---|---|
| 1 | immediate | 0 |
| 2 | 30 seconds | 30s |
| 3 | 2 minutes | 2m30s |
| 4 | 10 minutes | 12m30s |
| 5 | 1 hour | 1h12m |
| 6 | 6 hours | 7h12m |

After 6 failed attempts (~7h12m), Attesto marks the delivery `failed`
and stops retrying. The underlying `webhook_events` row is preserved
indefinitely (or until you implement a retention policy — see
[Maintenance](./maintenance)).

Manual replay of a failed delivery isn't supported in v0.1.0. If you need
to replay, query `webhook_events` directly and emit a new delivery row
via SQL.

## Idempotency

Attesto dedupes inbound events:

- **Apple** — on `notificationUUID` (every Apple S2S V2 event has one)
- **Google** — on Pub/Sub `messageId`

If Apple or Google retries because Attesto returned 5xx (or a network
hiccup ate the response), you receive **exactly one** outbound delivery
per underlying event.

Your callback should also be idempotent on `X-Attesto-Event-Id`. A
delivery may be retried multiple times if your callback returns 5xx on
attempt 1 but the side effect (e.g. updating a subscription state) had
already happened. Treat the same `eventId` as the same logical operation.

## Origin authentication (cryptographic)

Attesto verifies both inbound webhook origins:

### Apple

The `signedPayload` JWS is validated against Apple's pinned root CAs
(Apple Inc. Root + G2 + G3, bundled with the binary) via
[`@apple/app-store-server-library`'s `SignedDataVerifier`](https://github.com/apple/app-store-server-library-node).
In production, OCSP revocation checks run against Apple's responder.

A tampered or forged payload is rejected with `401 SIGNATURE_INVALID`
**before Attesto touches the database**. Verification requires the tenant
to have Apple credentials configured (`apple:set-credentials`) — the
`bundleId` from those credentials is checked against the JWS so one
tenant's creds can't authenticate another tenant's webhooks.

### Google

The `Authorization: Bearer <oidc-jwt>` header is verified against
Google's JWKS (fetched from `oauth2.googleapis.com/oauth2/v3/certs`,
cached for 1 hour).

- `iss` must be `accounts.google.com`
- `exp` must be in the future (with 60s skew tolerance)
- If the tenant configured `pubsub_audience` via
  `google:set-credentials`, `aud` must match it exactly

::: tip Always set `pubsub_audience`
Without an audience binding, Attesto accepts **any** Google-signed JWT —
meaning any Google service account anywhere could in principle reach
your tenant's webhook endpoint with valid-looking authentication. Setting
`pubsub_audience` to your callback URL closes this loophole.
:::

## What's next

- [Operations](./operations) — monitoring webhook delivery health
- [Troubleshooting](./troubleshooting) — common webhook failure modes
- [API reference](/reference/api) — endpoint specifics

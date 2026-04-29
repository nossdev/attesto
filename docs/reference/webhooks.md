# Webhooks

Reference for the outbound webhook delivery Attesto sends to your callback URL.
For receiver implementations, see the [backend recipes](/recipes/) — every
recipe (Deno, Node, Python, Java, Ruby) includes a working webhook receiver with
HMAC verification, replay-window guard, and idempotency notes.

## Outbound delivery format

Headers Attesto sets on every delivery:

| Header                | Example                              | Meaning                      |
| --------------------- | ------------------------------------ | ---------------------------- |
| `X-Attesto-Event`     | `apple.did_renew.auto_renew_enabled` | Normalized event type        |
| `X-Attesto-Event-Id`  | `evt_01HX...`                        | Attesto-internal event ULID  |
| `X-Attesto-Timestamp` | `1744464130`                         | Unix seconds at sign time    |
| `X-Attesto-Signature` | `t=1744464130,v1=<hex-hmac-sha256>`  | Signature over `<ts>.<body>` |

Body (JSON):

```json
{
  "event": "apple.did_renew.auto_renew_enabled",
  "eventId": "evt_01HX...",
  "externalId": "<apple notificationUUID or google messageId>",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "tenantId": "tenant_01HX...",
  "source": "apple",
  "data": {/* normalized event payload */},
  "raw": {/* original decoded payload from Apple/Google */}
}
```

The `data` field is the cleaned-up payload Attesto recommends consuming. The
`raw` field is the original decoded JWS / Pub/Sub envelope, included so power
users can read fields Attesto doesn't surface in `data`.

## Signature verification

The `X-Attesto-Signature` header has format
`t=<unix_seconds>,v1=<hex_hmac_sha256>`. The HMAC is computed over
`${t}.${rawBody}` with your tenant's webhook secret as the key. To verify:

1. Parse `t` and `v1` from the header.
2. Reject if `|now - t| > 300` (5-minute replay window).
3. Compute `HMAC-SHA256(secret, "${t}.${rawBody}")` over the **raw bytes**
   Attesto sent (not a JSON-parsed-then-restringified version).
4. Compare with `v1` in constant time (`crypto.timingSafeEqual` /
   `hmac.compare_digest` / `MessageDigest.isEqual` / `OpenSSL` constant-time
   helpers).

Working implementations in 5 languages: see the [backend recipes](/recipes/).

## Retry schedule

If your callback returns anything non-2xx (or doesn't respond within 10
seconds), Attesto retries with this schedule:

| Attempt | Delay since previous | Cumulative |
| ------- | -------------------- | ---------- |
| 1       | immediate            | 0          |
| 2       | 30 seconds           | 30s        |
| 3       | 2 minutes            | 2m30s      |
| 4       | 10 minutes           | 12m30s     |
| 5       | 1 hour               | 1h12m      |
| 6       | 6 hours              | 7h12m      |

After 6 failed attempts (~7h12m), Attesto marks the delivery `failed` and stops
retrying.

## Idempotency

Attesto dedupes inbound events on the upstream's idempotency key (Apple's
`notificationUUID`, Google's Pub/Sub `messageId`), so each underlying upstream
event produces **exactly one** logical delivery from Attesto.

Your callback should also be idempotent on `X-Attesto-Event-Id`. A delivery may
be retried multiple times if your callback returned 5xx on attempt 1 but the
side effect (e.g. updating a subscription state) had already happened. Treat the
same `eventId` as the same logical operation — persist it in a
`processed_events(event_id text primary key, processed_at timestamptz)` table on
your side and check before doing anything destructive.

## Event types

Attesto normalizes upstream events into a stable vocabulary. The `event` header
/ body field uses this format:

```
<source>.<canonical-event-name>
```

Common values:

- `apple.did_renew` — subscription renewed
- `apple.did_fail_to_renew` — billing retry started
- `apple.refund` — transaction refunded by Apple
- `apple.did_change_renewal_status` — auto-renew toggled
- `google.subscription.renewed` — subscription renewed
- `google.subscription.cancelled` — auto-renew cancelled
- `google.subscription.recovered` — recovered from grace period
- `google.product.purchased` — one-shot product confirmed

The complete vocabulary tracks Apple's `notificationType` + `subtype` and
Google's `subscriptionNotification.notificationType` +
`oneTimeProductNotification.notificationType`. The full mapping lives in the
source — see
[`app/services/webhooks/normalize.ts`](https://github.com/nossdev/attesto/blob/main/app/services/webhooks/normalize.ts).

## See also

- [Backend recipes](/recipes/) — runnable receiver implementations
- [Integration guide § Receive webhooks](/guide/integration#step-4-receive-webhooks)
  — narrative integration walkthrough
- [API reference](/reference/api) — verify endpoint specifications
- [Self-host webhooks setup](/self-host/webhooks) — operator-side: registering
  Apple S2S / Google Pub/Sub URLs

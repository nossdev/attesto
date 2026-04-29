# Quickstart

> **For backend developers integrating with the hosted Attesto.** If you're
> running your own Attesto instance, see the
> [self-host quickstart](/self-host/quickstart) instead.

You're 5 minutes away from a verified transaction. The hosted Attesto runs at
`https://api.attesto.nossdev.com` — request a key, hit the API, integrate.

## 1. Get your tenant credentials

Email **nossteam@nossdev.com** with:

- Your app's bundle ID (Apple) and/or package name (Google)
- Whether you need a webhook callback URL (most teams do — for renewals,
  refunds, RTDN events)
- The environments you need (typically `production` + a `staging` tenant for
  testing)

You'll get back **one set of credentials per environment** — typically a staging
set for development and a production set for launch:

| Item                     | Staging                                   | Production                        |
| ------------------------ | ----------------------------------------- | --------------------------------- |
| **Base URL**             | `https://api-staging.attesto.nossdev.com` | `https://api.attesto.nossdev.com` |
| **API key**              | `attesto_test_…`                          | `attesto_live_…`                  |
| **Webhook secret**       | _staging-only base64 string_              | _prod-only base64 string_         |
| **Webhook callback URL** | YOUR staging receiver                     | YOUR prod receiver                |

The two sets are completely isolated — different hosts, different keys,
different webhook secrets, different Apple environment (sandbox vs production).
**Wire them into separate environment-variable sets in your backend**; never let
staging credentials reach prod or vice versa. Apple sandbox transactions that
fail to verify on prod will return `TRANSACTION_NOT_FOUND` (and vice versa),
which is the loud signal that a key is in the wrong place.

We also handle Apple `.p8` key and Google service-account installation as part
of onboarding — you don't upload anything to our dashboard yourself.

::: tip Develop on staging first

Build and test your verify + webhook receiver against the staging set. Use
sandbox testers in TestFlight / sandbox purchase tokens on Android to drive real
transaction flows. Only swap to the production base URL + key after your
receiver is signed-off and idempotent.

:::

::: danger Treat the API key like a database password

Store it in your secret manager (1Password, AWS Secrets Manager, Doppler, etc.)
and inject as an environment variable. **Never** commit it, log it, or send it
to clients.

:::

## 2. Verify your first transaction

```bash
curl -X POST https://api.attesto.nossdev.com/v1/apple/verify \
  -H "Authorization: Bearer attesto_live_…" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

A real transaction returns:

```json
{
  "valid": true,
  "environment": "production",
  "transaction": {
    "transactionId": "2000000123456789",
    "originalTransactionId": "2000000000123456",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "expiresDate": "2026-05-30T14:22:10.000Z",
    "rawDecodedPayload": { "...": "..." }
  }
}
```

A non-existent transaction returns `200` with `valid: false` and
`error: "TRANSACTION_NOT_FOUND"` — that's a domain answer, not an error to
retry. See [Error codes](/reference/error-codes) for the full list.

Google verification is the same shape with a different request body — see the
[API reference](/reference/api).

## 3. Wire it into your backend

Three options depending on your stack:

- **Capacitor mobile app:** use [`@nossdev/iap`](https://iap.nossdev.com) on the
  client and pick a [backend recipe](/recipes/) — Deno, Node, Python, Java, or
  Ruby. The recipes are runnable skeletons that implement the five endpoints
  `@nossdev/iap` calls.
- **Other clients (native iOS/Android/web):** read the
  [Integration guide](./integration) — full TypeScript / Python / Go examples
  for verify calls, error handling, and the production checklist.
- **Webhooks:** if your tenant has a callback URL, see
  [Webhooks reference](/reference/webhooks) for HMAC verification and the event
  vocabulary.

## 4. What to monitor

- **Successful verifies** — count of `200 + valid: true` per minute
- **Domain failures** — `200 + valid: false` (mostly `TRANSACTION_NOT_FOUND`); a
  sudden spike usually means client-side fraud attempts or an iOS app that's
  sending fake IDs
- **Transport errors** — `4xx` / `5xx` rates; alert if `5xx > 1%` sustained
- **Webhook delivery** — if you use webhooks, alert on consecutive 5xx returns
  from your receiver (Attesto retries with `30s, 2m, 10m, 1h, 6h` backoff and
  gives up after the last attempt)

## Next steps

- [Integration guide](./integration) — production patterns: retry policy,
  caching, idempotency, the production checklist
- [Webhooks reference](/reference/webhooks) — outbound delivery format, retry
  schedule, and idempotency rules
- [Architecture](./architecture) — what Attesto does and doesn't do, why it's
  thin by design
- [Backend recipes](/recipes/) — runnable skeletons for `@nossdev/iap`
  integrations

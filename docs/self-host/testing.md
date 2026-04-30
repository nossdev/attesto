# Testing

Attesto's test suite is two-tier:

- **Unit tests** — fast, no external dependencies, no DB. Run anywhere.
- **Integration tests** — real Postgres, real migrations. Auto-skip when
  `DATABASE_URL` is unset, so the unit run stays portable.

Plus a separate concept — **sandbox testing against real Apple/Google** — which
isn't part of `deno test` but is what you'll do to confirm end-to-end before
your first release.

## Run the test suite

```bash
mise run test
```

Output (truncated):

```
Check file:///…/app.ts
Check file:///…/middleware/auth.ts
…

running 6 tests from ./tests/integration/auth.test.ts
auth: missing Bearer header → 401 ... ok (12ms)
auth: malformed Bearer → 401 ... ok (8ms)
auth: unknown key → 401 ... ok (7ms)
…

running 14 tests from ./tests/unit/webhook-signature.test.ts
verifyWebhookSignature: roundtrip ... ok (1ms)
…

ok | 151 passed | 0 failed | 78 ignored (15s)
```

The `78 ignored` are integration tests that auto-skip without `DATABASE_URL`.
Add the env var (via `.mise.local.toml`) and they run too:

```toml
[env]
DATABASE_URL = "postgres://attesto:attesto@localhost:5432/attesto"
```

Then:

```bash
mise run db:up && mise run db:migrate && mise run test
# → 232 passed | 0 failed
```

## Test layout

```
tests/
├── unit/                     151 tests — pure logic, no I/O
│   ├── api-keys.test.ts
│   ├── apple-jwt-signer.test.ts
│   ├── encryption.test.ts
│   ├── google-oauth.test.ts
│   ├── google-oidc-verifier.test.ts
│   ├── rate-limit.test.ts
│   ├── validation-audit.test.ts
│   ├── webhook-signature.test.ts
│   └── … 30+ more
└── integration/              78 tests — real Postgres
    ├── _helpers.ts           shared ensureMigrated() + freshDb()
    ├── apple-verify.test.ts
    ├── auth.test.ts
    ├── cli-admin.test.ts
    ├── google-verify.test.ts
    └── webhooks.test.ts
```

### Unit test conventions

- One file per module under test
- No DB, no network, no filesystem (beyond reading test fixtures)
- Stub external dependencies via dependency injection (the codebase uses factory
  functions — `createAppleHttpClient`, `createGoogleClient`, etc. — specifically
  to support this)
- Fast (whole unit suite runs in <2 seconds)

### Integration test conventions

- Always guard the `Deno.test` call with `ignore: !Deno.env.get("DATABASE_URL")`
- Use `freshDb()` from `_helpers.ts` to start each test with a clean schema
  state (it truncates relevant tables, not migrations)
- Use mocked Apple/Google clients — these tests verify Attesto's orchestration
  logic, not Apple's/Google's APIs
- Targets: end-to-end flows like "create tenant → mint key → verify with fake
  upstream → confirm response shape"

## Writing tests

Attesto follows a TDD-friendly structure: every service has an interface plus
factory function so the implementation can be swapped in tests.

Example pattern from `app/services/apple/verify.ts`:

```typescript
export interface VerifyAppleDeps {
  credentialsLoader: AppleCredentialsLoader;
  clientFactory: (creds: AppleCredentialMaterial) => AppleClient;
}

export async function verifyAppleTransaction(
  deps: VerifyAppleDeps,
  input: { tenantId: string; transactionId: string; … },
): Promise<AppleVerifyResult> { … }
```

Tests pass stub `deps`:

```typescript
import { assertEquals } from "@std/assert";
import { verifyAppleTransaction } from "@/services/apple/verify.ts";

Deno.test("verifyAppleTransaction: returns valid:false on bundle mismatch", async () => {
  const result = await verifyAppleTransaction(
    {
      credentialsLoader: { load: () => stubCreds("com.example.app") },
      clientFactory: () => ({
        getTransaction: () => stubResponse({ bundleId: "com.OTHER.app" }),
      }),
    },
    { tenantId: "tenant_…", transactionId: "2000…" },
  );
  assertEquals(result, { valid: false, error: "BUNDLE_ID_MISMATCH" });
});
```

This pattern means **adding a test for a new code path takes 5 minutes**, not
"set up Postgres and Apple sandbox first."

## Running specific tests

Deno's test runner has standard filters:

```bash
# Single file
deno test --allow-net --allow-env --allow-read app/services/apple/verify.test.ts

# Tests matching a pattern
deno test --filter "BUNDLE_ID_MISMATCH"

# Verbose output
deno test --verbose
```

Or via mise (which adds the necessary perms):

```bash
mise run test -- --filter "rate-limit"
```

## Coverage

```bash
deno task test:cov
```

Runs the test suite with coverage instrumentation, then prints a per-file
report:

```
file://…/app/services/apple/verify.ts | 87.5% | 14/16
file://…/app/services/google/oauth.ts | 92.3% | 24/26
file://…/app/middleware/rate-limit.ts | 100.0% | 18/18
…
```

Target: **80% coverage on new code**. CI doesn't enforce this yet, but the
convention is "if you change `app/foo.ts`, the corresponding test file should
cover the new behavior."

## Lint, format, typecheck

The full local-CI loop:

```bash
mise run lint
```

This runs:

1. `deno lint` — finds suspicious patterns
2. `deno fmt --check` — fails if anything isn't formatted (run `deno fmt` to
   fix)
3. `deno check app/main.ts` — full type-check across all imports

CI runs the same checks on every push. Keep them green locally before
committing.

## Testing against real Apple sandbox

This is **not part of `deno test`** — it's a manual confirmation flow you run
before tagging a release.

### Prerequisites

- A tenant with Apple credentials configured (see [Apple setup](./apple-setup))
- A real `transactionId` from a sandbox purchase

### The smoke test

```bash
ATTESTO_KEY="attesto_test_…"

# Should return valid: true
curl -X POST http://localhost:8080/v1/apple/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -d '{"transactionId":"2000000123456789"}' | jq

# Should return valid: false / TRANSACTION_NOT_FOUND
curl -X POST http://localhost:8080/v1/apple/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -d '{"transactionId":"0000000000000000"}' | jq
```

### Edge cases worth manually exercising

- **Expired subscription** — refund or let a sandbox sub lapse, then verify
- **Revoked transaction** — refund via App Store Connect Sandbox tab
- **Family-shared transaction** — `inAppOwnershipType: "FAMILY_SHARED"`
- **Bundle mismatch** — try verifying a transaction from a different app (should
  return `BUNDLE_ID_MISMATCH`)
- **Wrong env** — set `--environment production` against a sandbox txn (should
  return `TRANSACTION_NOT_FOUND` — production API doesn't see sandbox txns)

## Testing against real Google Play

Similar manual flow:

```bash
curl -X POST http://localhost:8080/v1/google/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -d '{
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "<from-the-billing-library>",
    "type": "subscription"
  }' | jq
```

### Edge cases

- **Cancelled subscription** — verify after cancellation; should still succeed
  but `autoRenewing: false`
- **Consumed product** — Google returns `410 Gone` → `PURCHASE_NOT_FOUND` with
  the message clarifying it was consumed
- **Wrong package** — try with a different `packageName` than the tenant is
  configured for (should return `PACKAGE_NAME_MISMATCH`)
- **Multi-line-item subscription** — confirm the envelope reflects only line
  item 0, and `rawResponse.lineItems` has all items

## Testing webhooks

### Apple inbound

App Store Connect → your app → App Store Server Notifications → click **Request
a Test Notification**. Your callback URL should receive a HMAC-signed delivery
within seconds. The event type will be `apple.test_notification`.

### Google inbound

Play Console → your app → Monetize → Real-time developer notifications → **Send
test notification**. Same expectation — your callback receives a delivery, event
type `google.test`.

### Outbound to your callback

If you don't have a real callback URL yet, point Attesto at
[https://webhook.site](https://webhook.site) for ad-hoc inspection:

```bash
mise run cli -- webhook:set-config tenant_… \
  --callback-url https://webhook.site/<unique-id> \
  --secret "$(openssl rand -base64 32)"
```

Trigger a test notification from Apple/Google and inspect the request that lands
at webhook.site. Verify the HMAC signature matches what your secret would
produce over `<ts>.<body>`.

## End-to-end testing flow (operator playbook)

> The canonical "is the integration actually working?" walkthrough. Goes layer
> by layer through the verify + webhook pipeline **on staging**, with the
> expectation, the mise task to verify each step, and the doc link for going
> deeper. Run this after onboarding a new tenant, after the integrator says
> "I've shipped my receiver", or whenever someone reports "webhooks aren't
> firing" — the failure mode shows you which component broke.

::: warning Always use staging for this playbook

Every command in this section assumes `--target staging` (the default). Don't
run probe tests, send fake purchases, or toggle webhook config against
production while the runbook is in your hands — even read-only inspection is
better practiced on staging first to build muscle memory.

:::

### The shape of the flow

```
INITIAL PURCHASE
─────────────────
[iOS / Android device]
        │  buys via sandbox tester / license tester
        ▼
[@nossdev/iap (or your client)]
        │  POSTs receipt to integrator's backend
        ▼
[Integrator backend]
        │  POST /v1/{apple,google}/verify
        ▼
[Attesto]
        │  signs JWT, calls upstream, verifies signed payloads,
        │  writes validation_audit row (if enabled)
        ▼
[Integrator backend]
        │  saves (platform, originalTransactionId|purchaseToken) → userId
        │  in their user_purchases / mapping table
        ▼
[App grants entitlement]


. . . later, on renewal / cancel / refund . . .


[Apple / Google]
        │  S2S V2 (Apple) or RTDN via Pub/Sub (Google)
        ▼
[Attesto]
        │  verifies JWS / OIDC, dedupes on notificationUUID / messageId,
        │  writes webhook_events row,
        │  enqueues webhook_deliveries row (status=pending)
        ▼
[Dispatcher]
        │  HMAC-signs body, POSTs to integrator's callback URL,
        │  records last_response_code / status (delivered | pending | failed)
        ▼
[Integrator's callback]
        │  verifies HMAC, dedupes on X-Attesto-Event-Id,
        │  looks up user via payload.subject.key,
        │  applies subscription state change
        ▼
[Updated user state in integrator's DB]
```

### Prerequisites

- Tenant onboarded on staging with Apple credentials, Google credentials, and
  webhook config — see [Onboarding](./onboarding) and
  [Staging tenant](./staging-tenant).
- A real iOS / Android device with a sandbox tester (Apple) or license tester
  (Google) account signed in.
- The integrator's staging backend is deployed and the callback URL configured
  in `webhook:set-config` is reachable from the public internet.
- `fly` CLI authenticated; `psql` installed locally for the DB-row inspections
  marked **§ DB query** below.
- The staging tenant ID handy. Get it: `mise run t:ls`.

---

### Step 1 — Initial purchase reaches the verify endpoint

**What happens:** mobile app → `@nossdev/iap` → integrator backend →
`POST /v1/apple/verify` (or `/google/verify`).

**Expected:**
`200 OK` with `valid: true` and the normalized transaction / purchase
payload. The integrator backend extracts the stable mapping key
(`originalTransactionId` for Apple, `purchaseToken` for Google) and stores
`(platform, key) → user_id` in their mapping table. The app gets entitlement.

**§ Verify on Attesto-side via logs:**

```bash
mise run t:logs tenant_<id>
```

Look for a line shape like:

```jsonc
{
  "level": "info",
  "msg": "request",
  "method": "POST",
  "path": "/v1/apple/verify",
  "status": 200,
  "durationMs": 237,
  "requestId": "req_01..."
}
```

`status:200` + `durationMs` in the 100–800ms range = healthy.

**§ Inspect validation_audit (only when `ENABLE_VALIDATION_AUDIT_LOG=true`):**

```bash
mise run t:audit tenant_<id> --limit 5
```

Output (one JSON object per row, most recent first):

```jsonc
{
  "id": "aud_01...",
  "source": "apple",
  "valid": true,
  "errorCode": null,
  "latencyMs": 237,
  "createdAt": "..."
}
```

Good rows: `valid=true`, `error_code=null`. If `valid=false`, `error_code`
names the domain failure (`TRANSACTION_NOT_FOUND`, `BUNDLE_ID_MISMATCH`,
etc.) — see [Error codes](../reference/error-codes).

**Common failures & where to look:**

| Symptom (in logs)                              | Likely cause                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status:401 UNAUTHENTICATED`                   | Wrong / revoked API key. Confirm integrator is using staging `attesto_test_…` not `attesto_live_…`   |
| `status:400 CREDENTIALS_MISSING`               | Apple / Google creds not configured. Run `mise run t:apple:get tenant_<id>` to confirm what's stored |
| `status:200 valid:false TRANSACTION_NOT_FOUND` | Sandbox `transactionId` was tried against production env, or vice versa                              |
| `status:200 valid:false BUNDLE_ID_MISMATCH`    | `mise run t:apple:get` shows a different `bundleId` than the txn carries                             |

**Deeper docs:**
[Verify endpoint spec](../reference/api#post-v1-apple-verify) ·
[Mapping pattern](../guide/integration#mapping-webhook-events-back-to-users) ·
[Error codes](../reference/error-codes)

---

### Step 2 — A webhook event fires

**Two flavors of "event":**

| Path                                             | What you get                                                                             | When to use                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Real event** (sandbox renewal, cancel, refund) | Full payload with `signedTransactionInfo` / `purchaseToken`. **`subject` is populated.** | Whenever you can tolerate the wait — exercises user-mapping. Apple sandbox subs renew on accelerated timers (1-month sub = 5 min). |
| **Probe** (synthetic TEST notification)          | Skeletal envelope, no transaction data. **`subject` is `null`.**                         | Smoke check — does the URL even work? Does NOT exercise user-mapping.                                                              |

**Trigger a probe right now:**

```bash
mise run t:apple:test tenant_<id> --env sandbox
```

(Or in App Store Connect: _Server Notifications → Request a Test Notification_.
Google equivalent in Play Console: _RTDN settings → Send test notification_.)

**Expected:** Attesto receives the inbound webhook within ~10s.

**§ Verify it arrived via logs:**

```bash
mise run t:logs tenant_<id>
```

Lines to look for:

```jsonc
// First — Attesto's diagnostic on the cert chain shape:
{"level":"info","msg":"apple_jws_x5c_observed","x5cLength":3,"modified":false,...}

// Then the request itself:
{"level":"info","msg":"request","method":"POST",
 "path":"/v1/webhooks/apple/tenant_<id>","status":200,"durationMs":78}
```

`status:200` = Attesto verified, deduped, persisted, enqueued. Anything else
means verification failed and the next step won't fire — see the failure
table below.

**§ Inspect webhook_events:**

```bash
mise run t:wh:events tenant_<id> --limit 5
```

Output (one JSON object per row, most recent first; pipe to `jq` for pretty-printing):

```jsonc
{
  "id": "evt_01...",
  "source": "apple",
  "eventType": "apple.did_renew.auto_renew_enabled",
  "externalId": "<notificationUUID>",
  "subject": {
    "key": "2000000123456789",
    "productId": "com.example.premium.monthly",
    "type": "subscription"
  },
  "receivedAt": "2026-04-30T08:23:16.156Z"
}
```

| Field        | Meaning                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType`  | Normalized name like `apple.did_renew.auto_renew_enabled` (real event) or `apple.test_notification` (probe). Vocabulary in [`app/services/webhooks/normalize.ts`](https://github.com/nossdev/attesto/blob/main/app/services/webhooks/normalize.ts). |
| `externalId` | Apple's `notificationUUID` / Google's Pub/Sub `messageId` — used for inbound idempotency.                                                                                                                                                           |
| `subject`    | Extracted server-side using the same logic that flows into the outbound payload. `null` for probe / refund / unrecognized notifications — see [`subject` reference](../reference/webhooks#subject).                                                 |
| `receivedAt` | When Attesto persisted it. Should be within seconds of when you triggered the event.                                                                                                                                                                |

**Common failures & where to look:**

| Symptom (in logs)                                           | Likely cause                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `status:401` + `apple_jws_verification_failed` warn line    | JWS verification failed. Check `sdkInnerStatus` — see [Troubleshooting](./troubleshooting) for the matrix |
| `status:404 TENANT_NOT_FOUND`                               | Tenant deactivated, or path tenant ID doesn't exist                                                       |
| No log entry for `/v1/webhooks/...`                         | Apple/Google never sent the webhook. Confirm the URL is set correctly: `mise run t:wh:get tenant_<id>`    |
| `apple_jws_x5c_observed` shows `x5cLength:2, modified:true` | (Defensive — Apple shifted to 2-cert chains. Our normalizer handled it; harmless.)                        |

**Deeper docs:**
[Webhook routes](../reference/api#post-v1-webhooks-apple-tenantid) ·
[Decoded Apple notification](../reference/api#decoded-notification-payload-structure) ·
[Decoded Google notification](../reference/api#decoded-notification-payload-structure-1) ·
[Probe vs real test](../guide/integration#step-5-test-end-to-end-before-launch)

---

### Step 3 — Outbound delivery reaches integrator's callback

**What happens:** the dispatcher polls `webhook_deliveries` every
`WEBHOOK_DISPATCH_INTERVAL_SECONDS`, picks up the pending row from Step 2,
HMAC-signs the payload, and POSTs to the integrator's callback URL.

**Expected:**

- The integrator's callback receives a POST with the
  [`X-Attesto-Signature`](../reference/webhooks#signature-verification) header
  and the [unified body](../reference/api#outbound-webhook-delivery) including
  `subject` (populated for real events; `null` for probes).
- It verifies HMAC + dedupes on `X-Attesto-Event-Id` + returns 2xx.

**§ Inspect webhook_deliveries (the source of truth for delivery state):**

```bash
mise run t:wh:deliveries tenant_<id> --limit 5
```

Output (one JSON object per row, most recent first):

```jsonc
{
  "id": "del_01...",
  "eventId": "evt_01...",
  "status": "pending",
  "attemptCount": 3,
  "lastResponseCode": 404,
  "bodyPreview": "<!DOCTYPE html><html lang=\"en\" class=\"themeLight\">…",
  "nextAttemptAt": "2026-04-30T08:35:56.524Z",
  "deliveredAt": null,
  "failedAt": null,
  "createdAt": "2026-04-30T08:23:16.145Z"
}
```

`bodyPreview` is truncated to 120 chars + `…` when the upstream response was longer.

Reading the row:

| Pattern                                                                                                     | What it means                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status="delivered"`, `lastResponseCode=200`                                                                | ✅ Success — integrator received and acknowledged.                                                                                                          |
| `status="pending"`, `attemptCount=1..5`, `lastResponseCode` 4xx / 5xx                                       | Integrator returned non-2xx. Will retry on the [schedule](../reference/webhooks#retry-schedule). Check `bodyPreview` and `lastResponseCode`.                |
| `status="pending"`, `attemptCount>=1`, `lastResponseCode=null`, `bodyPreview="The signal has been aborted"` | Callback didn't respond within `WEBHOOK_TIMEOUT_SECONDS` (default 10). Integrator's URL is hung, slow, or wrong host.                                       |
| `status="pending"`, `attemptCount=6`, `nextAttemptAt` in the past                                           | All retries scheduled but not yet flushed (run is imminent). After the last retry without success, status flips to `failed`.                                |
| `status="failed"`, `attemptCount=6`                                                                         | Exhausted retries (~7h12m total). Integrator's receiver never returned 2xx. Investigate their logs.                                                         |
| No rows at all (empty output)                                                                               | Step 2 didn't enqueue — either no `webhook_config` for the tenant (`mise run t:wh:get tenant_<id>` returns "No webhook config") or `is_active=false` on it. |

**Common failures and what to fix:**

| `last_response_code` / `body_preview`     | Cause                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `404` + Heroku / nginx default 404 HTML   | Integrator hasn't deployed the callback path yet.                                                                  |
| `401` + integrator's HMAC error JSON      | Secret mismatch. Re-run `mise run t:wh:set tenant_<id> --secret <new>` with the value the integrator actually has. |
| `500` + integrator's stack trace fragment | Integrator's handler threw — they should fix idempotency / null-check `subject` for probes.                        |
| `null` + `"The signal has been aborted"`  | Timeout. Integrator's URL is unreachable or slow. Check DNS, TLS handshake, response time on a manual `curl`.      |

**§ Verify on integrator-side:**

The integrator's backend logs should show:

- Inbound POST received at the callback path
- HMAC verified successfully (confirm: `X-Attesto-Signature` matches their HMAC over `${X-Attesto-Timestamp}.${rawBody}`)
- Dedup miss / hit on `X-Attesto-Event-Id`
- For real events: `payload.subject.key` lookup in their `user_purchases` table → `user_id`

**Deeper docs:**
[Outbound delivery format](../reference/api#outbound-webhook-delivery) ·
[`subject` field reference](../reference/webhooks#subject) ·
[Retry schedule](../reference/webhooks#retry-schedule) ·
[HMAC verification](../reference/webhooks#signature-verification) ·
[Backend recipes (working receivers)](https://attesto.nossdev.com/recipes/)

---

### Step 4 — Integrator's callback updates user state

**What happens:** the receiver verifies HMAC, dedupes on
`X-Attesto-Event-Id`, looks up the user via `payload.subject.key`, and
applies the state change (extend expiry, mark cancelled, grant refund, etc.).

**Expected:** integrator's DB shows the user's subscription state updated to
match the event. Re-delivering the same `eventId` is a no-op.

**§ Verify on integrator-side (Attesto can't observe this):**

- Subscription record reflects the new state (expiry / status / etc.)
- `payload.subject.key` matched a row in their `user_purchases` mapping table
- Idempotency: re-running `mise run t:apple:test tenant_<id>` (probe) results
  in a delivered webhook but no double-application (probe has `subject=null`,
  handler should skip user-mapping). Real-event idempotency requires the
  integrator to dedup on `X-Attesto-Event-Id`.

**Common failures:**

| Symptom                                                        | Cause                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject.key` lookup misses for a known purchase               | Integrator stored the wrong field at first verify. Most common: stored `transactionId` instead of `originalTransactionId` (Apple) — the two diverge on first renewal. See [Mapping pattern](../guide/integration#mapping-webhook-events-back-to-users). |
| User state double-applied on a single Apple/Google event       | Integrator isn't deduping on `X-Attesto-Event-Id`. Apple and Attesto are both at-least-once; the integrator's handler MUST be idempotent on the event id.                                                                                               |
| Subscription marked expired despite a `DID_RENEW` notification | Integrator's handler is reading from `data.signedTransactionInfo` directly without decoding the JWS. Use `payload.subject.key` for user lookup and `payload.data` / `payload.event` for event-type routing.                                             |

**Deeper docs:**
[Subscription lifecycle pattern](../guide/integration#subscription-lifecycle-verify-webhooks-together) ·
[Idempotency](../reference/webhooks#idempotency)

---

### Failure-mode quick-reference (which step is broken?)

| Symptom                                                                            | Step | First place to look                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrator says verify endpoint returns 401                                        | 1    | Their API key matches what `mise run t:key:ls tenant_<id>` shows?                                                                                                    |
| Integrator says verify works but `originalTransactionId` is missing                | 1    | Apple sandbox often sets `originalTransactionId == transactionId` for first purchases; that's correct. Read [§ stable keys](../guide/integration#the-stable-keys).   |
| Probe via `mise run t:apple:test` succeeds but real renewals never arrive          | 2    | App Store Connect's _Sandbox Server URL_ vs _Production Server URL_ — the sandbox URL must point at the staging tenant. Confirm via `mise run t:wh:get tenant_<id>`. |
| `webhook_events` rows appear but `webhook_deliveries` doesn't                      | 2→3  | Tenant has no `webhook_config` (`mise run t:wh:get tenant_<id>` returns 1) OR `is_active=false`.                                                                     |
| `webhook_deliveries.status=pending` with mounting `attempt_count` and 4xx response | 3    | Integrator's receiver is responding non-2xx. Check `body_preview` for the message they're returning.                                                                 |
| `webhook_deliveries.status=delivered` (200) but integrator says they never got it  | 3→4  | Likely they got it but their handler threw silently after acking. Their logs are the source of truth here.                                                           |
| Integrator's user state updated wrong / for the wrong user                         | 4    | Their `subject.key` lookup is reading the wrong column or matching the wrong platform string.                                                                        |

---

### Common scenarios

**Scenario A: Brand-new tenant — never tested before**

Run the playbook in this order:

1. Probe first (`mise run t:apple:test tenant_<id> --env sandbox`) — proves URL + HMAC. Watch `mise run t:logs tenant_<id>` for the inbound 200.
2. Real sandbox purchase via the iOS app — proves verify + the mapping save (Step 1).
3. Wait ~5 min for Apple's accelerated renewal — exercises Steps 2-3 with a populated `subject`.
4. Confirm Step 4 by inspecting the integrator's user state.

**Scenario B: Integrator just shipped their callback receiver**

Goal: prove the round trip works. Run:

1. `mise run t:apple:test tenant_<id> --env sandbox` (probe — easy first pass)
2. Wait 30s, then `mise run t:wh:get tenant_<id>` and the `webhook_deliveries` query
3. Expected: latest row shows `status=delivered`, `last_response_code=200`
4. If it's stuck on `pending` with 4xx, share `last_response_body` with the integrator — that's their server returning the error

**Scenario C: "It worked yesterday, broken today"**

In order:

1. `mise run t:logs tenant_<id>` — anything obvious in the last hour?
2. `webhook_deliveries` query — recent failures clustered? Check `last_response_code` pattern (all 404? all timeouts?).
3. `mise run t:wh:get tenant_<id>` — has `callbackUrl` changed? Did they migrate to a new domain without updating it?
4. `mise run t:apple:get tenant_<id>` — credentials still active? `revokedAt` field would indicate manual revocation.

---

---

## CI

`.github/workflows/ci.yml` runs on every push and PR:

1. Lint + format-check + typecheck (`mise run lint`)
2. Test suite with a Postgres service container (`mise run test`)

The CI run is the gate before merge to `main`. PRs that fail CI shouldn't merge.
The integration tests rely on the Postgres service container Github Actions
provides — `DATABASE_URL` is pre-set in the runner.

## What's next

- [Load testing](./load-testing) — capacity + latency gates against staging or
  local instances
- [Troubleshooting](./troubleshooting) — when tests fail mysteriously
- [Operations](./operations) — production monitoring (the runtime counterpart to
  test signals)

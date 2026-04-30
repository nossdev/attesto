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

## Beyond unit / integration tests

For the full pipeline walkthrough — initial purchase → verify endpoint →
webhook ingestion → outbound delivery → integrator's callback — see the
**[End-to-end testing](./e2e-testing)** operator playbook. That page covers
each step's expectation, the mise task to verify it, the failure-mode quick
reference, and three concrete onboarding scenarios.

This page focuses on the dev-test loop (running `deno test`, individual
component smoke tests). The e2e playbook is what you run before handing off
a new tenant to the integrator's backend dev.

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

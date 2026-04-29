# Load testing

Attesto's `PLAN.md` §13 calls for a load-test gate before tagging production
releases — p99 latency under 500ms, error rate under 0.1% at sustained traffic.
This page is the runbook.

## Why load test

Two reasons specific to receipt validation:

1. **Latency is bounded by upstream Apple/Google**, but Attesto adds its own
   overhead (auth lookup, decryption, JWS verification with OCSP). You want to
   know that overhead is small (~20-50ms) and stable, not spiking under load.
2. **The rate limiter is per-process** — N Fly machines means N ×
   `RATE_LIMIT_BURST` effective cap per tenant. A load test against staging
   tells you whether your defaults are sensible for a normally-sized tenant.

## What NOT to do

::: danger Don't load-test with real Apple / Google credentials at scale

The naive approach — point a load tester at `/v1/apple/verify` with a real
sandbox `transactionId` — will burn through your tenant's Apple API quota in
seconds, and will burn through Google's far stricter daily quota (~200K
calls/day per package) on Google's side. You can also get flagged for abuse.

**Use known-invalid IDs** that exercise the full pipeline (auth → rate-limit →
loader → upstream call) but receive a fast `404` back from Apple/Google instead
of a real verification. The latency profile is nearly identical (Apple's 404
path is the same code path as the 200 path for the first 90% of work).

:::

## Tools

Three options, in increasing complexity:

| Tool                                          | When to use                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| [`oha`](https://github.com/hatoo/oha)         | One-off bursts. Simplest CLI; good "is this broken?" check.                |
| [`k6`](https://k6.io)                         | Sustained load with shaped traffic. Better for latency percentile reports. |
| [`vegeta`](https://github.com/tsenart/vegeta) | Constant-rate attacks; precise RPS targeting.                              |

`mise install` includes `oha` and `k6` if you uncomment them in
`mise.toml [tools]`. Vegeta is
`go install github.com/tsenart/vegeta/v12@latest`.

## Setup — make a load-test API key

You don't want to load-test with your real production tenant's key. Mint a
dedicated load-test tenant + key:

```bash
mise run cli -- tenant:create --name "Load test"
# → tenant_01HXY...

mise run cli -- key:create tenant_01HXY... --env test --name "load-test"
# → attesto_test_…

# Configure Apple credentials so the request reaches Apple's API
# (you don't need real keys to fail — Attesto will sign a JWT and call
# Apple, which returns a 401 for the bad JWT. That's still ~150ms, which
# is what we're measuring).
mise run cli -- apple:set-credentials tenant_01HXY... \
  --bundle-id com.example.loadtest \
  --key-id ABCDEF1234 \
  --issuer-id 11111111-1111-1111-1111-111111111111 \
  --key-path /tmp/dummy-but-valid-shape.p8 \
  --environment auto
```

::: tip For the most realistic numbers, use a real sandbox `.p8`

If you have a real Apple sandbox key available, use it — Attesto will get
genuine `404 transaction_not_found` responses (faster than `401 invalid auth`)
and your latency will reflect actual Apple traffic.

:::

After the test, **revoke the key** (`mise run cli -- key:revoke key_…`) so it
can't be used accidentally.

## Run with `oha`

The simplest end-to-end check. Runs in your terminal, prints a percentile
report.

```bash
ATTESTO_KEY="attesto_test_…"

oha \
  -n 10000 \
  -c 100 \
  -m POST \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"0000000000000001"}' \
  https://attesto-staging.fly.dev/v1/apple/verify
```

What this does:

- `-n 10000` total requests
- `-c 100` concurrency (100 in-flight at once)
- POST with `transactionId: "0000000000000001"` (deliberately invalid — Apple
  returns 404 quickly)

Sample output you want to see:

```
Summary:
  Total:        45.2 secs
  Slowest:      0.520 secs
  Fastest:      0.140 secs
  Average:      0.290 secs
  Requests/sec: 221.2

Response time histogram:
  0.140 [1]    |
  0.180 [892]  |█████████████████████
  0.220 [2104] |██████████████████████████████████████████████████
  0.260 [3211] |█████████████████████████████████████████████████
  0.300 [2084] |████████████████████████████████████████████
  ...

Latency distribution:
  10% in 0.180 secs
  25% in 0.215 secs
  50% in 0.270 secs
  75% in 0.320 secs
  90% in 0.385 secs
  95% in 0.420 secs
  99% in 0.475 secs

Status code distribution:
  [200] 9994 responses
  [429] 6    responses
```

Read this as:

- **p99 < 500ms ✅** — within budget. Most of the latency is Apple's upstream
  call (~150-300ms), Attesto adds 20-50ms on top.
- **6 × 429 responses** — your rate limiter kicked in. With `-c 100` and the
  default `RATE_LIMIT_BURST=200`, you should see exactly 0 429s for a single
  key. Six suggests you're sharing the test tenant with another caller, or your
  effective cap is lower (single Fly machine = single bucket). Bump up the cap
  or run against a less-busy time.

## Run with `k6` (more sophisticated)

`k6` lets you shape traffic over time (ramp up, sustain, ramp down) and gets you
proper percentile reports + threshold enforcement.

Save as `tests/load/verify.js`:

```javascript
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const verifyLatency = new Trend("verify_latency", true);

export const options = {
  // Three-stage shape: warm up, sustain, cool down
  stages: [
    { duration: "30s", target: 50 }, // ramp up to 50 VUs
    { duration: "5m", target: 50 }, // sustain 50 VUs for 5 min
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    // Fail the run if these aren't met
    "http_req_duration{type:verify}": ["p(99)<500"],
    "http_req_failed": ["rate<0.001"], // <0.1% non-2xx
  },
};

const ATTESTO_URL = __ENV.ATTESTO_URL || "https://attesto-staging.fly.dev";
const ATTESTO_KEY = __ENV.ATTESTO_KEY;

if (!ATTESTO_KEY) {
  throw new Error("ATTESTO_KEY env var required");
}

export default function () {
  const res = http.post(
    `${ATTESTO_URL}/v1/apple/verify`,
    JSON.stringify({ transactionId: "0000000000000001" }),
    {
      headers: {
        "Authorization": `Bearer ${ATTESTO_KEY}`,
        "Content-Type": "application/json",
      },
      tags: { type: "verify" },
    },
  );

  // Track latency in our custom metric
  verifyLatency.add(res.timings.duration);

  // We expect 200 OK with valid:false (the txn is bogus)
  check(res, {
    "status is 200": (r) => r.status === 200,
    "body has valid:false": (r) => r.json("valid") === false,
  });

  // Pace ourselves so a single VU doesn't slam the rate limiter
  sleep(1);
}
```

Run:

```bash
ATTESTO_KEY="attesto_test_…" k6 run tests/load/verify.js
```

`k6` exits non-zero if your thresholds (p99 < 500ms, error rate < 0.1%) are
violated — useful for CI gating.

## Test the webhook delivery path

If you also want to confirm webhook delivery throughput, that's a different load
profile — Attesto's dispatcher loops every `WEBHOOK_DISPATCH_INTERVAL_SECONDS`
(default 10s) and processes up to 10 deliveries per tick. So sustained webhook
capacity is roughly **10 deliveries / 10s = 1 / s steady state**.

To stress this, you'd need to enqueue many `webhook_events` rows artificially:

```sql
-- Insert 1000 fake events for the load-test tenant
INSERT INTO webhook_events (id, tenant_id, source, external_id, event_type, raw_payload, decoded_payload, received_at)
SELECT
  'evt_' || lpad(generate_series::text, 26, '0'),
  'tenant_01HXY...',
  'apple',
  'load-test-' || generate_series,
  'apple.load_test',
  '{}'::jsonb,
  '{}'::jsonb,
  now() - (generate_series || ' seconds')::interval
FROM generate_series(1, 1000);
```

Then watch how long it takes the dispatcher to drain. This isn't really a load
test in the throughput sense — it's a **capacity check** that tells you whether
your callback URL can keep up with bursty webhook floods.

::: warning Webhook load testing is multi-instance-unsafe

The current dispatcher is single-instance. If you scale Attesto horizontally
during load testing, all replicas will pick up `pending` rows and your callback
will receive **N copies** of every event. Stick to a single Fly machine when
doing dispatcher load tests.

:::

## What "good" looks like for v0.1.0

For sustained 50-100 RPS verify traffic against a single Fly machine in `iad`:

| Metric                  | Target            | Why                                            |
| ----------------------- | ----------------- | ---------------------------------------------- |
| p50 latency             | <250ms            | Most of this is Apple/Google upstream          |
| p95 latency             | <400ms            |                                                |
| p99 latency             | <500ms            | PLAN.md §13 hard target                        |
| Error rate              | <0.1%             | Excludes domain `valid:false` (those are 200)  |
| 429 (rate-limited) rate | 0 in steady state | Spike means your defaults are too tight        |
| CPU usage               | <50%              | Headroom for traffic spikes + JWS verification |
| Memory                  | <300MB            | Heap stable; no leak under sustained load      |

If you blow past these:

- **p99 high but p50 fine** → Apple/Google had a slow tail. Check their status
  pages; not necessarily an Attesto problem.
- **p50 high** → check Postgres connection saturation, OCSP resolver latency, or
  DNS caching.
- **Error rate >0.1%** → look at the actual error codes returned. 502s are
  upstream. 500s are bugs. 401s are your test-key revoked.
- **429s in steady state** → bump `RATE_LIMIT_BURST` for the load-test tenant
  temporarily, OR scale to multiple Fly machines so the rate limit budget
  multiplies.

## Running the test against production

**Don't.** Use staging:

- Production has a real, paying-customer tenant whose key you don't want to
  overlap
- Production's rate limits are tuned for normal traffic; a load test will
  trigger 429s for actual users
- A production Postgres is sized for normal connection counts; a 100-VU load
  test can saturate it

If you absolutely must test prod (e.g., to validate a config change at real
load), do it during a designated maintenance window, with a load-test-only
tenant whose API key is revoked immediately after.

## When to re-run the load test

- **Before every `v0.X.0` minor-version tag** — catches regressions
- **After Postgres tuning changes** — confirms pool sizing didn't break anything
- **After Fly machine size changes** — re-baseline the latency floor
- **Quarterly as a baseline sanity check** — Apple/Google upstreams shift over
  time

## Cleanup

After the test:

```bash
# Revoke the load-test key so it can't be reused
mise run cli -- key:revoke key_…

# Optionally deactivate the load-test tenant
mise run cli -- tenant:deactivate tenant_01HXY...
```

Or just leave them around as a reusable fixture — they don't cost anything if no
traffic flows.

## What's next

- [Operations](./operations) — runtime monitoring metrics that match what you
  measure here
- [Maintenance](./maintenance) — the periodic re-baselining cadence
- [Testing](./testing) — unit + integration tests (the other side of test
  coverage)

# Integration guide

> **For backend developers integrating with Attesto.** If you've been given an
> API key for an Attesto deployment and need to call it from your service, this
> is your starting point. If you're the operator running your own Attesto
> instance, see the [self-host quickstart](/self-host/quickstart) instead.

## What you've been given

After your operator hands off your tenant credentials, you should have:

| Item                     | Looks like                                       | What it's for                                                           |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| **Attesto base URL**     | `https://attesto.your-operator.com`              | Where your verify calls go                                              |
| **API key**              | `attesto_live_8xYz…` (43 chars after the prefix) | Authenticates every API call                                            |
| **Webhook secret**       | `<32+ char base64 string>`                       | If you'll receive webhooks — used to verify the HMAC on incoming events |
| **Webhook callback URL** | `https://your-backend.com/attesto-webhook`       | The URL on YOUR end that Attesto will POST to                           |

::: danger Treat the API key like a database password

The API key grants full access to your tenant's verify endpoints. Store it in
your secret manager (1Password, AWS Secrets Manager, Doppler, etc.) and inject
it as an environment variable. **Never** commit it to source control, log it, or
send it to clients.

:::

## What stays unchanged on your end

Your **mobile client code does not change**. The iOS and Android Billing flows
are identical to whatever you have today:

- iOS: StoreKit 2 returns a `Transaction` with a `transactionId`
- Android: Google Play Billing Library returns a `Purchase` with a
  `purchaseToken` and `productId`

Your client passes these identifiers to **your** backend. Your backend then
calls Attesto. Attesto never talks to the mobile client directly.

::: tip Building on Capacitor?

[`@nossdev/iap`](https://iap.nossdev.com) is the companion client SDK for this
exact pattern. It orchestrates the native purchase flow, sends receipts to your
backend, and caches entitlements after your backend confirms — eliminating
boilerplate around purchase orchestration and restore.

For runnable backend skeletons that implement the five endpoints iap calls
(verify/apple, verify/google, entitlements, restore, products) plus the Attesto
webhook receiver, see the [backend recipes](/recipes/) — available in Deno,
Node, Python, Java, and Ruby.

:::

```
[iOS / Android client]
        │
        │  transactionId / purchaseToken
        ▼
[YOUR backend]                    ← integration code lives here
        │
        │  POST /v1/{apple,google}/verify
        │  Authorization: Bearer attesto_live_…
        ▼
[Attesto]
        │
        │  signs JWT, calls Apple/Google,
        │  verifies signatures, returns payload
        ▼
[YOUR backend]
        │
        │  decides: grant access / update sub state / etc.
        ▼
[iOS / Android client]
```

## Step 1 — Verify an Apple transaction

The simplest possible call:

```bash
curl -X POST https://attesto.your-operator.com/v1/apple/verify \
  -H "Authorization: Bearer attesto_live_…" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

### TypeScript / Node.js

```typescript
type AppleVerifyResult =
  | {
    valid: true;
    environment: "production" | "sandbox";
    transaction: AppleTransaction;
  }
  | {
    valid: false;
    error: "TRANSACTION_NOT_FOUND" | "BUNDLE_ID_MISMATCH";
    message: string;
  };

interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: string; // ISO 8601
  expiresDate: string | null;
  type: string; // "Auto-Renewable Subscription" | "Consumable" | etc.
  inAppOwnershipType: "PURCHASED" | "FAMILY_SHARED";
  quantity: number;
  revocationDate: string | null;
  revocationReason: number | null;
  storefront: string;
  currency: string;
  price: number; // smallest currency unit
  signedTransactionInfo: string;
  rawDecodedPayload: Record<string, unknown>;
}

export async function verifyApple(
  transactionId: string,
): Promise<AppleVerifyResult> {
  const response = await fetch(`${ATTESTO_URL}/v1/apple/verify`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ATTESTO_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transactionId }),
  });

  // 4xx / 5xx — see "Error handling" below
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AttestoError(response.status, body.error, body.message);
  }

  return await response.json() as AppleVerifyResult;
}
```

### Python

```python
import httpx
from typing import TypedDict, Literal, Union

class AppleTransaction(TypedDict):
    transactionId: str
    originalTransactionId: str
    bundleId: str
    productId: str
    expiresDate: str | None
    # ... full set in the API reference

class AppleSuccess(TypedDict):
    valid: Literal[True]
    environment: Literal["production", "sandbox"]
    transaction: AppleTransaction

class AppleFailure(TypedDict):
    valid: Literal[False]
    error: str
    message: str

AppleResult = Union[AppleSuccess, AppleFailure]

def verify_apple(transaction_id: str) -> AppleResult:
    response = httpx.post(
        f"{ATTESTO_URL}/v1/apple/verify",
        headers={"Authorization": f"Bearer {ATTESTO_KEY}"},
        json={"transactionId": transaction_id},
        timeout=10.0,
    )
    if response.status_code != 200:
        raise AttestoError(response.status_code, response.json())
    return response.json()
```

### Go

```go
type AppleTransaction struct {
    TransactionID         string  `json:"transactionId"`
    OriginalTransactionID string  `json:"originalTransactionId"`
    BundleID              string  `json:"bundleId"`
    ProductID             string  `json:"productId"`
    ExpiresDate           *string `json:"expiresDate"`
    // ... full set in the API reference
}

type AppleVerifyResult struct {
    Valid       bool              `json:"valid"`
    Environment string            `json:"environment,omitempty"`
    Transaction *AppleTransaction `json:"transaction,omitempty"`
    Error       string            `json:"error,omitempty"`
    Message     string            `json:"message,omitempty"`
}

func VerifyApple(ctx context.Context, transactionID string) (*AppleVerifyResult, error) {
    body, _ := json.Marshal(map[string]string{"transactionId": transactionID})
    req, err := http.NewRequestWithContext(ctx, "POST",
        attestoURL+"/v1/apple/verify", bytes.NewReader(body))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Authorization", "Bearer "+attestoKey)
    req.Header.Set("Content-Type", "application/json")

    resp, err := httpClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        return nil, parseAttestoError(resp)
    }

    var result AppleVerifyResult
    return &result, json.NewDecoder(resp.Body).Decode(&result)
}
```

## Step 2 — Verify a Google purchase

Same pattern — slightly different request shape:

```bash
curl -X POST https://attesto.your-operator.com/v1/google/verify \
  -H "Authorization: Bearer attesto_live_…" \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "<long-opaque-token-from-Play-Billing>",
    "type": "subscription"
  }'
```

| Field           | Required | Notes                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------- |
| `packageName`   | yes      | Same as your `applicationId` in Gradle                                 |
| `productId`     | yes      | The product / base plan ID from Play Console                           |
| `purchaseToken` | yes      | Whatever your Android client got from `Purchase.getPurchaseToken()`    |
| `type`          | yes      | `"subscription"` or `"product"` (one-shot consumable / non-consumable) |

### TypeScript

```typescript
type GoogleVerifyResult =
  | { valid: true; purchase: GoogleSubscription | GoogleProduct }
  | {
    valid: false;
    error: "PURCHASE_NOT_FOUND" | "PACKAGE_NAME_MISMATCH";
    message: string;
  };

export async function verifyGoogle(
  packageName: string,
  productId: string,
  purchaseToken: string,
  type: "subscription" | "product",
): Promise<GoogleVerifyResult> {
  const response = await fetch(`${ATTESTO_URL}/v1/google/verify`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ATTESTO_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ packageName, productId, purchaseToken, type }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AttestoError(response.status, body.error, body.message);
  }

  return await response.json() as GoogleVerifyResult;
}
```

For full response shapes (subscription vs product), see the
[API reference](/reference/api#post-v1-google-verify).

## Step 3 — Handle responses

Three buckets. Plan for all three.

### A. Successful verification (`valid: true`)

The transaction / purchase is real and the response includes the verified
payload. **Do not blindly trust it** — apply your business rules:

- Check `expiresDate` (Apple) or `expiryTime` (Google) against `now()` to
  determine if the subscription is currently active.
- Check `revocationDate` (Apple) or `cancelReason` in Google's `rawResponse` to
  detect refunded transactions.
- Check `bundleId` / `packageName` matches your expected app — Attesto also
  enforces this, but defense in depth.
- For subscriptions, check `inAppOwnershipType` (Apple) — `FAMILY_SHARED`
  members may have different entitlements in your business rules.

```typescript
async function grantAccess(transactionId: string, userId: string) {
  const result = await verifyApple(transactionId);
  if (!result.valid) {
    return { granted: false, reason: result.error };
  }

  const tx = result.transaction;

  // Business rules YOU enforce:
  const isActive = !tx.expiresDate || new Date(tx.expiresDate) > new Date();
  const isRevoked = tx.revocationDate !== null;
  if (!isActive || isRevoked) {
    return { granted: false, reason: "EXPIRED_OR_REVOKED" };
  }

  // Persist on your side, then grant
  await db.entitlements.upsert({
    userId,
    productId: tx.productId,
    expiresAt: tx.expiresDate,
    transactionId: tx.transactionId,
  });

  return { granted: true };
}
```

### B. Domain failure (`200 OK` with `valid: false`)

The request was valid, the upstream call succeeded, but the answer was "no such
transaction" or similar.

```typescript
if (!result.valid) {
  if (result.error === "TRANSACTION_NOT_FOUND") {
    // Common: user pasted a fake ID, or the txn was wiped from Apple's side.
    // Don't grant access; tell the client politely.
    return { granted: false, reason: "RECEIPT_INVALID" };
  }
  if (result.error === "BUNDLE_ID_MISMATCH") {
    // The transaction is real but for a DIFFERENT app than your tenant
    // is configured for. This usually means your client is sending the
    // wrong bundle's transactions, OR your app has multiple bundle IDs
    // (Watch / Clip variants) that need separate Attesto tenants.
    log.error("bundle mismatch", { transactionId: tx, expected: BUNDLE_ID });
    return { granted: false, reason: "WRONG_APP" };
  }
}
```

These are domain-level "no" answers — not bugs. Surface them to your client with
appropriate messaging. **Don't retry** — the answer won't change.

### C. Transport / auth / upstream errors (4xx / 5xx)

| Status                                         | What to do                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_REQUEST`                          | Programming error in your call. Check the request shape. Don't retry.                                                |
| `400 CREDENTIALS_MISSING`                      | Your tenant hasn't been fully onboarded. Contact your operator. Don't retry.                                         |
| `401 UNAUTHENTICATED`                          | Your API key is invalid or revoked. Don't retry; alert.                                                              |
| `429 RATE_LIMITED`                             | Honor the `Retry-After` header. See "Retry policy" below.                                                            |
| `502 APPLE_API_ERROR` / `502 GOOGLE_API_ERROR` | Upstream is misbehaving. Retry with backoff.                                                                         |
| `500 INTERNAL_ERROR`                           | Attesto bug or transient issue. Retry with backoff once; if persistent, alert your operator with the `X-Request-Id`. |

```typescript
class AttestoError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(`Attesto ${status} ${code}: ${detail}`);
  }
  isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

async function verifyWithRetry<T>(call: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof AttestoError) || !e.isRetryable() || attempt >= 3) {
        throw e;
      }
      const wait = Math.min(2 ** attempt * 1000, 8000);
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
    }
  }
}
```

## Step 4 — Receive webhooks (optional)

If your tenant has a webhook callback configured, Attesto will POST verified
events from Apple S2S V2 and Google RTDN to your URL. You implement the receiver
— verify the [HMAC](/reference/glossary#hmac) signature, dedupe on
`X-Attesto-Event-Id`, then update your subscription state.

Three jumping-off points instead of inlining the code here:

- [Backend recipes](/recipes/) — runnable receiver implementations in Deno,
  Node, Python, Java, and Ruby. Pick the one that matches your stack; copy-paste
  the webhook section.
- [Webhooks reference](/reference/webhooks) — the exact wire spec: headers, body
  shape, signature algorithm, retry schedule, idempotency rules, normalized
  event vocabulary.
- [Architecture § Webhook path](./architecture#webhook-path-stateful) — how
  Attesto dedupes inbound events, why it's at-least-once, and where
  responsibility shifts to your receiver.

::: tip Why the HMAC verification matters

Without it, your callback URL is spoofable by anyone who guesses or discovers
it. Attesto's outbound delivery is authenticated **only** by the HMAC signature;
treat verification as part of the receiver, not an optional hardening step.

:::

## Production checklist

Before flipping the integration to production traffic:

- [ ] **API key in secret manager** — not in env files in the repo, not in
      config files, not logged. Rotate quarterly.
- [ ] **Live vs test key**: prefix `attesto_live_` for production,
      `attesto_test_` for staging / dev. Your code can fail fast if mismatched
      (`if (key.startsWith("attesto_test_") && env === "production") panic()`)
- [ ] **Webhook signature verification implemented and tested.** Send a request
      with a tampered body and confirm your receiver returns 401.
- [ ] **Idempotency on `X-Attesto-Event-Id`** — confirm a duplicate delivery
      doesn't double-charge / double-grant.
- [ ] **Retry policy** for 429 / 5xx. Cap at 3-4 retries with exponential
      backoff. Don't retry 4xx.
- [ ] **Timeout** on your verify calls — 10 seconds is sane. Apple/Google can be
      slow, but waiting forever is worse than failing fast.
- [ ] **Monitor for spikes** in `valid: false` responses — could indicate an
      attempted-fraud campaign or a misconfigured app.
- [ ] **Webhook receiver** uses the **raw request body** when computing the
      HMAC, not a JSON-parsed-then-stringified version.
- [ ] **Webhook receiver** is exposed at HTTPS (Attesto's SSRF guard rejects
      HTTP callback URLs on tenant config).
- [ ] **Subscription state** in your DB is the source of truth — derive it from
      verified Attesto responses + webhook events. Don't trust the
      client-supplied transactionId at face value, ever.

## Network considerations

For most cloud-deployed backends (AWS, GCP, Fly, Render, Vercel, etc.) you don't
need to do anything — outbound HTTPS to the open internet is allowed by default.
Skip this section.

If you're behind a corporate firewall, in a VPC with explicit egress rules, or
running on a network with default-deny outbound, you'll need to allow:

| Destination           | Port | Why               |
| --------------------- | ---- | ----------------- |
| `<your-attesto-host>` | 443  | Your verify calls |

(Attesto itself talks to Apple's `api.storekit.itunes.apple.com` and Google's
`oauth2.googleapis.com` + `androidpublisher.googleapis.com` — those are
Attesto's egress concern, not yours.)

### Inbound — webhook receiver from Attesto

Attesto runs on Fly.io with **ephemeral IPs that change on deploy**. Don't try
to IP-allowlist Attesto's source IPs on your webhook receiver — they will move
out from under you and your callbacks will start failing silently.

The right pattern is **HMAC verification on every request** (see
[Step 4 — Receive webhooks](#step-4-receive-webhooks) above). The signature
proves the request came from Attesto regardless of source IP. Reject anything
without a valid signature; accept anything with one.

If your security policy absolutely requires an IP allowlist, ask your operator
to deploy Attesto behind a static-IP gateway (Cloudflare Workers, AWS
CloudFront, etc.) and allowlist the gateway's IPs. Most operators won't have
this set up by default.

### TLS / certificate pinning

Don't pin Attesto's TLS certificate. The certificate is renewed periodically
(Let's Encrypt rotates every 90 days, Fly handles this automatically) — a pinned
cert will start failing without warning.

Standard system-trust-store TLS validation is sufficient. If you need a higher
bar, pin the **certificate authority** (Let's Encrypt's ISRG Root X1 + Root X2)
rather than the leaf cert.

## Common patterns

### Caching verify responses

Apple/Google rate-limit the upstream APIs. If your client retries a purchase
confirmation, you'll get the same `transactionId` repeatedly. Cache verified
results for ~10 minutes:

```typescript
const cache = new Map<string, { result: AppleVerifyResult; until: number }>();

async function verifyAppleCached(transactionId: string) {
  const hit = cache.get(transactionId);
  if (hit && hit.until > Date.now()) return hit.result;

  const result = await verifyApple(transactionId);
  cache.set(transactionId, {
    result,
    until: Date.now() + 600_000, // 10 min
  });
  return result;
}
```

::: warning Don't cache forever

A subscription's `expiresDate` will move forward on renewal. Cache verify
responses with a short TTL (~10 min) so renewals are reflected quickly. For
long-lived subscription state, use **webhooks** (which Attesto forwards in
near-real-time) rather than polling verify.

:::

### Subscription lifecycle: verify + webhooks together

The strongest pattern uses both:

1. **On purchase**: client → your backend → Attesto verify → grant access
2. **On renewal/cancel/refund**: Apple/Google → Attesto webhook receiver → your
   backend → update subscription state

Verify is the **point-in-time confirmation**; webhooks are the **state-machine
driver**. You'll typically build:

- A `subscriptions` table on your side, keyed by user
- An update on every webhook event (extend, revoke, mark cancelled)
- A read path that checks both the row and `expires_at > now()` before granting
  access

### Multiple environments

Run separate Attesto tenants for production vs staging:

```typescript
const ATTESTO_URL = process.env.ATTESTO_URL;
const ATTESTO_KEY = process.env.ATTESTO_KEY;

// Defense check: keys leaking across envs is a real outage source
if (
  process.env.NODE_ENV === "production" &&
  !ATTESTO_KEY.startsWith("attesto_live_")
) {
  throw new Error("test API key in production env!");
}
if (
  process.env.NODE_ENV === "staging" && !ATTESTO_KEY.startsWith("attesto_test_")
) {
  throw new Error("live API key in staging env!");
}
```

## Reference

- [API reference](/reference/api) — every endpoint with full request / response
  shapes
- [Error codes](/reference/error-codes) — all 10 error codes with caller actions
- [Webhooks reference](/reference/webhooks) — outbound delivery format + retry
  schedule
- [Backend recipes](/recipes/) — receiver implementations in 5 languages
- [Troubleshooting](/self-host/troubleshooting) — symptom-keyed problem-solving

## Getting help

- **Operator-side issues** (your API key isn't working, webhooks aren't
  arriving) → contact whoever set up your Attesto tenant
- **Bugs in the public Attesto code** → file at
  [github.com/nossdev/attesto/issues](https://github.com/nossdev/attesto/issues)

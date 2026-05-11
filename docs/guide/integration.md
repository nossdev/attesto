# Integration guide

> **For backend developers integrating with Attesto.** If you've been given an
> API key for an Attesto deployment and need to call it from your service, this
> is your starting point. If you're the operator running your own Attesto
> instance, see the [self-host quickstart](/self-host/quickstart) instead.

## What you've been given

After your operator hands off your tenant credentials, you should have **one set
per environment** — typically a staging set you'll develop against and a
production set you'll flip to at launch. Each set looks like:

| Item                     | Looks like                                                         | What it's for                                      |
| ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| **Attesto base URL**     | staging: `https://api-staging.<host>` ; prod: `https://api.<host>` | Where your verify calls go                         |
| **API key**              | staging: `attesto_test_…` ; prod: `attesto_live_…`                 | Authenticates every API call                       |
| **Webhook secret**       | `<32+ char base64 string>`, distinct per env                       | Used to verify the HMAC on incoming webhook events |
| **Webhook callback URL** | `https://your-backend.com/attesto-webhook`                         | The URL on YOUR end that Attesto will POST to      |

The staging set targets Apple's sandbox API and Google's sandbox; production
targets the real upstream APIs. Wire each set into a **separate environment** in
your backend (different secret-manager paths, different deploy targets) and
never let staging credentials reach a prod build or vice versa.

::: tip Develop on staging first

Build and test against the staging set with sandbox testers (Apple) and license
testers (Google) driving real transactions. Only swap to the production base
URL + key after your verify path and webhook receiver are signed-off and
idempotent. The dual-credential setup is intentional precisely so you can shake
out bugs without touching real revenue.

:::

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
    /**
     * App-supplied UUID when pre-attached at purchase time (StoreKit's
     * `appAccountToken`); null otherwise. Surfaced at the top level so
     * you can join on user identity without reading platform-specific
     * fields. See "Mapping webhook events back to users" below.
     */
    appUserId: string | null;
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
    # App-supplied UUID when pre-attached at purchase time (StoreKit's
    # `appAccountToken`); None otherwise. See "Mapping webhook events
    # back to users" below for the join pattern.
    appUserId: str | None
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
    // App-supplied UUID when pre-attached at purchase (StoreKit's
    // appAccountToken); nil otherwise. See "Mapping webhook events
    // back to users" below.
    AppUserID   *string           `json:"appUserId,omitempty"`
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
  | {
    valid: true;
    /**
     * App-supplied UUID when pre-attached at purchase time (Play
     * Billing's `obfuscatedAccountId`); null otherwise. Same field
     * name as on Apple verify responses for cross-platform consistency.
     * See "Mapping webhook events back to users" below.
     */
    appUserId: string | null;
    purchase: GoogleSubscription | GoogleProduct;
  }
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

  // If the app pre-attached an `appUserId` at purchase time, save it
  // to the user record now — the eventual webhook will carry the same
  // value, letting you join directly without the subject.key upsert
  // pattern. See "Mapping webhook events back to users" below.
  if (result.appUserId) {
    await db.users.update({
      where: { id: userId },
      data: { iapUserUuid: result.appUserId },
    });
  }

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

The outbound payload includes a top-level `appUserId` (string or null) alongside
`subject` — set when the original purchase was made via `@nossdev/iap` v0.2+
with a pre-attached identifier. Use it for direct user-identity joins; fall back
to `subject.key` mapping when null. Full payload schema + TypeScript interface
in the [Webhooks reference](/reference/webhooks#appuserid).

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

## Step 5 — Test end-to-end before launch

You have two distinct kinds of "sandbox tests" available, and they exercise
**different parts of the pipeline**. Run both — they answer different questions.

::: tip Operator-side companion

Your operator has a parallel walkthrough at
[Self-host § End-to-end testing](/self-host/e2e-testing) that uses mise tasks to
inspect Attesto's internal state (`webhook_events`, `webhook_deliveries`,
`validation_audit`) at each step. Reading both side-by-side during a tricky
onboarding gives you a complete picture of where any mismatch lives.

:::

### A. Probe test — "is the webhook URL wired correctly?"

Both stores expose a one-click button (or API call) that fires a synthetic
notification at your configured webhook URL. Apple's is _Request a Test
Notification_ in App Store Connect; Google's is _Send test notification_ in Play
Console's Pub/Sub config. Your operator may also use Attesto's
`apple:request-test-notification` CLI which calls the Apple API equivalent.

What this proves:

- ✅ Apple/Google can reach your operator's Attesto URL
- ✅ Attesto verifies the upstream signature and forwards to your callback
- ✅ Your callback receives the POST, verifies HMAC, returns 2xx
- ❌ **Does NOT exercise the user-mapping path** — these notifications carry no
  transaction data

What `subject` looks like in this case:

```jsonc
{
  "event": "test", // unified — same value for Apple TEST and Google testNotification
  "platformEvent": "apple.test", // or "google.test" — preserves the upstream identifier
  "subject": null, // ← null on probe tests
  "data": {/* test envelope, no signedTransactionInfo */}
  // ...
}
```

Your handler should treat `subject == null` as a no-op for user-mapping purposes
(per the [mapping pattern](#mapping-webhook-events-back-to-users)) and just log
that the probe arrived. **A successful probe test is necessary but not
sufficient** — it doesn't tell you whether your user-mapping table is wired up
correctly.

### B. Real flow test — "does a real purchase reach the right user?"

Drive an actual sandbox purchase end-to-end:

1. **Apple**: enroll a sandbox tester account in App Store Connect → Users and
   Access → Sandbox → Testers. On a real iOS device, sign into _Settings → App
   Store → Sandbox Account_ with that tester. Run your app and complete a
   purchase. Apple emits a real V2 notification with
   `notificationType: "SUBSCRIBED"` (or `DID_RENEW` for renewals — wait the
   configured renewal interval to see one).
2. **Google**: add a license tester in Play Console → Setup → License testing.
   On a real Android device signed in with that account, install your app from
   internal testing track, complete the sandbox purchase. Google emits an RTDN
   with `subscriptionNotification.notificationType: 4`
   (`SUBSCRIPTION_PURCHASED`).

What this proves:

- ✅ Everything probe test proves
- ✅ Real `originalTransactionId` / `purchaseToken` flows through Attesto
- ✅ **If pre-attached:** `appUserId` is populated on the webhook payload and
  matches the UUID your app supplied at purchase
- ✅ **Otherwise:** `subject.key` is populated and matches what you saved at
  first verify
- ✅ Your mapping lookup (by `appUserId` or `subject.key`) finds the user
- ✅ Subscription state changes apply correctly

If your app uses [`@nossdev/iap`](https://www.npmjs.com/package/@nossdev/iap)
v0.2+ with `appUserId` pre-attached, expect that field populated; otherwise it's
`null` and you'll join via `subject.key`. The payload looks like:

```jsonc
{
  "event": "subscription.purchased", // unified — Apple SUBSCRIBED.INITIAL_BUY / Google SUBSCRIPTION_PURCHASED
  "reason": "initial",
  "platformEvent": "apple.subscribed.initial_buy",
  "appUserId": "11111111-2222-4333-8444-555555555555", // null if not pre-attached
  "subject": {
    "key": "2000000123456789", // matches what you saved at first verify
    "productId": "com.example.premium.monthly",
    "type": "subscription"
  },
  "data": {/* full Apple V2 notification with signedTransactionInfo */}
  // ...
}
```

For the full event vocabulary (Tier 1 / Tier 2 / Tier 3 events your backend
should handle, with their `reason` values and Apple/Google upstream mappings),
see the [Webhooks reference § Event types](/reference/webhooks#event-types).

::: tip Recommended test sequence

1. Probe test first — fastest feedback that your URL + HMAC verification work.
   If this fails, no point trying anything else.
2. Real sandbox purchase second — proves the user-mapping happy path.
3. **Renewal**: Apple sandbox renewals happen on accelerated timers (1 month
   subscription = 5 minutes in sandbox). Make a sandbox purchase, leave the
   device idle, and a renewal `DID_RENEW` notification will arrive within the
   accelerated window. Same exercise as (2) but verifies the
   `originalTransactionId` is stable across renewals (it should be — that's the
   whole point of using it as the mapping key).
4. **Refund**: Apple sandbox doesn't simulate refunds well; the realistic path
   is to verify the handler does the right thing on a unit-tested payload.
   Google has a refund flow in Play Console for license testers.

:::

::: warning Don't ship without exercising both probe AND real

A passing probe test gives a false sense of security. Real onboarding bugs hide
in the user-mapping path that probe tests skip — wrong key column saved at
verify, missing `originalTransactionId` field in the schema, mismatched platform
string between the verify save and the webhook lookup. Only the real-purchase
test exercises any of these.

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
- [ ] **If using `appUserId` pre-attach**: backend mint-or-lookup endpoint is
      auth-gated, idempotent (same caller → same UUID across calls), and returns
      `{"uuid": "<v4>"}`. The `users.iap_user_uuid` column has a `UNIQUE`
      constraint so a misbehaving fetcher can't double-assign. See
      [recipe examples](/recipes/) for language-idiomatic implementations.

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

### Mapping webhook events back to users

When a webhook fires (renewal, expiration, refund), the payload tells you _what_
happened but not _which of your users_ it happened to. Attesto supports two
mechanisms for the mapping, in order of preference:

- **Pre-attach an `appUserId`** at purchase time so it travels through both the
  verify response and the outbound webhook payload (recommended for new
  integrations — eliminates the verify/webhook race entirely).
- **Map by `subject.key`** — Apple's `originalTransactionId` / Google's root
  `purchaseToken` — when pre-attach isn't available (guest purchases,
  pre-existing transactions, SDKs that don't expose `appAccountToken` /
  `obfuscatedAccountId`).

Pick whichever fits your app's UX; the two can coexist for apps with a mix of
authenticated and guest purchase flows.

#### Recommended: pre-attach an `appUserId` at purchase time

When the mobile SDK supports it, the cleanest pattern attaches an identifier to
the purchase **at StoreKit / Play Billing time**. Apple calls this
`appAccountToken`; Google calls it `obfuscatedAccountId`. Attesto extracts both
upstream and surfaces them as a **unified top-level `appUserId` field** on both
the verify response and the outbound webhook payload — same field name across
platforms, no platform-specific extraction needed in your handler.

The result: your webhook handler joins on `appUserId` directly — no upsert
dance, no orphan rows, no cross-signal race.

```typescript
async function handleAttestoWebhook(payload: AttestoWebhookPayload) {
  if (!payload.appUserId) {
    // Pre-attach wasn't used for this purchase (guest flow, legacy
    // transaction, etc.) — fall through to the subject.key path below.
    return handleByFallback(payload);
  }
  const user = await db.users.findOne({ iapUserUuid: payload.appUserId });
  if (!user) return; // unknown UUID — log for support tooling
  await applySubscriptionStateChange(user.id, payload);
}
```

##### Two ways to supply `appUserId` from the mobile app

If you use [`@nossdev/iap`](https://www.npmjs.com/package/@nossdev/iap) v0.2+,
the `purchase()` API accepts the `appUserId` two ways:

```typescript
// (a) Plain string — caller already has the UUID for this user.
await iap.purchase({
  productId: "premium_monthly",
  appUserId: currentUser.iapUuid,
});

// (b) Async fetcher — caller's backend mints+stores the UUID per user
// the first time it's asked, returns the same UUID on later calls.
await iap.purchase({
  productId: "premium_monthly",
  appUserId: async () => {
    const r = await fetch("/api/iap/uuid", { headers: authHeaders() });
    return (await r.json()).uuid;
  },
});
```

The fetcher is invoked fresh on every purchase; iap caches nothing. Your backend
owns the mint-or-lookup idempotency:

| First call (user has no UUID) | Subsequent calls (user has UUID) |
| ----------------------------- | -------------------------------- |
| Mint a fresh UUID v4          | Return the existing UUID         |
| Persist on the user's record  | (no write)                       |
| Return `{ uuid }` to iap      | Return `{ uuid }` to iap         |

`@nossdev/iap` validates the resolved value is a UUID v4 before passing to
native; non-UUID values throw `IAPError(INVALID_APP_USER_ID)`. See the
[backend recipes](/recipes/) for a language-idiomatic implementation of the
mint-or-lookup endpoint in your stack.

##### When pre-attach isn't possible

Not every flow can pre-attach an `appUserId`. Common cases:

- **Guest purchases** — your app allows purchase before the user has an account
  (sign-up happens after purchase success). No user identity exists at StoreKit
  time. Omit `appUserId` from the iap call; the fallback below covers these.
- **Pre-existing transactions** — purchases made before your app wired up
  `appUserId`. They'll never have one retroactively.
- **SDKs that don't expose the field** — older billing libraries or custom
  integrations may not surface a way to set `appAccountToken` /
  `obfuscatedAccountId` per-purchase.

For all of these, the `subject.key` fallback below applies.

#### Fallback: map by `subject.key` when `appUserId` isn't available

When `payload.appUserId` is null, fall back to the platform-specific stable key.
The pattern: **save the key at first verify, look it up when webhooks arrive,
and make both writes idempotent so they can land in either order.**

##### The stable keys

| Platform   | Stable key                                                                                | Don't use                                                              |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Apple**  | `transaction.originalTransactionId` — same across all renewals of a subscription          | `transactionId` (changes on every renewal)                             |
| **Google** | `purchase.purchaseToken` — stable for the subscription's lifetime including auto-renewals | `orderId` (suffix changes per renewal; subject to upgrade-flow resets) |

For one-shot products (consumables, non-consumables) both keys are stable
per-purchase. For subscriptions they survive auto-renewals — that's what makes
them the right mapping key.

##### Save at first verify

```typescript
// On every fresh purchase / restore the app sends to your backend:
const { transaction } = await verifyApple({ transactionId });
// Use upsert (not insert) keyed on (platform, key) — the webhook may have
// created the row first; see "Verify and webhook can arrive in either
// order" below.
await db.userPurchases.upsert({
  userId: req.user.id,
  platform: "apple",
  key: transaction.originalTransactionId, // ← THE KEY
  productId: transaction.productId,
  expiresAt: transaction.expiresDate,
});
// Google: identical shape, save `purchase.purchaseToken` instead.
```

##### Look up when the webhook fires

Attesto surfaces the stable key on a unified `subject.key` field of the outbound
webhook payload — same shape across Apple and Google, no JWS decoding required.
See the [webhook reference § subject](/reference/webhooks#subject) for the full
type.

```typescript
async function handleAttestoWebhook(payload: AttestoWebhookPayload) {
  // Apple TEST / Google testNotification / refund events have subject=null —
  // they're real events but don't tie to a single user record.
  if (!payload.subject) return;

  const row = await db.userPurchases.findByKey(
    payload.source,
    payload.subject.key,
  );
  if (!row) return; // webhook beat verify — see next section for resilient handling
  await applySubscriptionStateChange(row.userId, payload);
}
```

Under the hood, `subject.key` is `originalTransactionId` for Apple (extracted
from the inner `signedTransactionInfo` JWS server-side) and `purchaseToken` for
Google — exactly the keys you saved at first verify.

##### Verify and webhook can arrive in either order

The verify call (app → your backend → Attesto → Apple/Google) traverses the
network multiple times; the webhook (Apple/Google → Attesto → your backend) is
fired from upstream the moment the transaction commits. **The webhook frequently
wins.** For `INITIAL_BUY` / new-purchase events especially, the webhook beats
verify on most networks — don't assume verify always lands first.

The fix: both handlers **upsert into the same row keyed on
`(platform, subject.key)`**. Verify supplies `userId`; the webhook supplies
status / lifecycle fields. Whichever arrives first writes partial state; the
other completes it.

```typescript
// Webhook handler — tolerate the row not existing yet.
async function handleAttestoWebhook(payload: AttestoWebhookPayload) {
  if (!payload.subject) return; // test / refund — no per-user write

  await db.userPurchases.upsert({
    platform: payload.source,
    key: payload.subject.key,
    productId: payload.subject.productId,
    // userId deliberately not set — verify fills it in (if not already there).
    status: deriveStatus(payload.eventType),
    updatedAt: payload.event.occurredAt,
  });
}
```

Order of arrival no longer matters:

| Order            | After first call           | After second call   | Final state                          |
| ---------------- | -------------------------- | ------------------- | ------------------------------------ |
| Webhook → verify | `{key, productId, status}` | `+ userId`          | Complete                             |
| Verify → webhook | `{key, productId, userId}` | `+ status` (latest) | Complete                             |
| Webhook only     | `{key, productId, status}` | —                   | Orphan — `userId` null until claimed |

::: tip Rows with `userId: null` are not bugs — they're purchases Attesto knows
about that haven't been claimed by a user yet (verify hasn't fired). Surface
them in your support tooling: when a customer reports "I bought but nothing
unlocked", you can find the orphan by `subject.key` and link it manually. :::

**Optional: defer user-facing side effects until both pieces are present.** If
you trigger a welcome email or unlock a feature on `INITIAL_BUY`, fire those
_after_ `userId` gets attached — not inside the webhook handler:

```typescript
// Pseudocode — whatever your ORM exposes for "row was updated" hooks.
onUserPurchaseUpdated((row, prev) => {
  if (!prev.userId && row.userId) {
    sendWelcomeEmail(row.userId, row.productId);
  }
});
```

This guarantees both the entitlement (`userId`) and the lifecycle context
(`productId`, `status`) are present before any customer-visible action.

#### Google subscription upgrades / downgrades — handled for you

When a user moves between SKUs in the same subscription group (monthly → annual,
basic → premium), Google issues a **new** `purchaseToken` and links it to the
previous one via `linkedPurchaseToken` on the new purchase record. **Attesto
resolves this server-side** — when the webhook arrives, Attesto fetches the full
SubscriptionPurchaseV2 from Play API, walks the `linkedPurchaseToken` chain back
to the root, and surfaces the original token as `subject.key` on the outbound
payload.

Net effect for your handler: no special-case logic. The `subject.key` you look
up against your mapping table is always the original token you saved at first
verify, even after multiple upgrades. Save once, look up forever.

### Subscription lifecycle: verify + webhooks together

The strongest pattern uses both:

1. **On purchase**: client → your backend → Attesto verify → grant access (and
   save the mapping per
   [the section above](#mapping-webhook-events-back-to-users))
2. **On renewal/cancel/refund**: Apple/Google → Attesto webhook receiver → your
   backend → look up user via mapping → update subscription state

Verify is the **point-in-time confirmation**; webhooks are the **state-machine
driver**. You'll typically build:

- A `user_purchases` mapping table keyed by
  `(platform, originalTransactionId | purchaseToken)`
- A `subscriptions` table on your side, keyed by user, updated by both verify
  (initial state) and webhooks (every event)
- A read path that checks `expires_at > now()` before granting access

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

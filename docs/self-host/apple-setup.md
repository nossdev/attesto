# Apple setup

End-to-end walkthrough: get the credentials from App Store Connect, install them
in Attesto, and verify a real sandbox transaction.

## What you need from Apple

You'll be collecting four pieces of information:

1. **App Store Connect API key (`.p8` file)** with the "App Manager" or
   "Developer" role
2. **Key ID** — 10-character uppercase alphanumeric (e.g. `ABC1234567`)
3. **Issuer ID** — UUID, shown at the top of the Keys page
4. **Bundle ID** — the app's bundle identifier (e.g. `com.example.app`)

## Step 1 — Generate the App Store Connect API key

In [App Store Connect](https://appstoreconnect.apple.com):

1. Go to **Users and Access → Integrations → App Store Connect API**
2. Click the **In-App Purchase** sub-tab (this is the scope Attesto needs; the
   broader "App Store Connect API" tab gives you a less-scoped key that also
   works but is over-privileged)
3. Click **Generate API Key**
4. Give it a name like `attesto-prod` or `attesto-staging` (this name is only
   for your records — Apple uses the Key ID below)
5. Click **Generate**

::: warning Download the `.p8` file once Apple does **not** allow re-downloading
the `.p8` file. Save it immediately — typically to a password manager. If you
lose it, you must revoke the key and generate a new one. :::

After generation, the page shows:

- **Key ID** — copy this. It's the 10-character uppercase code shown next to the
  key name.
- **Issuer ID** — copy this. It's the UUID shown at the top of the Keys page
  (above the table). The same Issuer ID applies to every key in your team — you
  only need to grab it once.

## Step 2 — Note your bundle ID

The bundle ID is the unique reverse-DNS identifier of your app, e.g.
`com.example.attesto`. You set this when you registered the app in App Store
Connect.

::: info Where to find it

- App Store Connect → My Apps → _your app_ → App Information → Bundle ID
- Or in Xcode: project settings → General → Identity → Bundle Identifier :::

The bundle ID matters because Attesto's JWS verification will reject a
transaction whose embedded `bundleId` doesn't match the tenant's configured
value. This prevents a stolen `.p8` from being used to verify transactions from
a different app.

## Step 3 — Install the credentials

Make sure you have a tenant created first ([Tenants](./tenants) for the
walkthrough). Then run the admin CLI:

```bash
mise run cli -- apple:set-credentials tenant_01HXY... \
  --bundle-id com.example.app \
  --key-id ABC1234567 \
  --issuer-id 57246542-96fe-1a63-e053-0824d011072a \
  --key-path ~/Downloads/AuthKey_ABC1234567.p8 \
  --environment auto
```

For self-hosted Docker installations:

```bash
docker compose exec attesto attesto apple:set-credentials tenant_01HXY... \
  --bundle-id com.example.app \
  --key-id ABC1234567 \
  --issuer-id … \
  --key-path /tmp/AuthKey_ABC1234567.p8 \
  --environment auto
```

(You'll need to copy the `.p8` into the container first via `docker cp`.)

### Options

| Flag            | Meaning                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--bundle-id`   | Must exactly match the app's bundle identifier                                                                                      |
| `--key-id`      | The 10-character uppercase Key ID                                                                                                   |
| `--issuer-id`   | The UUID Issuer ID (one per Apple team)                                                                                             |
| `--key-path`    | Filesystem path to the `.p8` file. Read once, immediately encrypted.                                                                |
| `--environment` | `auto` (default — try prod, fall back to sandbox), `production`, or `sandbox`. Hard-pin to `sandbox` for StoreKit Testing in Xcode. |

### What happens to the `.p8`

The CLI reads the file once into memory, validates it parses as PKCS#8 (throws
clearly if it's an OpenSSL-converted `EC PRIVATE KEY` instead), encrypts the
contents with AES-256-GCM under an HKDF-derived subkey scoped to
`apple_credentials.private_key`, and writes the ciphertext into the
`apple_credentials` table. Plaintext never hits the database; the only on-disk
plaintext is whatever copy of the `.p8` you keep.

Output (a single JSON line):

```json
{
  "tenantId": "tenant_01HXY...",
  "bundleId": "com.example.app",
  "keyId": "ABC1234567",
  "environment": "auto",
  "updatedAt": "2026-04-25T..."
}
```

## Step 4 — Verify a transaction

Make a sandbox purchase first so you have a `transactionId` to test against:

- **TestFlight** — install your app via TestFlight, sign in with a Sandbox Apple
  ID, and complete a purchase. The `transactionId` lands in your
  `Transaction.transactionId` field.
- **StoreKit Testing in Xcode** — configure a `.storekit` file in your Xcode
  project, run on a simulator with that scheme, and complete a purchase. Note:
  StoreKit Testing uses a local CA, so you must `--environment sandbox` rather
  than `auto`.

Then verify:

```bash
curl -X POST http://localhost:8080/v1/apple/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"2000000123456789"}'
```

Successful response (`200 OK`):

```json
{
  "valid": true,
  "environment": "sandbox",
  "transaction": {
    "transactionId": "2000000123456789",
    "originalTransactionId": "2000000000123456",
    "bundleId": "com.example.app",
    "productId": "premium_monthly",
    "purchaseDate": "2026-04-10T14:22:10.000Z",
    "originalPurchaseDate": "2026-01-10T14:22:10.000Z",
    "expiresDate": "2026-05-10T14:22:10.000Z",
    "type": "Auto-Renewable Subscription",
    "inAppOwnershipType": "PURCHASED",
    "quantity": 1,
    "currency": "USD",
    "price": 9990,
    "signedTransactionInfo": "<original JWS from Apple>",
    "rawDecodedPayload": {/* full decoded JWS for power users */}
  }
}
```

The `rawDecodedPayload` contains every field Apple returned, even ones Attesto
doesn't surface in the normalized envelope. Subscribe-renewal edge cases like
`offerType`, `offerIdentifier`, `appAccountToken`, and `webOrderLineItemId` are
all there.

### Negative outcomes (still `200 OK`)

These are domain results (`valid: false`), not transport errors:

| `error`                 | Cause                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `TRANSACTION_NOT_FOUND` | Apple reports the `transactionId` doesn't exist in any environment we tried |
| `BUNDLE_ID_MISMATCH`    | Transaction belongs to a different bundle than the tenant is configured for |

### Transport errors (4xx / 5xx)

| Status | `error`               | Cause                                        |
| ------ | --------------------- | -------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing `transactionId` or body >16KB        |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Apple credentials   |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key       |
| 502    | `APPLE_API_ERROR`     | Upstream Apple returned an unexpected status |

## JWS signature verification

Apple's signed transaction JWS is **cryptographically verified** on every verify
call — not just decoded. Attesto walks the x5c certificate chain in the JWS
header against a pinned set of Apple root CAs (Apple Inc. Root + Root CA G2 +
Root CA G3, bundled with the binary) using
[`@apple/app-store-server-library`'s `SignedDataVerifier`](https://github.com/apple/app-store-server-library-node).

In production (`NODE_ENV=production`), the verifier also performs **OCSP
revocation checks** against Apple's responder. In dev / CI / sandbox-mode, OCSP
is skipped to avoid the ~50ms-per-request roundtrip and to permit running in
environments without outbound Internet access.

This layers on top of TLS to `api.storekit.itunes.apple.com` as defense in depth
— even if your network path to Apple were compromised, a tampered response body
would fail signature verification.

## Common errors

### `apple:set-credentials` fails with "EC PRIVATE KEY format not supported"

Apple gives you a PKCS#8 `.p8` (starts with `-----BEGIN PRIVATE KEY-----`). The
error means the file starts with `-----BEGIN EC PRIVATE KEY-----`, which is the
OpenSSL-converted SEC1 form. **Re-download the original from App Store Connect**
— don't run any `openssl ec` conversions on it.

### `BUNDLE_ID_MISMATCH` despite the right bundle

Re-check the **exact** value with:

- Apple TestFlight (most reliable): the Sandbox transaction shows the bundle in
  the receipt
- Xcode project settings → General → Identity → Bundle Identifier

A common gotcha: a Watch extension or App Clip has its own bundle ID like
`com.example.app.watchkitapp` — those transactions need a separate tenant or
`apple:set-credentials` update.

### `APPLE_API_ERROR` with `details.status: 401`

Most often the `.p8` was revoked in App Store Connect, or the Key ID / Issuer ID
don't match. Verify in Connect that the key is active.

### Verify works in sandbox but `TRANSACTION_NOT_FOUND` in production

Production transactions have separate IDs from sandbox. A sandbox
`transactionId` is not queryable in the production environment and vice versa.
Set `--environment production` (or use `auto`, which falls back correctly) and
retest with a real transaction.

## What's next

- [Webhooks](./webhooks) — register Apple S2S V2 notifications so renewals,
  refunds, and revocations get pushed to your callback
- [Tenants](./tenants) — managing multiple apps / environments / API keys
- [Maintenance](./maintenance) — when and how to rotate the `.p8` key

# Google setup

End-to-end walkthrough: get the credentials from Google Cloud + Play Console,
install them in Attesto, verify a real test purchase. Google's flow has more
moving parts than Apple's — both Cloud Console and Play Console are involved.

## What you need

1. **A Google Cloud service account** with the **Play Android Developer** role
   on the Play Console account that owns your app
2. **The service-account JSON key file**
3. **The app's package name** (`com.example.app`)
4. **A test purchase token** (optional until smoke-test time)

## Step 1 — Create the service account in Google Cloud

In the [Google Cloud Console](https://console.cloud.google.com):

1. **IAM & Admin → Service Accounts** → choose the right project (or create one
   if you haven't yet — it's free)
2. **Create Service Account**
   - Service account name: e.g. `attesto-prod`
   - Description: `Verifies in-app purchases via Attesto`
   - Click **Create and continue**
3. **Grant access** — leave this empty. The role you need is granted in Play
   Console (next step), not in Cloud Console.
4. **Done** → the service account is created with an email like
   `attesto-prod@your-project-12345.iam.gserviceaccount.com`. Copy it.

### Generate the JSON key

5. Click the new service account → **Keys** tab → **Add Key → Create new key →
   JSON**

::: warning Download the JSON once The private key inside this JSON is shown
**only at download time**. If you lose it, you can reissue (creating a new key
file) but cannot re-download the original. Save the file to a password manager.
:::

The downloaded file looks like:

```json
{
  "type": "service_account",
  "project_id": "your-project-12345",
  "private_key_id": "abc123…",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh…\n-----END PRIVATE KEY-----\n",
  "client_email": "attesto-prod@your-project-12345.iam.gserviceaccount.com",
  "client_id": "…",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  …
}
```

## Step 2 — Grant Play Console access

In [Google Play Console](https://play.google.com/console):

1. **Users and permissions** (in the left sidebar; you may need to scroll)
2. **Invite new user** → paste the **service account email** from above
3. **Permissions tab** → grant **app permissions** for the apps you want Attesto
   to verify
   - At minimum: **View app information and download bulk reports** and **View
     financial data, orders, and cancellation survey responses**
   - These cover both subscription and one-shot product verification
4. **Send invitation**

::: tip You don't accept the invitation Service accounts don't have a UI; the
invitation is auto-applied based on their email. Just sending it is enough. :::

The OAuth scope Attesto requests on your behalf is
`https://www.googleapis.com/auth/androidpublisher`. You don't configure this
anywhere — it's baked into every OAuth token exchange.

## Step 3 — Note your package name

Your app's package name is the unique reverse-DNS string you registered. Find it
in:

- Play Console → **All apps** → click your app → **Settings** → **App details**
  → Package name (top of the page)
- Or in the AndroidManifest.xml: `<manifest package="com.example.app">`

## Step 4 — Install the credentials

```bash
mise run cli -- google:set-credentials tenant_01HXY... \
  --package-name com.example.app \
  --service-account-path ~/Downloads/service-account-12345.json \
  --pubsub-audience https://attesto.yourdomain.com/v1/webhooks/google/tenant_01HXY...
```

For self-hosted Docker:

```bash
docker compose exec attesto attesto google:set-credentials tenant_01HXY... \
  --package-name com.example.app \
  --service-account-path /tmp/service-account.json
```

(You'll need `docker cp` first to get the JSON into the container.)

### Options

| Flag                     | Meaning                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `--package-name`         | Must exactly match the app's package                                                                           |
| `--service-account-path` | Filesystem path to the downloaded JSON                                                                         |
| `--pubsub-audience`      | **Strongly recommended** if you'll use Google webhooks. The full callback URL Attesto exposes for this tenant. |

### Why `--pubsub-audience` matters

When set, Attesto rejects any inbound Pub/Sub JWT whose `aud` claim doesn't
match. Without it, Attesto accepts any valid Google-signed JWT — meaning any
Google service account anywhere could in principle POST to your tenant's webhook
endpoint with valid-looking authentication. Set it unless you've restricted your
webhook endpoint via network-layer controls.

The audience is typically the full webhook URL:

```
https://attesto.yourdomain.com/v1/webhooks/google/tenant_01HXY...
```

(Set the same value on the Google Pub/Sub push subscription —
[Webhooks](./webhooks) covers this.)

### What gets stored

The CLI validates the JSON is a real Google service-account file (checks
`type=service_account` + required fields like `client_email` and `private_key`)
**before** encrypting. The full JSON content is encrypted with AES-256-GCM under
an HKDF-derived subkey scoped to `google_credentials.service_account` — distinct
from the Apple `.p8` subkey, so compromise of one plaintext does not weaken the
other.

Output (deliberately omits the raw JSON and the `client_email` to reduce
accidental paste-into-chat risk):

```json
{
  "tenantId": "tenant_01HXY...",
  "packageName": "com.example.app",
  "updatedAt": "2026-04-25T..."
}
```

## Step 5 — Verify a purchase

To get a test purchase token:

1. **Set up a licensed tester account** in Play Console → Settings → License
   testing → add the Google account you'll test with
2. **Create an internal-track or closed-track release** of your app (the tester
   account needs to be in that track's testers list)
3. **Make a purchase** with the tester account in the released app. The client
   receives a `purchaseToken` — it's a long opaque string.

Then verify:

```bash
curl -X POST http://localhost:8080/v1/google/verify \
  -H "Authorization: Bearer $ATTESTO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "<long-opaque-string-from-the-client>",
    "type": "subscription"
  }'
```

### Body fields (all required)

| Field           | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `packageName`   | Must match the tenant's configured package                                    |
| `productId`     | The product / base plan the user bought                                       |
| `purchaseToken` | The opaque token your mobile client received from Google Play Billing Library |
| `type`          | `"subscription"` for auto-renewing subs, `"product"` for one-shot purchases   |

### Subscription response

```json
{
  "valid": true,
  "purchase": {
    "kind": "androidpublisher#subscriptionPurchaseV2",
    "packageName": "com.example.app",
    "productId": "premium_monthly",
    "purchaseToken": "...",
    "startTime": "2026-04-10T14:22:10.000Z",
    "expiryTime": "2026-05-10T14:22:10.000Z",
    "autoRenewing": true,
    "priceCurrencyCode": "USD",
    "priceAmountMicros": "9990000",
    "countryCode": "US",
    "paymentState": null,
    "acknowledgementState": 1,
    "orderId": "GPA.1234-5678-9012-34567",
    "rawResponse": {/* full SubscriptionPurchaseV2 from Google */}
  }
}
```

::: warning Multi-line-item subscriptions The envelope fields (`expiryTime`,
`autoRenewing`, `priceAmountMicros`) reflect **only the first line item**.
Subscriptions with multiple line items (base plan + add-ons) need to consume
`rawResponse.lineItems` directly for full fidelity. :::

### Product (one-shot) response

```json
{
  "valid": true,
  "purchase": {
    "kind": "androidpublisher#productPurchase",
    "packageName": "com.example.app",
    "productId": "gems_100",
    "purchaseToken": "...",
    "purchaseTimeMillis": "1744464130000",
    "purchaseState": 0,
    "consumptionState": 1,
    "acknowledgementState": 1,
    "orderId": "GPA.5678",
    "rawResponse": {/* full ProductPurchase from Google */}
  }
}
```

### Negative outcomes (still `200 OK`)

| `error`                 | Cause                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `PURCHASE_NOT_FOUND`    | Google returned 404 (never existed) or 410 (consumed + gone). The `message` field distinguishes them. |
| `PACKAGE_NAME_MISMATCH` | Request's `packageName` doesn't match the tenant's configured package                                 |

### Transport errors

| Status | `error`               | Cause                                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | Missing required field, `type` not `subscription`/`product`, body >16KB               |
| 400    | `CREDENTIALS_MISSING` | Tenant hasn't configured Google credentials                                           |
| 401    | `UNAUTHENTICATED`     | Missing, malformed, or revoked API key                                                |
| 429    | `RATE_LIMITED`        | Google Play quota exceeded. `details.retryAfterSeconds` if Google sent `Retry-After`. |
| 502    | `GOOGLE_API_ERROR`    | Upstream Google returned an unexpected status (500/503/etc.)                          |

## Common errors

### `GOOGLE_API_ERROR` with `details.status: 401`

The service account isn't granted on the Play Console app. Revisit **Play
Console → Users and permissions** and ensure the service-account email has app
permissions for your app.

### `GOOGLE_API_ERROR` with `details.status: 403`

The service account has Play Console access but is missing the
`androidpublisher` IAM role in Google Cloud, or the API itself isn't enabled for
your project. In Google Cloud Console:

1. **APIs & Services → Library** → search "Google Play Android Developer API" →
   **Enable**
2. **IAM & Admin → IAM** → confirm the service account has at least `Editor` or
   `roles/androidpublisher.user`

### `PURCHASE_NOT_FOUND` for a purchase you _know_ exists

Propagation delay. Google can take up to ~30s post-purchase to make the token
queryable via the Developer API. Wait 30s and retry. If it persists,
double-check the package name and that the purchase was made in a track the
service account has visibility on.

### `RATE_LIMITED` consistently

The free quota is ~200,000 queries/day per package. You're almost certainly not
hitting it from verification calls — check
[Google Cloud Console quotas](https://console.cloud.google.com/iam-admin/quotas)
if you see this consistently. Most often this is misconfiguration causing
retries to spike.

### Service account validation fails

`google:set-credentials` requires `type=service_account` plus `client_email`,
`private_key`, and `token_uri` all present. If you see "not a Google
service-account JSON", you may have downloaded an OAuth client JSON by mistake —
those are superficially similar but missing the required fields. Re-download the
**service account** JSON (not OAuth client JSON).

## What's next

- [Webhooks](./webhooks) — set up Real-Time Developer Notifications via Pub/Sub
- [Tenants](./tenants) — multi-app / multi-environment management
- [Maintenance](./maintenance) — service-account key rotation

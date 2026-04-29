# Setting up a staging tenant alongside production

> **Operator playbook.** When you already have a production tenant for a
> customer and need a parallel staging tenant so they can exercise the Apple
> sandbox flow against your `attesto-staging` deployment, this is the procedure.

Time budget: roughly **20-30 minutes** of active work, plus the customer's
backend dev's own implementation time on their staging deploy.

End state:

- Staging tenant exists on `api-staging.attesto.nossdev.com`
- Same customer Apple `.p8` and bundle ID (no duplication needed)
- Staging-only API key + webhook secret, handed to the customer's backend dev
  for their staging deploy
- App Store Connect routes **sandbox** notifications to staging Attesto and
  **production** notifications to prod Attesto, side by side
- A sandbox tester on a real device can drive a TestFlight purchase end-to-end
  through the staging stack

## The key mental model

Apple's sandbox is **one environment per app**, not per-deployment of your
backend. The split between your staging-Attesto and prod-Attesto happens at the
**webhook URL level**, not at the App Store Connect / product / tester level.

App Store Connect → App Store Server Notifications V2 has **two URL fields** per
app:

| Field                     | Apple sends here when…                     | You point it at…                                                                              |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Production Server URL** | a real (paid) production transaction fires | prod Attesto: `https://api.attesto.nossdev.com/v1/webhooks/apple/<prod_tenant>`               |
| **Sandbox Server URL**    | a sandbox-tester transaction fires         | staging Attesto: `https://api-staging.attesto.nossdev.com/v1/webhooks/apple/<staging_tenant>` |

Sandbox testers' purchases route to one URL, real production transactions route
to the other. Same app, same bundle ID, same products, same `.p8`.

## What you do NOT need

- **Different products in App Store Connect.** Products are global per app —
  sandbox testers and real users see the same SKU IDs. Configured once; both
  environments use them.
- **Different `.p8` / Key ID / Issuer ID.** The IAP-scoped App Store Connect API
  key isn't environment-specific. The same `.p8` you uploaded to prod Attesto
  works on staging Attesto.
- **Different bundle ID or `appAppleId`.** Same app → same identifiers.
- **Separate "staging-only" sandbox testers.** Sandbox testers live at the
  **Apple Developer team** level (App Store Connect → Users and Access → Sandbox
  Testers). The same testers work whether the events route to staging or
  production Attesto.

## Prerequisites

- The customer's prod tenant already exists on `attesto` (note its `tenant_…` ID
  — you'll need it for the App Store Connect Production URL field).
- You have a copy of the customer's `.p8` (the same file you uploaded to prod).
  If you discarded it, ask the customer to re-share.
- The customer's backend dev has a staging endpoint URL they can give you (e.g.
  `https://api-staging.<their-domain>.com/attesto-webhook`). They don't need it
  to be live yet — Attesto's SSRF guard only requires `https://` and a
  non-private host.

## Step 1 — Get the `.p8` onto the staging machine

```bash
# From your laptop. fly sftp puts files into the running machine's filesystem.
fly ssh sftp shell -a attesto-staging
> put /local/path/AuthKey_XXXXXXX.p8 /tmp/key.p8
> exit
```

The file lives in `/tmp/` on the running machine; it'll be deleted at next
deploy. That's fine — Attesto reads it once, encrypts it, and stores ciphertext
in `apple_credentials`.

## Step 2 — Create the staging tenant + API key + Apple credentials

```bash
fly ssh console -a attesto-staging
# (interactive remote shell from here)

attesto tenant:create --name "Acme — Staging"
# → { "id": "tenant_01STG...", ... }   ← capture this; you'll use it everywhere below

# Mint a test-prefix API key. The customer's staging backend uses this.
attesto key:create tenant_01STG... --env test --name "acme-staging-backend"
# → { "rawKey": "attesto_test_...", ... }   ← capture rawKey BEFORE exiting

# Upload Apple credentials. Use the same values as prod EXCEPT --environment.
attesto apple:set-credentials tenant_01STG... \
  --bundle-id com.example.app \
  --key-id <same as prod> \
  --issuer-id <same as prod> \
  --key-path /tmp/key.p8 \
  --environment sandbox \
  --app-apple-id <same numeric App Apple ID as prod>
```

Why `--environment sandbox` and not `auto`? On staging you only ever want to
talk to Apple's sandbox API. `auto` would try production first and fall back;
for a staging tenant that's noise (and on TestFlight pre-launch apps, `auto`
returns 401 from production before falling back, adding extra latency).

## Step 3 — Generate the staging webhook secret + register the callback

Still on the staging shell:

```bash
attesto webhook:set-config tenant_01STG... \
  --callback-url https://api-staging.<their-domain>.com/attesto-webhook \
  --secret "$(openssl rand -base64 32)"

# Confirm it landed:
attesto webhook:get tenant_01STG...
# → { tenantId, callbackUrl, isActive: true, hasSecret: true, ... }
```

**Capture the secret** before closing the SSH session — Attesto stores only the
encrypted blob; you'll need to share the plaintext with the customer's backend
dev. The secret is **different from the prod webhook secret**.

## Step 4 — Configure App Store Connect

In **App Store Connect → the customer's app → App Store Server Notifications**:

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Production Server URL** | `https://api.attesto.nossdev.com/v1/webhooks/apple/<prod_tenant_id>` (don't change if already set correctly) |
| **Sandbox Server URL**    | `https://api-staging.attesto.nossdev.com/v1/webhooks/apple/tenant_01STG...`                                  |
| **Version**               | **Version 2** (both)                                                                                         |

Each environment has its own "Request a Test Notification" button. Click the
**Sandbox** one — within a few seconds:

- Staging Attesto's logs (`fly logs -a attesto-staging`) should show the inbound
  `/v1/webhooks/apple/tenant_01STG...` request returning 200
- The customer's staging callback
  (`https://api-staging.<their-domain>.com/attesto-webhook`) should receive an
  HMAC-signed POST

::: warning Don't fiddle with the Production URL

Once the prod URL is set, leave it. App Store Connect doesn't always propagate
URL changes instantly; events in flight can still hit the old URL for a few
minutes after a change. Touch only the Sandbox URL when you're setting up
staging.

:::

## Step 5 — Hand off staging credentials to the backend dev

Send via secure channel (1Password share, encrypted email, Signal — **not Slack
DMs**):

```
ATTESTO_BASE_URL        = https://api-staging.attesto.nossdev.com
ATTESTO_API_KEY         = attesto_test_…             (from Step 2)
ATTESTO_WEBHOOK_SECRET  = <base64 secret>            (from Step 3)
ATTESTO_WEBHOOK_PATH    = /attesto-webhook           (whatever they exposed)
```

Backend dev wires these into their **staging** environment only. Their prod
environment keeps using the existing prod credentials.

## Step 6 — End-to-end smoke test

On a real iOS device:

1. **Sign in as a sandbox tester** at Settings → App Store → Sandbox Account
   (NOT in the system-level Apple ID settings). Create a new tester in App Store
   Connect → Users and Access → Sandbox Testers if needed.
2. **Install the TestFlight build** of the customer's app.
3. **Make a purchase.** TestFlight purchases with a sandbox tester signed in
   produce sandbox transactions.
4. **Verify the transaction** against staging Attesto:

   ```bash
   curl -X POST https://api-staging.attesto.nossdev.com/v1/apple/verify \
     -H "Authorization: Bearer attesto_test_…" \
     -H "Content-Type: application/json" \
     -d '{"transactionId":"<the txId from the device>"}'
   ```

   Expect `200` with
   `{ "valid": true, "environment": "sandbox", "transaction": { … } }`.

5. **Trigger a webhook event:** App Store Connect → Notifications → click
   **Request a Test Notification (Sandbox)**. Within seconds the customer's
   staging callback should receive the event with a valid `X-Attesto-Signature`
   header.

If both work, the staging stack is wired correctly. The backend dev can iterate
against this until they're satisfied, then you flip to production by swapping
`ATTESTO_BASE_URL` + `ATTESTO_API_KEY` + `ATTESTO_WEBHOOK_SECRET` for the prod
values in their production deploy.

## Caveats / gotchas

- **Sandbox subscriptions accelerate.** Apple compresses subscription periods in
  sandbox: a "1 month" sub renews every 5 minutes, "1 year" every hour. Useful
  for testing renewal events but be ready for the speed.
- **Sandbox testers can only "first-purchase" each SKU once.** Once a tester has
  bought `premium_monthly`, you may need a fresh tester to re-test the
  first-purchase flow. Apple lets you create unlimited sandbox testers (just
  need real-looking unique emails — a `+staging` Gmail alias works).
- **TestFlight + sandbox tester ≠ TestFlight + real Apple ID.** A TestFlight
  install used by a real Apple ID with real billing will produce production
  transactions, not sandbox. Be intentional about which account is signed in at
  the App Store level.
- **StoreKit Testing in Xcode is a third environment.** It uses a local CA and
  never talks to Apple's servers. Useful for unit-testing the client SDK; not
  useful for testing this Attesto integration end-to-end.
- **Same `.p8`, two tenants.** Totally fine. Attesto encrypts each tenant's
  credentials independently with HKDF-derived per-tenant subkeys, so
  cross-tenant leakage isn't a risk.
- **The staging webhook secret is NOT the prod webhook secret.** Keep them
  strictly separated; if you accidentally share the prod secret with the staging
  deploy, the customer's staging code can forge prod-shape signatures.

## What's next

- [Onboarding a tenant](./onboarding) — the full operator playbook for the
  original prod tenant (Phase A through Phase G)
- [Apple setup](./apple-setup) — `apple:set-credentials` flag reference
- [Webhooks (operator setup)](./webhooks) — `webhook:set-config` flag reference
- [Tenants](./tenants) — multi-environment patterns (one-tenant-per-env vs
  one-tenant-per-app)
- [Deployment § Running admin commands on Fly](./deployment#running-admin-commands-on-fly)
  — `fly ssh console` patterns
- [Operations](./operations) — what to monitor on staging Attesto once events
  start flowing

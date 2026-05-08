# Node + Express

A minimal backend skeleton for `@nossdev/iap`, written in Node 20+ with
Express 4.

## Setup

```bash
npm install express
```

```bash
# .env
ATTESTO_URL=https://api.attesto.nossdev.com
ATTESTO_KEY=attesto_live_…
ATTESTO_WEBHOOK_SECRET=<32+ char base64>
```

## Shared helpers

```typescript
// attesto.ts
const ATTESTO_URL = process.env.ATTESTO_URL!;
const ATTESTO_KEY = process.env.ATTESTO_KEY!;

export async function attestoVerifyApple(transactionId: string) {
  const r = await fetch(`${ATTESTO_URL}/v1/apple/verify`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ATTESTO_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transactionId }),
  });
  if (!r.ok) throw new Error(`attesto ${r.status}`);
  return r.json();
}

export async function attestoVerifyGoogle(input: {
  packageName: string;
  productId: string;
  purchaseToken: string;
  type: "subscription" | "product";
}) {
  const r = await fetch(`${ATTESTO_URL}/v1/google/verify`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ATTESTO_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`attesto ${r.status}`);
  return r.json();
}
```

## Entitlement rules (your domain)

```typescript
// entitlements.ts
export interface Entitlement {
  key: string;
  productId: string;
  expiresAt: string | null;
}

const PRODUCT_TO_ENTITLEMENT: Record<string, string> = {
  premium_monthly: "premium",
  premium_yearly: "premium",
  remove_ads: "no_ads",
};

export function deriveEntitlement(
  productId: string,
  expiresAt: string | null,
): Entitlement | null {
  const key = PRODUCT_TO_ENTITLEMENT[productId];
  if (!key) return null;
  if (expiresAt && new Date(expiresAt) <= new Date()) return null;
  return { key, productId, expiresAt };
}
```

```typescript
// userStore.ts — stub; swap for your DB
export const userStore = {
  async getEntitlements(_userId: string): Promise<Entitlement[]> {
    return [];
  },
  async upsertEntitlement(_userId: string, _ent: Entitlement) {},
};
```

## App skeleton

```typescript
// app.ts
import express from "express";
import { attestoVerifyApple, attestoVerifyGoogle } from "./attesto.js";
import { deriveEntitlement, type Entitlement } from "./entitlements.js";
import { userStore } from "./userStore.js";

const app = express();

// Capture the raw body for the webhook route BEFORE express.json().
app.use("/attesto-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Plug in your real auth middleware.
app.use((req, _res, next) => {
  // (req as any).userId = decodeBearer(req.headers.authorization);
  next();
});
```

## verifyApple

```typescript
app.post("/api/iap/verify/apple", async (req, res) => {
  const userId = (req as any).userId;
  const { transactionId, productId } = req.body;

  const result = await attestoVerifyApple(transactionId);

  if (!result.valid) {
    return res.json({
      valid: false,
      error: result.error,
      message: result.message,
    });
  }

  const tx = result.transaction;
  if (tx.productId !== productId) {
    return res.json({
      valid: false,
      error: "PRODUCT_MISMATCH",
      message: "Verified product does not match request",
    });
  }

  const ent = deriveEntitlement(tx.productId, tx.expiresDate);
  if (ent) await userStore.upsertEntitlement(userId, ent);

  res.json({
    valid: true,
    transaction: {
      id: tx.transactionId,
      productId: tx.productId,
      expiresAt: tx.expiresDate,
      verifiedAt: new Date().toISOString(),
    },
    entitlements: ent ? [ent] : [],
  });
});
```

## verifyGoogle

```typescript
app.post("/api/iap/verify/google", async (req, res) => {
  const userId = (req as any).userId;
  const { purchaseToken, productId, packageName, type } = req.body;

  const result = await attestoVerifyGoogle({
    packageName,
    productId,
    purchaseToken,
    type,
  });

  if (!result.valid) {
    return res.json({
      valid: false,
      error: result.error,
      message: result.message,
    });
  }

  const expiresAt = result.purchase?.expiryTime ?? null;
  const ent = deriveEntitlement(productId, expiresAt);
  if (ent) await userStore.upsertEntitlement(userId, ent);

  res.json({
    valid: true,
    transaction: {
      id: purchaseToken,
      productId,
      expiresAt,
      verifiedAt: new Date().toISOString(),
    },
    entitlements: ent ? [ent] : [],
  });
});
```

## products (optional)

iap only calls this when `config.products` is omitted on the client. Useful when
your catalog evolves between releases or varies per user (feature flags,
regional pricing).

```typescript
const PRODUCT_CATALOG = [
  {
    id: "premium_monthly",
    type: "subscription",
    androidPlanId: "monthly-plan",
  },
  { id: "premium_yearly", type: "subscription", androidPlanId: "yearly-plan" },
  { id: "remove_ads", type: "product" },
];

app.get("/api/iap/products", (_req, res) => {
  // Optionally filter by feature flags / region using (req as any).userId.
  res.json({ products: PRODUCT_CATALOG });
});
```

## entitlements

```typescript
app.get("/api/iap/entitlements", async (req, res) => {
  const userId = (req as any).userId;
  const entitlements = await userStore.getEntitlements(userId);
  res.json({ entitlements });
});
```

## restore

```typescript
app.post("/api/iap/restore", async (req, res) => {
  const userId = (req as any).userId;
  const { transactions } = req.body as { transactions: any[] };

  const granted: Entitlement[] = [];
  for (const tx of transactions) {
    try {
      const result = tx.platform === "apple"
        ? await attestoVerifyApple(tx.transactionId)
        : await attestoVerifyGoogle({
          packageName: tx.packageName,
          productId: tx.productId,
          purchaseToken: tx.purchaseToken,
          type: "subscription",
        });

      if (!result.valid) continue;

      const expiresAt = tx.platform === "apple"
        ? result.transaction.expiresDate
        : result.purchase?.expiryTime ?? null;

      const ent = deriveEntitlement(tx.productId, expiresAt);
      if (ent) {
        await userStore.upsertEntitlement(userId, ent);
        granted.push(ent);
      }
    } catch {
      continue;
    }
  }

  res.json({
    valid: true,
    transaction: {
      id: "restore",
      productId: "",
      expiresAt: null,
      verifiedAt: new Date().toISOString(),
    },
    entitlements: granted,
  });
});
```

## Webhook receiver

```typescript
import crypto from "node:crypto";

const SECRET = process.env.ATTESTO_WEBHOOK_SECRET!;
const processed = new Set<string>(); // replace with persistent store

app.post("/attesto-webhook", async (req, res) => {
  const raw = req.body as Buffer;
  const sigHeader = req.header("X-Attesto-Signature") ?? "";
  const eventId = req.header("X-Attesto-Event-Id") ?? "";

  if (!verifySignature(raw, sigHeader, SECRET)) {
    return res.status(401).send("invalid signature");
  }
  if (processed.has(eventId)) return res.status(200).send("already processed");

  const event = JSON.parse(raw.toString());
  try {
    await handleEvent(event);
    processed.add(eventId);
    res.status(200).send("ok");
  } catch (err) {
    console.error("webhook failed", { eventId, err });
    res.status(500).send("retry me"); // Attesto retries on 5xx
  }
});

function verifySignature(raw: Buffer, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(ts) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${raw.toString()}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  // timingSafeEqual throws RangeError if lengths differ — guard first.
  if (expectedBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

async function handleEvent(event: {
  event: string;
  reason: string | null;
  platformEvent: string;
  data: unknown;
}) {
  switch (event.event) {
    case "subscription.purchased":
    case "subscription.renewed":
    case "subscription.recovered":
    case "subscription.cancellation_revoked":
      // grant or extend entitlement
      break;
    case "subscription.expired":
      // revoke. event.reason: "voluntary" | "billing_retry" | "product_not_for_sale" | null
      break;
    case "subscription.refunded":
    case "subscription.revoked":
      // revoke + reverse provisioned content
      break;
    case "subscription.cancellation_scheduled":
      // mark "ending at expiresAt" — DO NOT revoke yet
      break;
    case "subscription.in_grace_period":
    case "subscription.in_billing_retry":
      // keep entitlement live; optionally surface "update payment" CTA
      break;
    case "test":
      // ack 200, no business logic
      break;
    case "unknown":
      console.warn("unrecognized webhook event", event.platformEvent);
      break;
      // Tier 2/3 events (price changes, plan switches, etc.) — see /reference/webhooks#event-types
  }
}

app.listen(8080);
```

## Handle verify/webhook ordering

Two ways to associate a webhook event with one of your users, in order of
preference:

### Recommended: pre-attached `appUserId`

If your iOS / Android app uses
[`@nossdev/iap`](https://www.npmjs.com/package/@nossdev/iap) v0.2+ and passes
`appUserId` to `iap.purchase(...)`, the value travels through StoreKit / Play
Billing and Attesto surfaces it as a top-level `appUserId` on both the verify
response and the webhook payload. Your handlers join on it directly — no upsert
dance, no orphan rows.

Add a `iap_user_uuid` column to your users table (one column, unique, nullable):

```sql
ALTER TABLE users ADD COLUMN iap_user_uuid uuid UNIQUE;
```

Expose a mint-or-lookup endpoint that the iap async fetcher can hit. Auth
middleware is your choice (session cookie, JWT, etc.):

```typescript
import { randomUUID } from "node:crypto";

app.post("/api/iap/uuid", requireAuth, async (req, res) => {
  const userId = req.user.id;
  // Idempotent on (user, iap_user_uuid): mint+save the first time, return
  // the existing UUID on every later call. Keeps iap-side stateless.
  const { rows } = await pool.query(
    `UPDATE users
        SET iap_user_uuid = COALESCE(iap_user_uuid, $1::uuid)
      WHERE id = $2
      RETURNING iap_user_uuid`,
    [randomUUID(), userId],
  );
  res.json({ uuid: rows[0].iap_user_uuid });
});
```

Webhook handler when `appUserId` is set — trivial join:

```typescript
async function handleAttestoWebhook(payload) {
  if (payload.appUserId) {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE iap_user_uuid = $1`,
      [payload.appUserId],
    );
    if (rows[0]) return applySubscriptionStateChange(rows[0].id, payload);
    // Unknown UUID — log for support; falls through.
  }
  return handleByFallback(payload);
}
```

If your app supports purchase-before-account (guest) flows, omit `appUserId`
from the iap.purchase() call for those flows; the fallback section below covers
them.

### Fallback: when `appUserId` is null

For guest purchases or purchases made before your app wired up pre-attach, fall
back to the platform-specific `subject.key`. Both verify and the webhook upsert
into the same row, keyed on `(platform, subject.key)`:

```typescript
// purchases lookup: maps (platform, subject.key) → userId.
// CREATE TABLE purchases (
//   platform    text not null,
//   subject_key text not null,
//   user_id     text,                       -- nullable; webhook may arrive first
//   product_id  text,
//   status      text not null default 'active',
//   updated_at  timestamptz not null default now(),
//   primary key (platform, subject_key)
// );

import { Pool } from "pg";
const pool = new Pool();

export async function upsertPurchase(opts: {
  platform: "apple" | "google";
  subjectKey: string;
  userId?: string; // verify supplies; webhook leaves null
  productId?: string;
  status?: string;
}) {
  await pool.query(
    `INSERT INTO purchases (platform, subject_key, user_id, product_id, status, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), now())
     ON CONFLICT (platform, subject_key) DO UPDATE SET
       user_id    = COALESCE(EXCLUDED.user_id, purchases.user_id),
       product_id = COALESCE(EXCLUDED.product_id, purchases.product_id),
       status     = COALESCE(EXCLUDED.status, purchases.status),
       updated_at = now()`,
    [
      opts.platform,
      opts.subjectKey,
      opts.userId ?? null,
      opts.productId ?? null,
      opts.status ?? null,
    ],
  );
}
```

Call `upsertPurchase` from both verify (with `userId`) and the webhook handler
(with `status` / `productId` from `payload.subject` and `payload.eventType`).
The `COALESCE` clauses let either side fill the row's nulls without overwriting
fields the other side already wrote.

> See
> [Verify and webhook can arrive in either order](/guide/integration#verify-and-webhook-can-arrive-in-either-order)
> for the timing model and order-of-arrival table.

## Notes

- **Raw body for webhooks.** `express.raw()` must run on `/attesto-webhook`
  _before_ `express.json()`. The HMAC is computed over the exact bytes Attesto
  sent — a JSON-parsed-then-restringified body will not match.
- **Auth middleware.** Replace the stub with your real bearer-token decode (JWT,
  opaque session token, etc.). iap sends whatever `getAuthHeaders()` returns;
  your backend decides what to do with it.
- **Persistent idempotency.** The in-memory `Set` will lose state on restart.
  Use a `processed_events(event_id text primary key, processed_at timestamptz)`
  table.

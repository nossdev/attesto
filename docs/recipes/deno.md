# Deno + Hono

A minimal backend skeleton for `@nossdev/iap`, written in Deno 2 with
[Hono](https://hono.dev). Same stack Attesto itself uses, so the patterns
transfer 1:1.

## Setup

```typescript
// deps.ts
export { Hono } from "jsr:@hono/hono@^4.6";
export { z } from "npm:zod@^3.23";
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
const ATTESTO_URL = Deno.env.get("ATTESTO_URL")!;
const ATTESTO_KEY = Deno.env.get("ATTESTO_KEY")!;

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
  return await r.json();
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
  return await r.json();
}
```

## Entitlement rules (your domain)

Attesto answers "is this real?" — your backend decides what that means. A small
example:

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

Replace `userStore` below with your real persistence (Postgres, KV, whatever).

```typescript
// userStore.ts — stub
export const userStore = {
  async getEntitlements(_userId: string): Promise<Entitlement[]> {
    /* … */ return [];
  },
  async upsertEntitlement(_userId: string, _ent: Entitlement) {/* … */},
};
```

## verifyApple

```typescript
// app.ts
import { Hono } from "./deps.ts";
import { attestoVerifyApple, attestoVerifyGoogle } from "./attesto.ts";
import { deriveEntitlement } from "./entitlements.ts";
import { userStore } from "./userStore.ts";

const app = new Hono();

app.post("/api/iap/verify/apple", async (c) => {
  const userId = c.get("userId"); // set by your auth middleware
  const { transactionId, productId } = await c.req.json();

  const result = await attestoVerifyApple(transactionId);

  if (!result.valid) {
    return c.json({
      valid: false,
      error: result.error,
      message: result.message,
    });
  }

  const tx = result.transaction;
  if (tx.productId !== productId) {
    return c.json({
      valid: false,
      error: "PRODUCT_MISMATCH",
      message: "Verified product does not match request",
    });
  }

  const ent = deriveEntitlement(tx.productId, tx.expiresDate);
  if (ent) await userStore.upsertEntitlement(userId, ent);

  return c.json({
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
app.post("/api/iap/verify/google", async (c) => {
  const userId = c.get("userId");
  const { purchaseToken, productId, packageName, type } = await c.req.json();

  const result = await attestoVerifyGoogle({
    packageName,
    productId,
    purchaseToken,
    type,
  });

  if (!result.valid) {
    return c.json({
      valid: false,
      error: result.error,
      message: result.message,
    });
  }

  const expiresAt = result.purchase?.expiryTime ?? null;
  const ent = deriveEntitlement(productId, expiresAt);
  if (ent) await userStore.upsertEntitlement(userId, ent);

  return c.json({
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

app.get("/api/iap/products", (c) => {
  // Optionally filter by feature flags / region using c.get("userId").
  return c.json({ products: PRODUCT_CATALOG });
});
```

## entitlements

```typescript
app.get("/api/iap/entitlements", async (c) => {
  const userId = c.get("userId");
  const entitlements = await userStore.getEntitlements(userId);
  return c.json({ entitlements });
});
```

## restore

```typescript
app.post("/api/iap/restore", async (c) => {
  const userId = c.get("userId");
  const { transactions } = await c.req.json();

  const granted: Entitlement[] = [];
  for (const tx of transactions) {
    try {
      const result = tx.platform === "apple"
        ? await attestoVerifyApple(tx.transactionId)
        : await attestoVerifyGoogle({
          packageName: tx.packageName,
          productId: tx.productId,
          purchaseToken: tx.purchaseToken,
          type: "subscription", // restore doesn't carry type — pick a sane default
        });

      if (!result.valid) continue; // skip dead receipts; restore is best-effort

      const expiresAt = tx.platform === "apple"
        ? result.transaction.expiresDate
        : result.purchase?.expiryTime ?? null;

      const ent = deriveEntitlement(tx.productId, expiresAt);
      if (ent) {
        await userStore.upsertEntitlement(userId, ent);
        granted.push(ent);
      }
    } catch {
      continue; // transient — let the next call refresh
    }
  }

  return c.json({
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

Attesto POSTs verified events with an `X-Attesto-Signature` header. Verify the
HMAC over the **raw body** before doing anything destructive.

```typescript
const SECRET = Deno.env.get("ATTESTO_WEBHOOK_SECRET")!;

app.post("/attesto-webhook", async (c) => {
  const raw = await c.req.text();
  const sigHeader = c.req.header("X-Attesto-Signature") ?? "";
  const eventId = c.req.header("X-Attesto-Event-Id") ?? "";

  if (!await verifySignature(raw, sigHeader, SECRET)) {
    return c.text("invalid signature", 401);
  }

  if (await processedEvents.has(eventId)) {
    return c.text("already processed", 200);
  }

  const event = JSON.parse(raw);
  try {
    await handleEvent(event);
    await processedEvents.add(eventId);
    return c.text("ok", 200);
  } catch {
    return c.text("retry me", 500); // Attesto retries on 5xx
  }
});

async function verifySignature(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2)),
  );
  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(ts) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false; // 5-min replay window

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}.${raw}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

const processedEvents = {
  // replace with a real persistent store
  _set: new Set<string>(),
  has(id: string) {
    return Promise.resolve(this._set.has(id));
  },
  add(id: string) {
    this._set.add(id);
    return Promise.resolve();
  },
};

Deno.serve({ port: 8080 }, app.fetch);
```

## Handle verify/webhook ordering

Two ways to associate a webhook event with one of your users, in order of
preference:

### Recommended: pre-attached `appUserId`

If your iOS / Android app uses
[`@nossdev/iap`](https://www.npmjs.com/package/@nossdev/iap) v0.2+ and passes
`appUserId` to `iap.purchase(...)`, the value travels through StoreKit / Play
Billing and Attesto surfaces it as a top-level `appUserId` on both the verify
response and the webhook payload. Your handlers join on it directly.

Add a `iap_user_uuid` column to your users table (one column, unique, nullable):

```sql
ALTER TABLE users ADD COLUMN iap_user_uuid uuid UNIQUE;
```

Expose a mint-or-lookup endpoint that the iap async fetcher can hit. Auth is
your choice — apply whatever middleware you already use:

```typescript
import postgres from "https://deno.land/x/postgresjs/mod.js";
const sql = postgres(Deno.env.get("DATABASE_URL")!);

app.post("/api/iap/uuid", requireAuth, async (c) => {
  const userId = c.get("userId");
  // Idempotent on (user, iap_user_uuid): mint+save the first time, return
  // the existing UUID on every later call. Keeps iap-side stateless.
  const [row] = await sql`
    UPDATE users
       SET iap_user_uuid = COALESCE(iap_user_uuid, ${crypto.randomUUID()}::uuid)
     WHERE id = ${userId}
     RETURNING iap_user_uuid
  `;
  return c.json({ uuid: row.iap_user_uuid });
});
```

Webhook handler when `appUserId` is set — trivial join:

```typescript
async function handleAttestoWebhook(payload: AttestoWebhookPayload) {
  if (payload.appUserId) {
    const [row] = await sql`
      SELECT id FROM users WHERE iap_user_uuid = ${payload.appUserId}
    `;
    if (row) return applySubscriptionStateChange(row.id, payload);
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

import postgres from "https://deno.land/x/postgresjs/mod.js";
const sql = postgres(Deno.env.get("DATABASE_URL")!);

export async function upsertPurchase(opts: {
  platform: "apple" | "google";
  subjectKey: string;
  userId?: string; // verify supplies; webhook leaves null
  productId?: string;
  status?: string;
}) {
  await sql`
    INSERT INTO purchases (platform, subject_key, user_id, product_id, status, updated_at)
    VALUES (
      ${opts.platform}, ${opts.subjectKey},
      ${opts.userId ?? null}, ${opts.productId ?? null},
      ${opts.status ?? "active"}, now()
    )
    ON CONFLICT (platform, subject_key) DO UPDATE SET
      user_id    = COALESCE(EXCLUDED.user_id, purchases.user_id),
      product_id = COALESCE(EXCLUDED.product_id, purchases.product_id),
      status     = COALESCE(EXCLUDED.status, purchases.status),
      updated_at = now()
  `;
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

- **Auth.** Slot in your own bearer-token middleware that sets
  `c.set("userId", …)`. iap sends whatever `getAuthHeaders()` returns — your
  backend decides what that means.
- **Idempotency.** The example uses an in-memory `Set` for processed events —
  replace with a `processed_events` table on your DB so duplicates survive
  process restarts.
- **Restore best-effort.** Per-receipt failures shouldn't fail the whole batch.
  The library has no per-receipt error surface for restore — invalid receipts
  just don't grant.

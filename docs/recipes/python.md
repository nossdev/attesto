# Python + FastAPI

A minimal backend skeleton for `@nossdev/iap`, written in Python 3.11+ with
FastAPI and httpx.

## Setup

```bash
pip install fastapi uvicorn httpx
```

```bash
# .env
ATTESTO_URL=https://api.attesto.nossdev.com
ATTESTO_KEY=attesto_live_…
ATTESTO_WEBHOOK_SECRET=<32+ char base64>
```

## Shared helpers

```python
# attesto.py
import os, httpx

ATTESTO_URL = os.environ["ATTESTO_URL"]
ATTESTO_KEY = os.environ["ATTESTO_KEY"]

_client = httpx.AsyncClient(timeout=10.0)

async def attesto_verify_apple(transaction_id: str) -> dict:
    r = await _client.post(
        f"{ATTESTO_URL}/v1/apple/verify",
        headers={"Authorization": f"Bearer {ATTESTO_KEY}"},
        json={"transactionId": transaction_id},
    )
    r.raise_for_status()
    return r.json()

async def attesto_verify_google(*, package_name, product_id, purchase_token, type) -> dict:
    r = await _client.post(
        f"{ATTESTO_URL}/v1/google/verify",
        headers={"Authorization": f"Bearer {ATTESTO_KEY}"},
        json={
            "packageName": package_name,
            "productId": product_id,
            "purchaseToken": purchase_token,
            "type": type,
        },
    )
    r.raise_for_status()
    return r.json()
```

## Entitlement rules (your domain)

```python
# entitlements.py
from dataclasses import dataclass
from datetime import datetime, timezone

@dataclass
class Entitlement:
    key: str
    productId: str
    expiresAt: str | None

PRODUCT_TO_ENTITLEMENT = {
    "premium_monthly": "premium",
    "premium_yearly":  "premium",
    "remove_ads":      "no_ads",
}

def derive_entitlement(product_id: str, expires_at: str | None) -> Entitlement | None:
    key = PRODUCT_TO_ENTITLEMENT.get(product_id)
    if key is None:
        return None
    if expires_at and datetime.fromisoformat(expires_at.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        return None
    return Entitlement(key=key, productId=product_id, expiresAt=expires_at)
```

```python
# user_store.py — stub; swap for your DB
class UserStore:
    async def get_entitlements(self, user_id: str) -> list[Entitlement]: return []
    async def upsert(self, user_id: str, ent: Entitlement) -> None: ...

user_store = UserStore()
```

## App skeleton

```python
# main.py
from datetime import datetime, timezone
from fastapi import FastAPI, Request, Header, HTTPException, Depends
from pydantic import BaseModel

from attesto import attesto_verify_apple, attesto_verify_google
from entitlements import derive_entitlement
from user_store import user_store

app = FastAPI()

# Replace with your real auth dependency.
async def current_user(authorization: str = Header(default="")) -> str:
    # user_id = decode_bearer(authorization)
    return "user-stub"
```

## verifyApple

```python
class VerifyAppleBody(BaseModel):
    productId: str
    transactionId: str
    type: str  # 'subscription' | 'product' | 'consumable'

@app.post("/api/iap/verify/apple")
async def verify_apple(body: VerifyAppleBody, user_id: str = Depends(current_user)):
    result = await attesto_verify_apple(body.transactionId)
    if not result["valid"]:
        return {"valid": False, "error": result["error"], "message": result.get("message")}

    tx = result["transaction"]
    if tx["productId"] != body.productId:
        return {"valid": False, "error": "PRODUCT_MISMATCH",
                "message": "Verified product does not match request"}

    ent = derive_entitlement(tx["productId"], tx.get("expiresDate"))
    if ent:
        await user_store.upsert(user_id, ent)

    return {
        "valid": True,
        "transaction": {
            "id": tx["transactionId"],
            "productId": tx["productId"],
            "expiresAt": tx.get("expiresDate"),
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
        },
        "entitlements": [ent.__dict__] if ent else [],
    }
```

## verifyGoogle

```python
class VerifyGoogleBody(BaseModel):
    productId: str
    purchaseToken: str
    packageName: str
    type: str

@app.post("/api/iap/verify/google")
async def verify_google(body: VerifyGoogleBody, user_id: str = Depends(current_user)):
    result = await attesto_verify_google(
        package_name=body.packageName,
        product_id=body.productId,
        purchase_token=body.purchaseToken,
        type=body.type,
    )
    if not result["valid"]:
        return {"valid": False, "error": result["error"], "message": result.get("message")}

    expires_at = (result.get("purchase") or {}).get("expiryTime")
    ent = derive_entitlement(body.productId, expires_at)
    if ent:
        await user_store.upsert(user_id, ent)

    return {
        "valid": True,
        "transaction": {
            "id": body.purchaseToken,
            "productId": body.productId,
            "expiresAt": expires_at,
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
        },
        "entitlements": [ent.__dict__] if ent else [],
    }
```

## products (optional)

iap only calls this when `config.products` is omitted on the client. Useful when
your catalog evolves between releases or varies per user (feature flags,
regional pricing).

```python
PRODUCT_CATALOG = [
    {"id": "premium_monthly", "type": "subscription", "androidPlanId": "monthly-plan"},
    {"id": "premium_yearly",  "type": "subscription", "androidPlanId": "yearly-plan"},
    {"id": "remove_ads",      "type": "product"},
]

@app.get("/api/iap/products")
async def products(_user_id: str = Depends(current_user)):
    # Optionally filter by feature flags / region using user_id.
    return {"products": PRODUCT_CATALOG}
```

## entitlements

```python
@app.get("/api/iap/entitlements")
async def entitlements(user_id: str = Depends(current_user)):
    ents = await user_store.get_entitlements(user_id)
    return {"entitlements": [e.__dict__ for e in ents]}
```

## restore

```python
@app.post("/api/iap/restore")
async def restore(payload: dict, user_id: str = Depends(current_user)):
    granted: list[Entitlement] = []
    for tx in payload.get("transactions", []):
        try:
            if tx["platform"] == "apple":
                result = await attesto_verify_apple(tx["transactionId"])
                expires_at = (result.get("transaction") or {}).get("expiresDate")
            else:
                result = await attesto_verify_google(
                    package_name=tx["packageName"],
                    product_id=tx["productId"],
                    purchase_token=tx["purchaseToken"],
                    type="subscription",
                )
                expires_at = (result.get("purchase") or {}).get("expiryTime")

            if not result.get("valid"):
                continue
            ent = derive_entitlement(tx["productId"], expires_at)
            if ent:
                await user_store.upsert(user_id, ent)
                granted.append(ent)
        except Exception:
            continue

    return {
        "valid": True,
        "transaction": {"id": "restore", "productId": "", "expiresAt": None,
                        "verifiedAt": datetime.now(timezone.utc).isoformat()},
        "entitlements": [e.__dict__ for e in granted],
    }
```

## Webhook receiver

```python
import hmac, hashlib, os, time, json

SECRET = os.environ["ATTESTO_WEBHOOK_SECRET"].encode()
processed: set[str] = set()  # replace with persistent store

@app.post("/attesto-webhook")
async def attesto_webhook(request: Request):
    raw = await request.body()
    sig_header = request.headers.get("X-Attesto-Signature", "")
    event_id = request.headers.get("X-Attesto-Event-Id", "")

    if not verify_signature(raw, sig_header, SECRET):
        raise HTTPException(401, "invalid signature")
    if event_id in processed:
        return "already processed"

    event = json.loads(raw)
    try:
        await handle_event(event)
        processed.add(event_id)
        return "ok"
    except Exception:
        raise HTTPException(500, "retry me")  # Attesto retries on 5xx

def verify_signature(raw: bytes, header: str, secret: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        ts = int(parts.get("t", ""))
    except ValueError:
        return False
    sig = parts.get("v1", "")
    if abs(time.time() - ts) > 300:  # 5-minute replay window
        return False

    payload = f"{ts}.{raw.decode()}".encode()
    expected = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

async def handle_event(event: dict) -> None:
    match event.get("event"):
        case "apple.did_renew" | "google.subscription.renewed":
            pass  # extend matching entitlement
        case "apple.refund" | "google.subscription.cancelled":
            pass  # revoke entitlement
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
your choice — apply whatever dependency you already use:

```python
import os, uuid
import psycopg
from fastapi import APIRouter, Depends

conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
router = APIRouter()

@router.post("/api/iap/uuid")
def mint_or_lookup_uuid(user = Depends(current_user)):
    # Idempotent on (user, iap_user_uuid): mint+save the first time, return
    # the existing UUID on every later call. Keeps iap-side stateless.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE users
               SET iap_user_uuid = COALESCE(iap_user_uuid, %s::uuid)
             WHERE id = %s
             RETURNING iap_user_uuid
            """,
            (str(uuid.uuid4()), user.id),
        )
        row = cur.fetchone()
    return {"uuid": str(row[0])}
```

Webhook handler when `appUserId` is set — trivial join:

```python
async def handle_attesto_webhook(payload: dict) -> None:
    app_user_id = payload.get("appUserId")
    if app_user_id:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM users WHERE iap_user_uuid = %s",
                (app_user_id,),
            )
            row = cur.fetchone()
        if row:
            return await apply_state_change(row[0], payload)
        # Unknown UUID — log for support; falls through.
    return await handle_by_fallback(payload)
```

If your app supports purchase-before-account (guest) flows, omit `appUserId`
from the iap.purchase() call for those flows; the fallback section below covers
them.

### Fallback: when `appUserId` is null

For guest purchases or purchases made before your app wired up pre-attach, fall
back to the platform-specific `subject.key`. Both verify and the webhook upsert
into the same row, keyed on `(platform, subject.key)`:

```python
# purchases lookup: maps (platform, subject.key) → user_id.
# CREATE TABLE purchases (
#     platform    text not null,
#     subject_key text not null,
#     user_id     text,                       -- nullable; webhook may arrive first
#     product_id  text,
#     status      text not null default 'active',
#     updated_at  timestamptz not null default now(),
#     primary key (platform, subject_key)
# );

import os
import psycopg
from typing import Optional

conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)

def upsert_purchase(
    platform: str,
    subject_key: str,
    user_id: Optional[str] = None,        # verify supplies; webhook leaves None
    product_id: Optional[str] = None,
    status: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO purchases (platform, subject_key, user_id, product_id, status, updated_at)
            VALUES (%s, %s, %s, %s, COALESCE(%s, 'active'), now())
            ON CONFLICT (platform, subject_key) DO UPDATE SET
              user_id    = COALESCE(EXCLUDED.user_id, purchases.user_id),
              product_id = COALESCE(EXCLUDED.product_id, purchases.product_id),
              status     = COALESCE(EXCLUDED.status, purchases.status),
              updated_at = now()
            """,
            (platform, subject_key, user_id, product_id, status),
        )
```

Call `upsert_purchase` from both verify (with `user_id`) and the webhook handler
(with `status` / `product_id` from `payload["subject"]` and `payload["event"]`).
The `COALESCE` clauses let either side fill the row's nulls without overwriting
fields the other side already wrote.

> See
> [Verify and webhook can arrive in either order](/guide/integration#verify-and-webhook-can-arrive-in-either-order)
> for the timing model and order-of-arrival table.

## Notes

- **Auth.** The `current_user` dependency is a stub — replace with your real
  bearer-token decode (PyJWT, OAuth2 flows, etc.). iap sends whatever
  `getAuthHeaders()` returns.
- **Raw body.** FastAPI's `await request.body()` returns the unparsed bytes —
  that's what HMAC is computed over. If you `await request.json()` instead,
  you'll re-serialize and the signature won't match.
- **Persistent idempotency.** The in-memory `set` loses state on restart. Use a
  `processed_events` table keyed on `event_id`.

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

## Notes

- **Auth.** The `current_user` dependency is a stub — replace with your real
  bearer-token decode (PyJWT, OAuth2 flows, etc.). iap sends whatever
  `getAuthHeaders()` returns.
- **Raw body.** FastAPI's `await request.body()` returns the unparsed bytes —
  that's what HMAC is computed over. If you `await request.json()` instead,
  you'll re-serialize and the signature won't match.
- **Persistent idempotency.** The in-memory `set` loses state on restart. Use a
  `processed_events` table keyed on `event_id`.

# Error codes

Every Attesto error response uses this envelope:

```json
{
  "valid": false,
  "error": "<error-code>",
  "message": "<human-readable description>",
  "details": { /* optional, error-specific */ }
}
```

The 10 error codes below are the complete vocabulary. Source of truth:
[`app/lib/errors.ts`](https://github.com/nossdev/attesto/blob/main/app/lib/errors.ts).

---

## `UNAUTHENTICATED`

| | |
|---|---|
| **Default status** | 401 |
| **Where it fires** | `app/middleware/auth.ts` |
| **Meaning** | Missing, malformed, or revoked `Authorization` header |
| **Caller action** | Verify the API key prefix is `attesto_live_…` or `attesto_test_…`, the tenant is active, and the key isn't revoked |

Common causes:

- Missing `Authorization` header
- Bearer token missing the `attesto_…` prefix
- Key `revoked_at IS NOT NULL`
- Tenant `is_active = false`

The error message deliberately doesn't distinguish between "key doesn't
exist" and "key was revoked" — the same response surface for both
prevents enumeration attacks.

---

## `TENANT_NOT_FOUND`

| | |
|---|---|
| **Default status** | 404 |
| **Where it fires** | Webhook receivers (`/v1/webhooks/{apple,google}/:tenantId`) |
| **Meaning** | The path's `:tenantId` doesn't correspond to an active tenant |
| **Caller action** | This is Apple/Google misconfigured the webhook URL with a wrong/inactive tenant ID. Update the URL in Connect / Play Console. |

Tenant IDs are validated against the regex
`^tenant_[0-9A-HJKMNP-TV-Z]{26}$` before any DB lookup, so malformed IDs
return `INVALID_REQUEST` instead.

---

## `CREDENTIALS_MISSING`

| | |
|---|---|
| **Default status** | 400 |
| **Where it fires** | Apple verify, Google verify, Apple webhook receiver |
| **Meaning** | The tenant exists but doesn't have credentials configured for this store |
| **Caller action** | Run `apple:set-credentials` or `google:set-credentials` for this tenant |

Webhooks: Apple receivers need credentials because the bundle ID from
the credentials is used as the JWS verification anchor. Without
credentials, we can't verify the signature is for the right app.

---

## `INVALID_REQUEST`

| | |
|---|---|
| **Default status** | 400 |
| **Where it fires** | Every endpoint that validates a body or path param |
| **Meaning** | The request didn't pass schema validation |
| **Caller action** | Check the request shape against the [API reference](/reference/api) |

Common subcases:

- Missing required field in JSON body
- Wrong type (e.g. `transactionId` as number instead of string)
- Body exceeds size limit (16KB on `/v1/*/verify`, 1MB on webhook
  receivers — `details.maxBytes` shows the cap)
- Malformed `tenant_id` in webhook path
- `type` not in `subscription`/`product` for Google verify

When schema validation fails, `details.issues` contains a Zod-formatted
list of all path-level violations:

```json
{
  "valid": false,
  "error": "INVALID_REQUEST",
  "message": "Invalid request body",
  "details": {
    "issues": [
      { "path": ["transactionId"], "message": "Required" }
    ]
  }
}
```

---

## `TRANSACTION_NOT_FOUND`

| | |
|---|---|
| **Default status** | 404 _(see note below)_ |
| **Where it fires** | Apple verify |
| **Meaning** | Apple has no record of this `transactionId` in any environment we tried |

::: warning Returned as `200 OK` with `valid: false`, not 404
Despite the default status of 404 in the error map, this is a **domain
result** for the Apple verify endpoint: the request was valid, the
upstream call succeeded, the answer was just "no such transaction." It's
returned with `200 OK` so callers can distinguish "the request worked
but the answer is no" from "something failed."

`TRANSACTION_NOT_FOUND` only appears as a true 404 if it leaks out of
unexpected paths. The verify endpoint always wraps it in the `200 / valid:false`
envelope.
:::

Common causes:

- Sandbox transaction queried in production environment (or vice versa)
- `transactionId` typo
- Transaction was deleted (rare; can happen for fraudulent purchases
  Apple removes server-side)

The Google equivalent is `PURCHASE_NOT_FOUND`.

---

## `SIGNATURE_INVALID`

| | |
|---|---|
| **Default status** | 401 |
| **Where it fires** | Apple webhook receiver (JWS), Google webhook receiver (OIDC JWT) |
| **Meaning** | Cryptographic origin verification failed |
| **Caller action** | If you genuinely sent the request, check credential / audience configuration. If not — someone is trying to forge events. |

Apple-specific causes:

- The tenant's Apple credentials are stale (rotated `.p8` not yet pushed
  via `apple:set-credentials`)
- Apple has rotated their root certs and the bundled SDK version is out
  of date — upgrade Attesto

Google-specific causes:

- `pubsub_audience` mismatch between tenant config and the JWT's `aud`
- JWT expired (Pub/Sub will retry with a fresh JWT)
- Issuer not `accounts.google.com`

Forged-payload scenarios are extremely rare in practice; the more common
failure is a configuration drift after a credential rotation.

---

## `APPLE_API_ERROR`

| | |
|---|---|
| **Default status** | 502 |
| **Where it fires** | Apple verify |
| **Meaning** | Upstream Apple API returned an unexpected status (not 200, not the documented 404 / errorCode mappings) |
| **Caller action** | Retry with backoff. If persistent, check Apple's system status. |

`details.status` includes the upstream HTTP status, and `details.appleErrorCode`
includes Apple's documented error code if they returned one in the body.

Common scenarios:

- Apple API outage — usually transient
- Tenant's Apple key was revoked from App Store Connect (returns 401
  upstream)
- Apple's IP changed and your network is blocking the new range

---

## `GOOGLE_API_ERROR`

| | |
|---|---|
| **Default status** | 502 |
| **Where it fires** | Google verify |
| **Meaning** | Upstream Google API returned an unexpected status |
| **Caller action** | Retry with backoff. If persistent, check Google Cloud status. |

`details.status` includes the upstream HTTP status. Common upstream
status codes:

| Upstream status | Cause |
|---|---|
| 401 | Service account isn't granted on the Play Console app |
| 403 | Service account missing `androidpublisher` IAM role, or API not enabled in Cloud project |
| 5xx | Google outage |

Distinct from `PURCHASE_NOT_FOUND` (which is a domain result returned as
`200 OK`).

---

## `RATE_LIMITED`

| | |
|---|---|
| **Default status** | 429 |
| **Response header** | `Retry-After: <seconds>` |
| **Where it fires** | Rate-limit middleware (per-tenant token bucket), and as upstream-mapped from Google's 429 |
| **Caller action** | Wait the seconds in `Retry-After` (or `details.retryAfterSeconds`), then retry |

Two distinct sources:

1. **Attesto's per-tenant rate limit** — bucket exhausted. Bump
   `RATE_LIMIT_BURST` if this is a normal-traffic surprise.
2. **Google upstream quota** — rare in practice (default quota is
   ~200K queries/day per package). When it does happen, Attesto
   forwards Google's `Retry-After`.

The response always includes `details.retryAfterSeconds` as a number.

---

## `INTERNAL_ERROR`

| | |
|---|---|
| **Default status** | 500 |
| **Where it fires** | Last-resort catch-all in the error middleware |
| **Meaning** | Something unexpected went wrong; not a known failure mode |
| **Caller action** | Note the `X-Request-Id`; correlate with server logs |

When this happens, the response body deliberately omits stack traces in
production (`NODE_ENV=production`). Logs include `errorClass` (the JS
constructor name) but not the message, to avoid leaking driver-internal
or path information to error aggregators.

In dev (`NODE_ENV=development`), the response includes the message and
stack for easier debugging.

If you see `INTERNAL_ERROR` in production, please open an issue with:

- The `X-Request-Id` from the response
- A timestamp and rough traffic context
- (server-side) the matching log line for that request ID

---

## Status code summary

A condensed lookup table:

| Status | Codes |
|---|---|
| 400 | `INVALID_REQUEST`, `CREDENTIALS_MISSING` |
| 401 | `UNAUTHENTICATED`, `SIGNATURE_INVALID` |
| 404 | `TENANT_NOT_FOUND` (`TRANSACTION_NOT_FOUND` returned as 200 in normal use) |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |
| 502 | `APPLE_API_ERROR`, `GOOGLE_API_ERROR` |

## Custom statuses

`AppError` accepts a `status` override at construction time, so a route
can map an error code to a different status if the default doesn't suit
the context. For example, a webhook receiver might emit
`AppError(SIGNATURE_INVALID, …, { status: 403 })` instead of the default
401 — though in practice we don't currently override.

The list above reflects the current behavior. If you write a new route
and need a custom status, prefer adding a new error code over overriding
status on an existing one.

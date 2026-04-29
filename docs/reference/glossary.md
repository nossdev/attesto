# Glossary

Plain-language definitions of acronyms and terms that appear elsewhere in these
docs. Each entry links to the relevant authoritative spec when one exists.

## Cryptography

### HMAC

**Hash-based Message Authentication Code.** A symmetric algorithm that combines
a secret key with a message hash (here, SHA-256) to prove the message came from
someone holding the key and wasn't tampered with in transit. Attesto uses
HMAC-SHA256 to sign every outbound webhook delivery; your callback verifies with
the shared secret. See
[RFC 2104](https://datatracker.ietf.org/doc/html/rfc2104).

### HKDF

**HMAC-based Key Derivation Function.** A standard way to derive multiple
distinct subkeys from one master key. Attesto's credential vault uses one master
encryption key but derives a per-context subkey for each column
(`apple_credentials.private_key`, `google_credentials.service_account`,
`webhook_configs.secret`). Plaintext compromise of one column doesn't weaken the
others. See [RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869).

### JWT

**JSON Web Token.** A signed JSON payload carrying claims (`iss`, `aud`, `exp`,
etc.). Attesto issues short-lived JWTs to call Apple's App Store Server API. See
[RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519).

### JWS

**JSON Web Signature.** The signed-token format JWTs use under the hood. Apple's
App Store Server Notifications V2 deliver each event as a `signedPayload` JWS
containing the event JSON plus an `x5c` certificate chain. Attesto verifies the
chain before trusting the payload. See
[RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515).

### x5c

The `x5c` header parameter in a JWS holds the **X.509 certificate chain** that
signed the token. Apple includes their full chain (leaf → intermediate → root)
so verifiers can confirm the leaf certificate is rooted in a trusted Apple CA.
See
[RFC 7515 §4.1.6](https://datatracker.ietf.org/doc/html/rfc7515#section-4.1.6).

### OCSP

**Online Certificate Status Protocol.** A live revocation check: "is this X.509
certificate still valid right now, or has it been revoked since issuance?"
Attesto runs OCSP checks against Apple's responder during JWS verification in
production. See [RFC 6960](https://datatracker.ietf.org/doc/html/rfc6960).

### OIDC

**OpenID Connect.** An authentication layer built on OAuth 2.0; the relevant
artifact is an OIDC JWT signed by an identity provider. Google Pub/Sub push
subscriptions authenticate to Attesto by attaching an OIDC JWT signed by Google;
Attesto verifies it against Google's [JWKS](#jwks) before processing the
message. See [openid.net/connect](https://openid.net/connect/).

### JWKS

**JSON Web Key Set.** A standardized JSON document containing public keys for
verifying signatures. Attesto fetches Google's JWKS from
`oauth2.googleapis.com/oauth2/v3/certs` (cached for 1 hour) to verify OIDC
tokens on inbound Pub/Sub pushes. See
[RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517).

## Apple / Google specifics

### S2S V2

**Apple Server-to-Server Notifications, version 2.** Apple's webhook protocol
for IAP events (renewals, refunds, billing retries, etc.). V2 delivers each
event as a JWS-signed payload. V1 is deprecated and not supported by Attesto.
See
[Apple's docs](https://developer.apple.com/documentation/appstoreservernotifications).

### RTDN

**Real-Time Developer Notifications.** Google Play's webhook system for Android
IAP events. Google publishes events to a Pub/Sub topic in your Google Cloud
project; Pub/Sub then pushes (with OIDC auth) to Attesto. See
[Google's docs](https://developer.android.com/google/play/billing/rtdn-reference).

### Pub/Sub

**Google Cloud Pub/Sub.** A message-broker service used as the transport for
Google Play RTDN. You create a topic, subscribe Attesto's webhook URL with
push-delivery + OIDC authentication, and tell Play Console to publish RTDN
events there.

## Project-specific

### ULID

**Universally Unique Lexicographically Sortable Identifier.** A 26-character
timestamp-prefixed alternative to UUIDv4: lexicographic sort order matches
creation time, which makes pagination and audit-trail queries simpler. Attesto
IDs (`tenant_<26 chars>`, `key_<26 chars>`, `evt_<26 chars>`) are
ULID-formatted. See [github.com/ulid/spec](https://github.com/ulid/spec).

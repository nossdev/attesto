# Ruby + Sinatra

A minimal backend skeleton for `@nossdev/iap`, written in Ruby 3.2+ with
Sinatra. Rails users: the same handlers drop into controllers — see notes at the
end.

## Setup

```bash
gem install sinatra puma json
```

```bash
# .env
ATTESTO_URL=https://api.attesto.nossdev.com
ATTESTO_KEY=attesto_live_…
ATTESTO_WEBHOOK_SECRET=<32+ char base64>
```

## Shared client

```ruby
# attesto.rb
require "net/http"
require "json"
require "uri"

module Attesto
  URL = ENV.fetch("ATTESTO_URL")
  KEY = ENV.fetch("ATTESTO_KEY")

  module_function

  def verify_apple(transaction_id)
    post("/v1/apple/verify", { transactionId: transaction_id })
  end

  def verify_google(package_name:, product_id:, purchase_token:, type:)
    post("/v1/google/verify", {
      packageName: package_name,
      productId: product_id,
      purchaseToken: purchase_token,
      type: type,
    })
  end

  def post(path, body)
    uri = URI.join(URL, path)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == "https")
    http.read_timeout = 10

    req = Net::HTTP::Post.new(uri)
    req["Authorization"] = "Bearer #{KEY}"
    req["Content-Type"]  = "application/json"
    req.body = body.to_json

    res = http.request(req)
    raise "attesto #{res.code}" unless res.code.to_i.between?(200, 299)
    JSON.parse(res.body)
  end
end
```

## Entitlement rules (your domain)

```ruby
# entitlements.rb
require "time"

Entitlement = Struct.new(:key, :productId, :expiresAt, keyword_init: true) do
  def to_h = { key:, productId:, expiresAt: }
end

PRODUCT_TO_ENTITLEMENT = {
  "premium_monthly" => "premium",
  "premium_yearly"  => "premium",
  "remove_ads"      => "no_ads",
}.freeze

def derive_entitlement(product_id, expires_at)
  key = PRODUCT_TO_ENTITLEMENT[product_id]
  return nil unless key
  return nil if expires_at && Time.iso8601(expires_at) <= Time.now
  Entitlement.new(key:, productId: product_id, expiresAt: expires_at)
end
```

```ruby
# user_store.rb — stub
module UserStore
  module_function
  def get_entitlements(_user_id) = []
  def upsert(_user_id, _ent); end
end
```

## App skeleton

```ruby
# app.rb
require "sinatra"
require "json"
require_relative "attesto"
require_relative "entitlements"
require_relative "user_store"

set :default_content_type, "application/json"

before do
  # @user_id = decode_bearer(request.env["HTTP_AUTHORIZATION"])
  @user_id = "user-stub"
end

helpers do
  def parse_body
    request.body.rewind
    JSON.parse(request.body.read)
  end
end
```

## verifyApple

```ruby
post "/api/iap/verify/apple" do
  body = parse_body
  result = Attesto.verify_apple(body["transactionId"])

  if !result["valid"]
    return { valid: false, error: result["error"], message: result["message"] }.to_json
  end

  tx = result["transaction"]
  if tx["productId"] != body["productId"]
    return {
      valid: false,
      error: "PRODUCT_MISMATCH",
      message: "Verified product does not match request",
    }.to_json
  end

  ent = derive_entitlement(tx["productId"], tx["expiresDate"])
  UserStore.upsert(@user_id, ent) if ent

  {
    valid: true,
    transaction: {
      id: tx["transactionId"],
      productId: tx["productId"],
      expiresAt: tx["expiresDate"],
      verifiedAt: Time.now.utc.iso8601,
    },
    entitlements: ent ? [ent.to_h] : [],
  }.to_json
end
```

## verifyGoogle

```ruby
post "/api/iap/verify/google" do
  body = parse_body
  result = Attesto.verify_google(
    package_name:   body["packageName"],
    product_id:     body["productId"],
    purchase_token: body["purchaseToken"],
    type:           body["type"],
  )

  if !result["valid"]
    return { valid: false, error: result["error"], message: result["message"] }.to_json
  end

  expires_at = result.dig("purchase", "expiryTime")
  ent = derive_entitlement(body["productId"], expires_at)
  UserStore.upsert(@user_id, ent) if ent

  {
    valid: true,
    transaction: {
      id: body["purchaseToken"],
      productId: body["productId"],
      expiresAt: expires_at,
      verifiedAt: Time.now.utc.iso8601,
    },
    entitlements: ent ? [ent.to_h] : [],
  }.to_json
end
```

## products (optional)

iap only calls this when `config.products` is omitted on the client. Useful when
your catalog evolves between releases or varies per user (feature flags,
regional pricing).

```ruby
PRODUCT_CATALOG = [
  { id: "premium_monthly", type: "subscription", androidPlanId: "monthly-plan" },
  { id: "premium_yearly",  type: "subscription", androidPlanId: "yearly-plan" },
  { id: "remove_ads",      type: "product" },
].freeze

get "/api/iap/products" do
  # Optionally filter by feature flags / region using @user_id.
  { products: PRODUCT_CATALOG }.to_json
end
```

## entitlements

```ruby
get "/api/iap/entitlements" do
  ents = UserStore.get_entitlements(@user_id)
  { entitlements: ents.map(&:to_h) }.to_json
end
```

## restore

```ruby
post "/api/iap/restore" do
  body = parse_body
  granted = []

  (body["transactions"] || []).each do |tx|
    begin
      result =
        if tx["platform"] == "apple"
          Attesto.verify_apple(tx["transactionId"])
        else
          Attesto.verify_google(
            package_name:   tx["packageName"],
            product_id:     tx["productId"],
            purchase_token: tx["purchaseToken"],
            type:           "subscription",
          )
        end

      next unless result["valid"]

      expires_at = tx["platform"] == "apple" \
        ? result.dig("transaction", "expiresDate") \
        : result.dig("purchase", "expiryTime")

      ent = derive_entitlement(tx["productId"], expires_at)
      if ent
        UserStore.upsert(@user_id, ent)
        granted << ent
      end
    rescue StandardError
      next
    end
  end

  {
    valid: true,
    transaction: { id: "restore", productId: "", expiresAt: nil, verifiedAt: Time.now.utc.iso8601 },
    entitlements: granted.map(&:to_h),
  }.to_json
end
```

## Webhook receiver

```ruby
require "openssl"
require "set"

WEBHOOK_SECRET = ENV.fetch("ATTESTO_WEBHOOK_SECRET")
$processed = Set.new # replace with persistent store

post "/attesto-webhook" do
  request.body.rewind
  raw = request.body.read
  sig_header = request.env["HTTP_X_ATTESTO_SIGNATURE"].to_s
  event_id   = request.env["HTTP_X_ATTESTO_EVENT_ID"].to_s

  halt 401, "invalid signature" unless verify_signature(raw, sig_header, WEBHOOK_SECRET)
  return "already processed" if $processed.include?(event_id)

  event = JSON.parse(raw)
  begin
    handle_event(event)
    $processed << event_id
    "ok"
  rescue StandardError
    halt 500, "retry me" # Attesto retries on 5xx
  end
end

def verify_signature(raw, header, secret)
  parts = header.split(",").to_h { |p| p.split("=", 2) }
  ts  = parts["t"].to_i
  sig = parts["v1"].to_s
  return false if ts.zero? || sig.empty?
  return false if (Time.now.to_i - ts).abs > 300 # 5-minute replay window

  expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{ts}.#{raw}")
  secure_compare(expected, sig)
end

def secure_compare(a, b)
  return false unless a.bytesize == b.bytesize
  l = a.unpack("C*")
  r = 0
  b.each_byte.with_index { |byte, i| r |= byte ^ l[i] }
  r.zero?
end

def handle_event(event)
  case event["event"]
  when "subscription.purchased",
       "subscription.renewed",
       "subscription.recovered",
       "subscription.cancellation_revoked"
    # grant or extend entitlement
  when "subscription.expired"
    # revoke. event["reason"]: "voluntary" | "billing_retry" | "product_not_for_sale" | nil
  when "subscription.refunded", "subscription.revoked"
    # revoke + reverse provisioned content
  when "subscription.cancellation_scheduled"
    # mark "ending at expiresAt" — DO NOT revoke yet
  when "subscription.in_grace_period", "subscription.in_billing_retry"
    # keep entitlement live; optionally surface "update payment" CTA
  when "test"
    # ack 200, no business logic
  when "unknown"
    warn "unrecognized webhook event: #{event["platformEvent"]}"
    # Tier 2/3 events (price changes, plan switches, etc.) — see /reference/webhooks#event-types
  end
end
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
your choice — apply whatever before-block / Rails action filter you already use:

```ruby
require "securerandom"
require "pg"

DB = PG.connect(ENV.fetch("DATABASE_URL"))

post "/api/iap/uuid" do
  protected!  # your auth helper; sets @current_user
  # Idempotent on (user, iap_user_uuid): mint+save the first time, return
  # the existing UUID on every later call. Keeps iap-side stateless.
  res = DB.exec_params(<<~SQL, [SecureRandom.uuid, @current_user.id])
    UPDATE users
       SET iap_user_uuid = COALESCE(iap_user_uuid, $1::uuid)
     WHERE id = $2
     RETURNING iap_user_uuid
  SQL
  content_type :json
  { uuid: res.first["iap_user_uuid"] }.to_json
end
```

Webhook handler when `appUserId` is set — trivial join:

```ruby
def handle_attesto_webhook(payload)
  if payload["appUserId"]
    res = DB.exec_params(
      "SELECT id FROM users WHERE iap_user_uuid = $1",
      [payload["appUserId"]],
    )
    if res.ntuples > 0
      return apply_state_change(res.first["id"], payload)
    end
    # Unknown UUID — log for support; falls through.
  end
  handle_by_fallback(payload)
end
```

If your app supports purchase-before-account (guest) flows, omit `appUserId`
from the iap.purchase() call for those flows; the fallback section below covers
them.

### Fallback: when `appUserId` is null

For guest purchases or purchases made before your app wired up pre-attach, fall
back to the platform-specific `subject.key`. Both verify and the webhook upsert
into the same row, keyed on `(platform, subject.key)`:

```ruby
# purchases lookup: maps (platform, subject.key) → user_id.
# CREATE TABLE purchases (
#   platform    text not null,
#   subject_key text not null,
#   user_id     text,                        -- nullable; webhook may arrive first
#   product_id  text,
#   status      text not null default 'active',
#   updated_at  timestamptz not null default now(),
#   primary key (platform, subject_key)
# );

require "pg"

DB = PG.connect(ENV.fetch("DATABASE_URL"))

def upsert_purchase(platform:, subject_key:, user_id: nil, product_id: nil, status: nil)
  DB.exec_params(<<~SQL, [platform, subject_key, user_id, product_id, status])
    INSERT INTO purchases (platform, subject_key, user_id, product_id, status, updated_at)
    VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), now())
    ON CONFLICT (platform, subject_key) DO UPDATE SET
      user_id    = COALESCE(EXCLUDED.user_id, purchases.user_id),
      product_id = COALESCE(EXCLUDED.product_id, purchases.product_id),
      status     = COALESCE(EXCLUDED.status, purchases.status),
      updated_at = now()
  SQL
end
```

Call `upsert_purchase` from both verify (with `user_id:`) and the webhook
handler (with `status:` / `product_id:` from `payload["subject"]` and
`payload["event"]`). The `COALESCE` clauses let either side fill the row's nulls
without overwriting fields the other side already wrote.

> See
> [Verify and webhook can arrive in either order](/guide/integration#verify-and-webhook-can-arrive-in-either-order)
> for the timing model and order-of-arrival table.

## Notes

- **Rails users.** Drop the verify/entitlements/restore handlers into a
  controller; for the webhook, set
  `skip_before_action :verify_authenticity_token` on the webhook action and read
  `request.raw_post` instead of `request.body.read` (Rails sometimes parses JSON
  before reaching the controller).
- **Auth.** Replace the `before` block stub with your real bearer-token decode.
- **Persistent idempotency.** The in-memory `Set` loses state on restart and
  across processes. Persist `event_id` to a `processed_events` table.

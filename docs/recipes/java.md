# Java + Spring Boot

A minimal backend skeleton for `@nossdev/iap`, written in Java 17+ with Spring
Boot 3.

## Setup

```xml
<!-- pom.xml — relevant deps -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-webflux</artifactId>
</dependency>
```

```bash
# .env or application.properties
ATTESTO_URL=https://api.attesto.nossdev.com
ATTESTO_KEY=attesto_live_…
ATTESTO_WEBHOOK_SECRET=<32+ char base64>
```

## Shared client

```java
// AttestoClient.java
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import java.util.Map;

@Component
public class AttestoClient {
  private final WebClient client;

  public AttestoClient(@Value("${ATTESTO_URL}") String url,
                       @Value("${ATTESTO_KEY}") String key) {
    this.client = WebClient.builder()
      .baseUrl(url)
      .defaultHeader("Authorization", "Bearer " + key)
      .build();
  }

  public Mono<Map<String, Object>> verifyApple(String transactionId) {
    return client.post().uri("/v1/apple/verify")
      .bodyValue(Map.of("transactionId", transactionId))
      .retrieve()
      .bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
  }

  public Mono<Map<String, Object>> verifyGoogle(String packageName, String productId,
                                                String purchaseToken, String type) {
    return client.post().uri("/v1/google/verify")
      .bodyValue(Map.of(
        "packageName", packageName,
        "productId", productId,
        "purchaseToken", purchaseToken,
        "type", type))
      .retrieve()
      .bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
  }
}
```

## Entitlement rules (your domain)

```java
// Entitlement.java
public record Entitlement(String key, String productId, String expiresAt) {}

// EntitlementRules.java
import java.time.Instant;
import java.util.Map;

public final class EntitlementRules {
  private static final Map<String, String> PRODUCT_TO_ENTITLEMENT = Map.of(
    "premium_monthly", "premium",
    "premium_yearly",  "premium",
    "remove_ads",      "no_ads"
  );

  public static Entitlement derive(String productId, String expiresAt) {
    String key = PRODUCT_TO_ENTITLEMENT.get(productId);
    if (key == null) return null;
    if (expiresAt != null && Instant.parse(expiresAt).isBefore(Instant.now())) return null;
    return new Entitlement(key, productId, expiresAt);
  }
}
```

```java
// UserStore.java — interface; wire to your DB
public interface UserStore {
  java.util.List<Entitlement> getEntitlements(String userId);
  void upsert(String userId, Entitlement ent);
}
```

## verifyApple + verifyGoogle

```java
// IapController.java
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/iap")
public class IapController {
  private final AttestoClient attesto;
  private final UserStore userStore;

  public IapController(AttestoClient attesto, UserStore userStore) {
    this.attesto = attesto;
    this.userStore = userStore;
  }

  public record VerifyAppleBody(String productId, String transactionId, String type) {}
  public record VerifyGoogleBody(String productId, String purchaseToken,
                                 String packageName, String type) {}

  @PostMapping("/verify/apple")
  public Mono<Map<String, Object>> verifyApple(
      @RequestHeader("Authorization") String authz,
      @RequestBody VerifyAppleBody body) {
    String userId = resolveUser(authz);

    return attesto.verifyApple(body.transactionId()).map(result -> {
      if (!Boolean.TRUE.equals(result.get("valid"))) {
        return failureResponse(result);
      }
      Map<String, Object> tx = (Map<String, Object>) result.get("transaction");
      if (!body.productId().equals(tx.get("productId"))) {
        return Map.of(
          "valid", false,
          "error", "PRODUCT_MISMATCH",
          "message", "Verified product does not match request");
      }

      String expiresAt = (String) tx.get("expiresDate");
      Entitlement ent = EntitlementRules.derive((String) tx.get("productId"), expiresAt);
      if (ent != null) userStore.upsert(userId, ent);

      return successResponse((String) tx.get("transactionId"),
                             (String) tx.get("productId"),
                             expiresAt, ent);
    });
  }

  @PostMapping("/verify/google")
  public Mono<Map<String, Object>> verifyGoogle(
      @RequestHeader("Authorization") String authz,
      @RequestBody VerifyGoogleBody body) {
    String userId = resolveUser(authz);

    return attesto.verifyGoogle(body.packageName(), body.productId(),
                                body.purchaseToken(), body.type())
      .map(result -> {
        if (!Boolean.TRUE.equals(result.get("valid"))) {
          return failureResponse(result);
        }
        Map<String, Object> purchase = (Map<String, Object>) result.get("purchase");
        String expiresAt = purchase != null ? (String) purchase.get("expiryTime") : null;
        Entitlement ent = EntitlementRules.derive(body.productId(), expiresAt);
        if (ent != null) userStore.upsert(userId, ent);

        return successResponse(body.purchaseToken(), body.productId(), expiresAt, ent);
      });
  }

  private Map<String, Object> successResponse(String id, String productId,
                                              String expiresAt, Entitlement ent) {
    Map<String, Object> tx = new LinkedHashMap<>();
    tx.put("id", id);
    tx.put("productId", productId);
    tx.put("expiresAt", expiresAt);
    tx.put("verifiedAt", Instant.now().toString());

    Map<String, Object> resp = new LinkedHashMap<>();
    resp.put("valid", true);
    resp.put("transaction", tx);
    resp.put("entitlements", ent != null ? List.of(ent) : List.of());
    return resp;
  }

  private Map<String, Object> failureResponse(Map<String, Object> result) {
    Map<String, Object> resp = new LinkedHashMap<>();
    resp.put("valid", false);
    resp.put("error", result.get("error"));
    resp.put("message", result.get("message"));
    return resp;
  }

  private String resolveUser(String authz) {
    // decode bearer token → user id
    return "user-stub";
  }
}
```

## products (optional)

iap only calls this when `config.products` is omitted on the client. Useful when
your catalog evolves between releases or varies per user (feature flags,
regional pricing).

```java
private static final List<Map<String, Object>> PRODUCT_CATALOG = List.of(
  Map.of("id", "premium_monthly", "type", "subscription", "androidPlanId", "monthly-plan"),
  Map.of("id", "premium_yearly",  "type", "subscription", "androidPlanId", "yearly-plan"),
  Map.of("id", "remove_ads",      "type", "product")
);

@GetMapping("/products")
public Map<String, Object> products(@RequestHeader("Authorization") String authz) {
  // Optionally filter by feature flags / region using resolveUser(authz).
  return Map.of("products", PRODUCT_CATALOG);
}
```

## entitlements

```java
@GetMapping("/entitlements")
public Map<String, Object> entitlements(@RequestHeader("Authorization") String authz) {
  String userId = resolveUser(authz);
  return Map.of("entitlements", userStore.getEntitlements(userId));
}
```

## restore

```java
public record RestoreBody(List<Map<String, Object>> transactions) {}

@PostMapping("/restore")
public Mono<Map<String, Object>> restore(
    @RequestHeader("Authorization") String authz,
    @RequestBody RestoreBody body) {
  String userId = resolveUser(authz);

  return reactor.core.publisher.Flux.fromIterable(body.transactions())
    .flatMap(tx -> verifyOne(tx)
      .filter(result -> Boolean.TRUE.equals(result.get("valid")))
      .map(result -> {
        String productId = (String) tx.get("productId");
        String expiresAt = "apple".equals(tx.get("platform"))
          ? (String) ((Map<String, Object>) result.get("transaction")).get("expiresDate")
          : (String) ((Map<String, Object>) result.get("purchase")).get("expiryTime");
        Entitlement ent = EntitlementRules.derive(productId, expiresAt);
        if (ent != null) userStore.upsert(userId, ent);
        return ent;
      })
      .filter(java.util.Objects::nonNull)
      .onErrorResume(e -> Mono.empty()))
    .collectList()
    .map(granted -> {
      Map<String, Object> tx = Map.of(
        "id", "restore", "productId", "",
        "expiresAt", null, "verifiedAt", Instant.now().toString());
      Map<String, Object> resp = new LinkedHashMap<>();
      resp.put("valid", true);
      resp.put("transaction", tx);
      resp.put("entitlements", granted);
      return resp;
    });
}

private Mono<Map<String, Object>> verifyOne(Map<String, Object> tx) {
  if ("apple".equals(tx.get("platform"))) {
    return attesto.verifyApple((String) tx.get("transactionId"));
  }
  return attesto.verifyGoogle(
    (String) tx.get("packageName"),
    (String) tx.get("productId"),
    (String) tx.get("purchaseToken"),
    "subscription");
}
```

## Webhook receiver

```java
// AttestoWebhookController.java
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class AttestoWebhookController {
  @Value("${ATTESTO_WEBHOOK_SECRET}") private String secret;
  private final Set<String> processed = ConcurrentHashMap.newKeySet(); // replace with persistent store

  @PostMapping("/attesto-webhook")
  public ResponseEntity<String> webhook(
      @RequestHeader(value = "X-Attesto-Signature", required = false) String sigHeader,
      @RequestHeader(value = "X-Attesto-Event-Id", required = false) String eventId,
      @RequestBody byte[] raw) {

    if (!verifySignature(raw, sigHeader, secret)) {
      return ResponseEntity.status(401).body("invalid signature");
    }
    if (eventId != null && !processed.add(eventId)) {
      return ResponseEntity.ok("already processed");
    }

    try {
      handleEvent(new String(raw, StandardCharsets.UTF_8));
      return ResponseEntity.ok("ok");
    } catch (Exception e) {
      // 5xx triggers Attesto retry schedule (30s, 2m, 10m, 1h, 6h)
      return ResponseEntity.status(500).body("retry me");
    }
  }

  private boolean verifySignature(byte[] raw, String header, String secret) {
    if (header == null) return false;
    String tStr = null, sig = null;
    for (String part : header.split(",")) {
      String[] kv = part.split("=", 2);
      if (kv.length != 2) continue;
      if (kv[0].equals("t"))  tStr = kv[1];
      if (kv[0].equals("v1")) sig  = kv[1];
    }
    if (tStr == null || sig == null) return false;
    long ts;
    try { ts = Long.parseLong(tStr); } catch (NumberFormatException e) { return false; }
    if (Math.abs(Instant.now().getEpochSecond() - ts) > 300) return false;

    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      mac.update((ts + ".").getBytes(StandardCharsets.UTF_8));
      String expected = HexFormat.of().formatHex(mac.doFinal(raw));
      return MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.UTF_8),
        sig.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      return false;
    }
  }

  private void handleEvent(String json) {
    // parse + dispatch on event type
    // - apple.did_renew / google.subscription.renewed → extend entitlement
    // - apple.refund    / google.subscription.cancelled → revoke
  }
}
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
your choice — apply whatever Spring Security configuration you already use:

```java
// IapUuidController.java
@RestController
@RequestMapping("/api/iap")
public class IapUuidController {
  private final JdbcTemplate jdbc;

  public IapUuidController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

  @PostMapping("/uuid")
  public Map<String, String> mintOrLookup(@AuthenticationPrincipal AppUser user) {
    // Idempotent on (user, iap_user_uuid): mint+save the first time, return
    // the existing UUID on every later call. Keeps iap-side stateless.
    UUID uuid = jdbc.queryForObject("""
      UPDATE users
         SET iap_user_uuid = COALESCE(iap_user_uuid, ?::uuid)
       WHERE id = ?
       RETURNING iap_user_uuid
      """, UUID.class, UUID.randomUUID(), user.getId());
    return Map.of("uuid", uuid.toString());
  }
}
```

Webhook handler when `appUserId` is set — trivial join:

```java
private void handleAttestoWebhook(Map<String, Object> payload) {
  String appUserId = (String) payload.get("appUserId");
  if (appUserId != null) {
    List<Long> ids = jdbc.queryForList(
      "SELECT id FROM users WHERE iap_user_uuid = ?::uuid", Long.class, appUserId);
    if (!ids.isEmpty()) { applyStateChange(ids.get(0), payload); return; }
    // Unknown UUID — log for support; falls through.
  }
  handleByFallback(payload);
}
```

If your app supports purchase-before-account (guest) flows, omit `appUserId`
from the iap.purchase() call for those flows; the fallback section below covers
them.

### Fallback: when `appUserId` is null

For guest purchases or purchases made before your app wired up pre-attach, fall
back to the platform-specific `subject.key`. Both verify and the webhook upsert
into the same row, keyed on `(platform, subject_key)`:

```java
// purchases lookup: maps (platform, subject_key) → user_id.
// CREATE TABLE purchases (
//   platform    text not null,
//   subject_key text not null,
//   user_id     text,                       -- nullable; webhook may arrive first
//   product_id  text,
//   status      text not null default 'active',
//   updated_at  timestamptz not null default now(),
//   primary key (platform, subject_key)
// );

// PurchaseStore.java — JdbcTemplate-based; no JPA entity needed.
@Service
public class PurchaseStore {
  private final JdbcTemplate jdbc;

  public PurchaseStore(JdbcTemplate jdbc) { this.jdbc = jdbc; }

  public void upsert(
      String platform, String subjectKey,
      String userId,    // verify supplies; webhook passes null
      String productId, // either side may supply
      String status     // webhook supplies; verify passes null
  ) {
    jdbc.update("""
      INSERT INTO purchases (platform, subject_key, user_id, product_id, status, updated_at)
      VALUES (?, ?, ?, ?, COALESCE(?, 'active'), now())
      ON CONFLICT (platform, subject_key) DO UPDATE SET
        user_id    = COALESCE(EXCLUDED.user_id, purchases.user_id),
        product_id = COALESCE(EXCLUDED.product_id, purchases.product_id),
        status     = COALESCE(EXCLUDED.status, purchases.status),
        updated_at = now()
      """,
      platform, subjectKey, userId, productId, status);
  }
}
```

Inject `PurchaseStore` into both your verify controller (call with `userId`) and
your webhook handler (call with `status` / `productId` from `payload.subject`
and `payload.event`). The `COALESCE` clauses let either side fill the row's
nulls without overwriting fields the other side already wrote.

> See
> [Verify and webhook can arrive in either order](/guide/integration#verify-and-webhook-can-arrive-in-either-order)
> for the timing model and order-of-arrival table.

## Notes

- **Raw body for webhooks.** Spring binds `@RequestBody byte[]` to the unparsed
  payload — that's what HMAC is computed over. Avoid binding to `String` if your
  servlet stack does any charset transformation.
- **Auth.** The `resolveUser` stub should plug into your real auth (Spring
  Security, OIDC, etc.). iap sends whatever `getAuthHeaders()` returns.
- **Persistent idempotency.** `ConcurrentHashMap` is in-memory and node-local.
  For multi-instance deployments, persist `event_id` to a shared store.

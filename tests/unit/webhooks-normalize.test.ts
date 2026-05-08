import { assertEquals } from "@std/assert";
import type { DecodedJwsPayload } from "@/services/apple/jws-verifier.ts";
import { normalizeApple, normalizeGoogle } from "@/services/webhooks/normalize.ts";

function apple(notificationType: string, subtype?: string): DecodedJwsPayload {
  return {
    notificationType,
    ...(subtype ? { subtype } : {}),
  } as unknown as DecodedJwsPayload;
}

Deno.test("normalizeApple: lifecycle events with subtypes", () => {
  // SUBSCRIBED + INITIAL_BUY → purchased + reason=initial
  assertEquals(normalizeApple(apple("SUBSCRIBED", "INITIAL_BUY")), {
    event: "subscription.purchased",
    reason: "initial",
    platformEvent: "apple.subscribed.initial_buy",
  });

  assertEquals(normalizeApple(apple("SUBSCRIBED", "RESUBSCRIBE")), {
    event: "subscription.purchased",
    reason: "resubscribe",
    platformEvent: "apple.subscribed.resubscribe",
  });

  assertEquals(normalizeApple(apple("SUBSCRIBED", "UPGRADE")), {
    event: "subscription.upgraded",
    reason: null,
    platformEvent: "apple.subscribed.upgrade",
  });

  assertEquals(normalizeApple(apple("SUBSCRIBED", "DOWNGRADE")), {
    event: "subscription.downgraded",
    reason: null,
    platformEvent: "apple.subscribed.downgrade",
  });
});

Deno.test("normalizeApple: DID_RENEW with and without BILLING_RECOVERY", () => {
  assertEquals(normalizeApple(apple("DID_RENEW")), {
    event: "subscription.renewed",
    reason: null,
    platformEvent: "apple.did_renew",
  });

  assertEquals(normalizeApple(apple("DID_RENEW", "BILLING_RECOVERY")), {
    event: "subscription.recovered",
    reason: null,
    platformEvent: "apple.did_renew.billing_recovery",
  });
});

Deno.test("normalizeApple: cancellation toggle", () => {
  assertEquals(normalizeApple(apple("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")), {
    event: "subscription.cancellation_scheduled",
    reason: null,
    platformEvent: "apple.did_change_renewal_status.auto_renew_disabled",
  });

  assertEquals(normalizeApple(apple("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED")), {
    event: "subscription.cancellation_revoked",
    reason: null,
    platformEvent: "apple.did_change_renewal_status.auto_renew_enabled",
  });
});

Deno.test("normalizeApple: EXPIRED subtypes drive reason", () => {
  assertEquals(normalizeApple(apple("EXPIRED", "VOLUNTARY")), {
    event: "subscription.expired",
    reason: "voluntary",
    platformEvent: "apple.expired.voluntary",
  });

  assertEquals(normalizeApple(apple("EXPIRED", "BILLING_RETRY")), {
    event: "subscription.expired",
    reason: "billing_retry",
    platformEvent: "apple.expired.billing_retry",
  });

  assertEquals(normalizeApple(apple("EXPIRED", "PRODUCT_NOT_FOR_SALE")), {
    event: "subscription.expired",
    reason: "product_not_for_sale",
    platformEvent: "apple.expired.product_not_for_sale",
  });

  assertEquals(normalizeApple(apple("EXPIRED")), {
    event: "subscription.expired",
    reason: null,
    platformEvent: "apple.expired",
  });
});

Deno.test("normalizeApple: revoke / refund / billing-retry / grace-period", () => {
  assertEquals(normalizeApple(apple("REVOKE")), {
    event: "subscription.revoked",
    reason: null,
    platformEvent: "apple.revoke",
  });

  assertEquals(normalizeApple(apple("REFUND")), {
    event: "subscription.refunded",
    reason: null,
    platformEvent: "apple.refund",
  });

  assertEquals(normalizeApple(apple("DID_FAIL_TO_RENEW")), {
    event: "subscription.in_billing_retry",
    reason: null,
    platformEvent: "apple.did_fail_to_renew",
  });

  assertEquals(normalizeApple(apple("DID_FAIL_TO_RENEW", "GRACE_PERIOD")), {
    event: "subscription.in_grace_period",
    reason: null,
    platformEvent: "apple.did_fail_to_renew.grace_period",
  });

  assertEquals(normalizeApple(apple("GRACE_PERIOD_EXPIRED")), {
    event: "subscription.grace_period_expired",
    reason: null,
    platformEvent: "apple.grace_period_expired",
  });
});

Deno.test("normalizeApple: refund flow extras", () => {
  assertEquals(normalizeApple(apple("REFUND_DECLINED")), {
    event: "subscription.refund_declined",
    reason: null,
    platformEvent: "apple.refund_declined",
  });

  assertEquals(normalizeApple(apple("REFUND_REVERSED")), {
    event: "subscription.refund_reversed",
    reason: null,
    platformEvent: "apple.refund_reversed",
  });
});

Deno.test("normalizeApple: pricing", () => {
  assertEquals(normalizeApple(apple("PRICE_INCREASE", "PENDING")), {
    event: "subscription.price_change_pending",
    reason: null,
    platformEvent: "apple.price_increase.pending",
  });

  assertEquals(normalizeApple(apple("PRICE_INCREASE", "ACCEPTED")), {
    event: "subscription.price_change_accepted",
    reason: null,
    platformEvent: "apple.price_increase.accepted",
  });
});

Deno.test("normalizeApple: promotional / extension / consumables", () => {
  assertEquals(normalizeApple(apple("OFFER_REDEEMED")), {
    event: "subscription.offer_redeemed",
    reason: null,
    platformEvent: "apple.offer_redeemed",
  });

  assertEquals(normalizeApple(apple("RENEWAL_EXTENDED")), {
    event: "subscription.renewal_extended",
    reason: null,
    platformEvent: "apple.renewal_extended",
  });

  assertEquals(normalizeApple(apple("RENEWAL_EXTENSION")), {
    event: "subscription.renewal_extension_complete",
    reason: null,
    platformEvent: "apple.renewal_extension",
  });

  assertEquals(normalizeApple(apple("CONSUMPTION_REQUEST")), {
    event: "subscription.consumption_request",
    reason: null,
    platformEvent: "apple.consumption_request",
  });

  assertEquals(normalizeApple(apple("EXTERNAL_PURCHASE_TOKEN")), {
    event: "subscription.external_purchase_token",
    reason: null,
    platformEvent: "apple.external_purchase_token",
  });

  assertEquals(normalizeApple(apple("ONE_TIME_CHARGE")), {
    event: "product.charged",
    reason: null,
    platformEvent: "apple.one_time_charge",
  });
});

Deno.test("normalizeApple: TEST", () => {
  assertEquals(normalizeApple(apple("TEST")), {
    event: "test",
    reason: null,
    platformEvent: "apple.test",
  });
});

Deno.test("normalizeApple: unknown subtype falls back to bare-type entry", () => {
  // Apple ships a new subtype on a known type — we still classify under the
  // unified event with reason: null. The full subtype survives in
  // platformEvent so backends can branch on it via default if they care.
  assertEquals(normalizeApple(apple("EXPIRED", "BRAND_NEW_SUBTYPE")), {
    event: "subscription.expired",
    reason: null,
    platformEvent: "apple.expired.brand_new_subtype",
  });
});

Deno.test("normalizeApple: completely unknown notification type", () => {
  assertEquals(normalizeApple(apple("FUTURE_TYPE_WE_DONT_KNOW_YET")), {
    event: "unknown",
    reason: null,
    platformEvent: "apple.future_type_we_dont_know_yet",
  });
});

Deno.test("normalizeApple: empty notificationType falls through to unknown", () => {
  assertEquals(normalizeApple({} as DecodedJwsPayload), {
    event: "unknown",
    reason: null,
    platformEvent: "apple.unknown",
  });
});

// ─── Google ───────────────────────────────────────────────────────────────────

Deno.test("normalizeGoogle: every documented subscription notificationType maps", () => {
  const cases: Array<{ n: number; event: string; reason: string | null }> = [
    { n: 1, event: "subscription.recovered", reason: null },
    { n: 2, event: "subscription.renewed", reason: null },
    { n: 3, event: "subscription.cancellation_scheduled", reason: null },
    { n: 4, event: "subscription.purchased", reason: "initial" },
    { n: 5, event: "subscription.on_hold", reason: null },
    { n: 6, event: "subscription.in_grace_period", reason: null },
    { n: 7, event: "subscription.cancellation_revoked", reason: null },
    { n: 8, event: "subscription.price_change_accepted", reason: null },
    { n: 9, event: "subscription.deferred", reason: null },
    { n: 10, event: "subscription.paused", reason: null },
    { n: 11, event: "subscription.pause_schedule_changed", reason: null },
    { n: 12, event: "subscription.revoked", reason: null },
    { n: 13, event: "subscription.expired", reason: null },
    { n: 17, event: "subscription.pending_purchase_canceled", reason: null },
    { n: 19, event: "subscription.price_change_updated", reason: null },
    { n: 20, event: "subscription.price_change_rejected", reason: null },
  ];

  for (const c of cases) {
    assertEquals(
      normalizeGoogle({ subscriptionNotification: { notificationType: c.n } }),
      {
        event: c.event,
        reason: c.reason,
        platformEvent: `google.subscription.${c.n}`,
      },
      `subscriptionNotification.notificationType=${c.n}`,
    );
  }
});

Deno.test("normalizeGoogle: one-time products", () => {
  assertEquals(normalizeGoogle({ oneTimeProductNotification: { notificationType: 1 } }), {
    event: "product.purchased",
    reason: null,
    platformEvent: "google.product.1",
  });

  assertEquals(normalizeGoogle({ oneTimeProductNotification: { notificationType: 2 } }), {
    event: "product.canceled",
    reason: null,
    platformEvent: "google.product.2",
  });
});

Deno.test("normalizeGoogle: voidedPurchaseNotification → subscription.refunded", () => {
  assertEquals(normalizeGoogle({ voidedPurchaseNotification: { purchaseToken: "tok" } }), {
    event: "subscription.refunded",
    reason: null,
    platformEvent: "google.voided",
  });
});

Deno.test("normalizeGoogle: testNotification", () => {
  assertEquals(normalizeGoogle({ testNotification: { version: "1.0" } }), {
    event: "test",
    reason: null,
    platformEvent: "google.test",
  });
});

Deno.test("normalizeGoogle: unknown subscription notificationType preserves platformEvent", () => {
  // Google ships a new integer (e.g. 99) — Attesto degrades gracefully.
  assertEquals(normalizeGoogle({ subscriptionNotification: { notificationType: 99 } }), {
    event: "unknown",
    reason: null,
    platformEvent: "google.subscription.99",
  });
});

Deno.test("normalizeGoogle: unknown product notificationType preserves platformEvent", () => {
  assertEquals(normalizeGoogle({ oneTimeProductNotification: { notificationType: 99 } }), {
    event: "unknown",
    reason: null,
    platformEvent: "google.product.99",
  });
});

Deno.test("normalizeGoogle: empty payload falls through to unknown", () => {
  assertEquals(normalizeGoogle({}), {
    event: "unknown",
    reason: null,
    platformEvent: "google.unknown",
  });
});

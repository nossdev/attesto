import { assertEquals } from "@std/assert";
import { extractSubject } from "@/services/webhooks/subject.ts";

// JWS uses base64url for header / payload / signature. We don't care about
// signature verification here — extractSubject does an unverified peek on the
// already-outer-verified JWS body.
function fakeAppleJws(payload: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "ES256", typ: "JWT" })}.${enc(payload)}.SIG`;
}

// ─── Apple ─────────────────────────────────────────────────────────────────────

Deno.test("extractSubject(apple): subscription notification → key=originalTransactionId, type=subscription", () => {
  const decoded = {
    notificationType: "DID_RENEW",
    data: {
      signedTransactionInfo: fakeAppleJws({
        transactionId: "2000000123456790",
        originalTransactionId: "2000000123456789",
        productId: "com.example.premium.monthly",
        type: "Auto-Renewable Subscription",
      }),
    },
  };
  const subject = extractSubject("apple", decoded);
  assertEquals(subject, {
    key: "2000000123456789",
    productId: "com.example.premium.monthly",
    type: "subscription",
  });
});

Deno.test("extractSubject(apple): non-renewing subscription is also typed 'subscription'", () => {
  const decoded = {
    data: {
      signedTransactionInfo: fakeAppleJws({
        originalTransactionId: "TX1",
        productId: "p",
        type: "Non-Renewing Subscription",
      }),
    },
  };
  assertEquals(extractSubject("apple", decoded)?.type, "subscription");
});

Deno.test("extractSubject(apple): consumable / non-consumable is typed 'product'", () => {
  for (const type of ["Consumable", "Non-Consumable"]) {
    const decoded = {
      data: {
        signedTransactionInfo: fakeAppleJws({
          originalTransactionId: "TX1",
          productId: "p",
          type,
        }),
      },
    };
    assertEquals(extractSubject("apple", decoded)?.type, "product", `type=${type}`);
  }
});

Deno.test("extractSubject(apple): missing data → null", () => {
  assertEquals(extractSubject("apple", { notificationType: "TEST" }), null);
});

Deno.test("extractSubject(apple): missing signedTransactionInfo → null", () => {
  assertEquals(extractSubject("apple", { data: {} }), null);
});

Deno.test("extractSubject(apple): malformed JWS → null (no throw)", () => {
  assertEquals(extractSubject("apple", { data: { signedTransactionInfo: "not-a-jws" } }), null);
});

Deno.test("extractSubject(apple): JWS missing originalTransactionId → null", () => {
  const decoded = {
    data: {
      signedTransactionInfo: fakeAppleJws({ productId: "p", type: "Consumable" }),
    },
  };
  assertEquals(extractSubject("apple", decoded), null);
});

Deno.test("extractSubject(apple): JWS without productId → productId=null, still returns subject", () => {
  const decoded = {
    data: {
      signedTransactionInfo: fakeAppleJws({
        originalTransactionId: "TX1",
        type: "Consumable",
      }),
    },
  };
  assertEquals(extractSubject("apple", decoded), { key: "TX1", productId: null, type: "product" });
});

// ─── Google ────────────────────────────────────────────────────────────────────

Deno.test("extractSubject(google): subscriptionNotification → key=purchaseToken, type=subscription", () => {
  const decoded = {
    version: "1.0",
    packageName: "com.example.app",
    eventTimeMillis: "1503349566168",
    subscriptionNotification: {
      version: "1.0",
      notificationType: 4,
      purchaseToken: "PT_ABC123",
      subscriptionId: "monthly.premium",
    },
  };
  assertEquals(extractSubject("google", decoded), {
    key: "PT_ABC123",
    productId: "monthly.premium",
    type: "subscription",
  });
});

Deno.test("extractSubject(google): oneTimeProductNotification with sku → type=product", () => {
  const decoded = {
    oneTimeProductNotification: {
      purchaseToken: "PT_XYZ",
      sku: "lifetime.premium",
    },
  };
  assertEquals(extractSubject("google", decoded), {
    key: "PT_XYZ",
    productId: "lifetime.premium",
    type: "product",
  });
});

Deno.test("extractSubject(google): oneTimeProductNotification with productId fallback", () => {
  const decoded = {
    oneTimeProductNotification: {
      purchaseToken: "PT_XYZ",
      productId: "fallback.id",
    },
  };
  assertEquals(extractSubject("google", decoded)?.productId, "fallback.id");
});

Deno.test("extractSubject(google): testNotification → null", () => {
  assertEquals(
    extractSubject("google", { testNotification: { version: "1.0" } }),
    null,
  );
});

Deno.test("extractSubject(google): voidedPurchaseNotification (no purchaseToken in our path) → null", () => {
  // We deliberately don't synthesize a subject for refunds — the upstream
  // shape is different and the integrator would handle voided purchases via
  // the eventType anyway.
  assertEquals(
    extractSubject("google", { voidedPurchaseNotification: { orderId: "GPA.x" } }),
    null,
  );
});

Deno.test("extractSubject(google): empty purchaseToken → null", () => {
  assertEquals(
    extractSubject("google", {
      subscriptionNotification: { purchaseToken: "", subscriptionId: "x" },
    }),
    null,
  );
});

Deno.test("extractSubject(google): subscriptionNotification missing subscriptionId → productId=null", () => {
  assertEquals(
    extractSubject("google", {
      subscriptionNotification: { purchaseToken: "PT" },
    }),
    { key: "PT", productId: null, type: "subscription" },
  );
});

// ─── subjectKeyOverride (chain-resolved key from receiver) ─────────────────────

Deno.test("extractSubject(override): non-empty override replaces key but keeps productId/type", () => {
  const result = extractSubject(
    "google",
    {
      subscriptionNotification: {
        purchaseToken: "TOK_NEW",
        subscriptionId: "monthly.premium",
      },
    },
    "TOK_ORIGINAL", // chain-resolved root
  );
  assertEquals(result, {
    key: "TOK_ORIGINAL",
    productId: "monthly.premium",
    type: "subscription",
  });
});

Deno.test("extractSubject(override): null override is a no-op (extracts from payload)", () => {
  const result = extractSubject(
    "google",
    {
      subscriptionNotification: { purchaseToken: "TOK_RAW", subscriptionId: "x" },
    },
    null,
  );
  assertEquals(result?.key, "TOK_RAW");
});

Deno.test("extractSubject(override): empty-string override is treated as absent", () => {
  // Defensive: a future bug that writes "" to subject_key shouldn't blank the
  // outbound key. Empty string falls back to payload extraction.
  const result = extractSubject(
    "google",
    {
      subscriptionNotification: { purchaseToken: "TOK_RAW", subscriptionId: "x" },
    },
    "",
  );
  assertEquals(result?.key, "TOK_RAW");
});

Deno.test("extractSubject(override): override does NOT resurrect a null subject", () => {
  // If the payload has no transaction at all (TEST notification), override
  // shouldn't rescue it — we'd be claiming subject context we don't have.
  const result = extractSubject("apple", { notificationType: "TEST" }, "WHATEVER");
  assertEquals(result, null);
});

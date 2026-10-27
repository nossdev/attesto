import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  getGoogleSubscriptionStatus,
  type GoogleSubscriptionStatusDeps,
} from "@/services/google/subscription-status.ts";
import {
  GooglePurchaseNotFoundError,
  type GoogleSubscriptionClient,
} from "@/services/google/client.ts";
import type { GoogleCredentialsLoader } from "@/services/google/credentials-loader.ts";
import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

const FAKE_SA: GoogleServiceAccount = {
  type: "service_account",
  project_id: "test",
  private_key_id: "kid",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  client_email: "svc@test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

const stubTokenProvider: AccessTokenProvider = {
  getAccessToken: () => Promise.resolve("stub-token"),
};

function loader(packageName: string | null): GoogleCredentialsLoader {
  return {
    load: () =>
      Promise.resolve(
        packageName === null ? null : { packageName, serviceAccount: FAKE_SA },
      ),
    invalidate() {},
    clear() {},
  };
}

function deps(
  raw: Record<string, unknown> | Error,
  packageName: string | null = "com.example.app",
): GoogleSubscriptionStatusDeps {
  const client: GoogleSubscriptionClient = {
    getSubscription: () => raw instanceof Error ? Promise.reject(raw) : Promise.resolve({ raw }),
  };
  return {
    credentialsLoader: loader(packageName),
    tokenProvider: stubTokenProvider,
    clientFactory: () => client,
  };
}

const INPUT = {
  tenantId: "tenant_1",
  packageName: "com.example.app",
  purchaseToken: "tok-abc",
};

/** A realistic SubscriptionPurchaseV2 body. */
function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    regionCode: "US",
    startTime: "2026-04-10T14:22:10.000Z",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    latestOrderId: "GPA.1234-5678-9012-34567",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: "household-uuid",
      obfuscatedExternalProfileId: "profile-7",
    },
    lineItems: [
      {
        productId: "premium_monthly",
        expiryTime: "2026-05-10T14:22:10.000Z",
        autoRenewingPlan: {
          autoRenewEnabled: true,
          recurringPrice: { currencyCode: "USD", units: "9", nanos: 990000000 },
        },
        offerDetails: { basePlanId: "monthly", offerId: "intro", offerTags: ["welcome"] },
      },
    ],
    ...overrides,
  };
}

Deno.test("google subscription-status: active subscription surfaces state, expiry and renewal", async () => {
  const result = await getGoogleSubscriptionStatus(deps(v2()), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.subscriptionState, "SUBSCRIPTION_STATE_ACTIVE");
  assertEquals(result.subscription.expiryTime, "2026-05-10T14:22:10.000Z");
  assertEquals(result.subscription.startTime, "2026-04-10T14:22:10.000Z");
  assertEquals(result.subscription.autoRenewEnabled, true);
  assertEquals(result.subscription.latestOrderId, "GPA.1234-5678-9012-34567");
  assertEquals(result.subscription.regionCode, "US");
  assertEquals(result.subscription.purchaseToken, "tok-abc");
  assertEquals(result.subscription.packageName, "com.example.app");
});

Deno.test("google subscription-status: acknowledgementState is kept as v2's string enum", async () => {
  // SubscriptionPurchaseV2 reports a STRING enum here, unlike the v1
  // numeric field the verify endpoint models.
  const result = await getGoogleSubscriptionStatus(deps(v2()), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.acknowledgementState, "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED");
});

Deno.test("google subscription-status: surfaces the purchase binding as appUserId", async () => {
  const result = await getGoogleSubscriptionStatus(deps(v2()), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.obfuscatedExternalAccountId, "household-uuid");
  assertEquals(result.subscription.obfuscatedExternalProfileId, "profile-7");
  assertEquals(result.appUserId, "household-uuid");
});

Deno.test("google subscription-status: appUserId is null when the purchase carried no binding", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2({ externalAccountIdentifiers: undefined })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.appUserId, null);
  assertEquals(result.subscription.obfuscatedExternalAccountId, null);
});

Deno.test("google subscription-status: grace period is passed through verbatim", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscription.subscriptionState, "SUBSCRIPTION_STATE_IN_GRACE_PERIOD");
});

Deno.test("google subscription-status: on hold is passed through verbatim", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscription.subscriptionState, "SUBSCRIPTION_STATE_ON_HOLD");
});

Deno.test("google subscription-status: cancellation context is preserved", async () => {
  const canceled = {
    subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
    canceledStateContext: {
      userInitiatedCancellation: {
        cancelSurveyResult: { reason: "CANCEL_SURVEY_REASON_NOT_ENOUGH_USAGE" },
        cancelTime: "2026-04-28T09:00:00.000Z",
      },
    },
  };
  const result = await getGoogleSubscriptionStatus(deps(v2(canceled)), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.subscriptionState, "SUBSCRIPTION_STATE_CANCELED");
  assertEquals(result.subscription.canceledStateContext, canceled.canceledStateContext);
});

Deno.test("google subscription-status: paused context is preserved", async () => {
  const paused = {
    subscriptionState: "SUBSCRIPTION_STATE_PAUSED",
    pausedStateContext: { autoResumeTime: "2026-06-10T14:22:10.000Z" },
  };
  const result = await getGoogleSubscriptionStatus(deps(v2(paused)), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.pausedStateContext, paused.pausedStateContext);
});

Deno.test("google subscription-status: testPurchase reports the environment as a boolean", async () => {
  // Google signals a licence-tester purchase by the PRESENCE of an
  // (otherwise empty) `testPurchase` object.
  const test = await getGoogleSubscriptionStatus(deps(v2({ testPurchase: {} })), INPUT);
  assert(test.valid);
  assertEquals(test.subscription.testPurchase, true);

  const live = await getGoogleSubscriptionStatus(deps(v2()), INPUT);
  assert(live.valid);
  assertEquals(live.subscription.testPurchase, false);
});

Deno.test("google subscription-status: line items carry plan, offer and price", async () => {
  const result = await getGoogleSubscriptionStatus(deps(v2()), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.lineItems.length, 1);
  const item = result.subscription.lineItems[0]!;
  assertEquals(item.productId, "premium_monthly");
  assertEquals(item.expiryTime, "2026-05-10T14:22:10.000Z");
  assertEquals(item.autoRenewEnabled, true);
  assertEquals(item.basePlanId, "monthly");
  assertEquals(item.offerId, "intro");
  assertEquals(item.offerTags, ["welcome"]);
  assertEquals(item.priceCurrencyCode, "USD");
  assertEquals(item.priceAmountMicros, "9990000");
});

Deno.test("google subscription-status: multi-line-item subscriptions keep every item", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2({
      lineItems: [
        { productId: "base", expiryTime: "2026-05-10T14:22:10.000Z" },
        { productId: "addon", expiryTime: "2026-05-12T14:22:10.000Z" },
      ],
    })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscription.lineItems.map((i) => i.productId), ["base", "addon"]);
  // The envelope's flat `expiryTime` reports the FIRST line item.
  assertEquals(result.subscription.expiryTime, "2026-05-10T14:22:10.000Z");
});

Deno.test("google subscription-status: linkedPurchaseToken is surfaced for upgrade chains", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2({ linkedPurchaseToken: "older-token" })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscription.linkedPurchaseToken, "older-token");
});

Deno.test("google subscription-status: the untouched Play response is returned as rawResponse", async () => {
  const raw = v2({ someFutureField: { nested: true } });
  const result = await getGoogleSubscriptionStatus(deps(raw), INPUT);

  assert(result.valid);
  assertEquals(result.subscription.rawResponse, raw);
});

Deno.test("google subscription-status: a token Play does not know is SUBSCRIPTION_NOT_FOUND", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(new GooglePurchaseNotFoundError("not_found")),
    INPUT,
  );

  assertEquals(result.valid, false);
  assert(!result.valid);
  assertEquals(result.error, "SUBSCRIPTION_NOT_FOUND");
});

Deno.test("google subscription-status: a package the tenant isn't configured for is rejected", async () => {
  const result = await getGoogleSubscriptionStatus(
    deps(v2(), "com.other.app"),
    INPUT,
  );

  assert(!result.valid);
  assertEquals(result.error, "PACKAGE_NAME_MISMATCH");
});

Deno.test("google subscription-status: a tenant without Google credentials throws CREDENTIALS_MISSING", async () => {
  const err = await assertRejects(
    () => getGoogleSubscriptionStatus(deps(v2(), null), INPUT),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.CREDENTIALS_MISSING);
});

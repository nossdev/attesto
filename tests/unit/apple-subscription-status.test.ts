import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type AppleSubscriptionStatusDeps,
  getAppleSubscriptionStatus,
} from "@/services/apple/subscription-status.ts";
import {
  AppleApiError,
  type AppleSubscriptionStatusClient,
  AppleTransactionNotFoundError,
  type GetSubscriptionStatusesArgs,
} from "@/services/apple/client.ts";
import type { AppleCredentialsLoader } from "@/services/apple/credentials-loader.ts";
import type { AppleEnvironment } from "@/db/queries/apple-credentials.ts";
import type {
  AppleSubscriptionStatusEntry,
  AppleSubscriptionStatusFetchResult,
} from "@/services/apple/subscription-types.ts";
import type {
  AppleCredentialMaterial,
  DecodedAppleTransactionPayload,
} from "@/services/apple/types.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

const MATERIAL: AppleCredentialMaterial = {
  bundleId: "com.example.app",
  keyId: "ABC1234567",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
  appAppleId: 1234567890,
};

function loader(
  material: AppleCredentialMaterial | null = MATERIAL,
  environment: AppleEnvironment = "auto",
): AppleCredentialsLoader {
  return {
    load: () => Promise.resolve(material === null ? null : { material, environment }),
    invalidate() {},
    clear() {},
  };
}

function transaction(
  overrides: Partial<DecodedAppleTransactionPayload> = {},
): DecodedAppleTransactionPayload {
  return {
    transactionId: "2000000999999999",
    originalTransactionId: "2000000000123456",
    bundleId: "com.example.app",
    productId: "premium_monthly",
    purchaseDate: 1_744_464_130_000,
    originalPurchaseDate: 1_736_600_000_000,
    expiresDate: 1_747_056_130_000,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    quantity: 1,
    ...overrides,
  };
}

function entry(
  overrides: Partial<AppleSubscriptionStatusEntry> = {},
): AppleSubscriptionStatusEntry {
  return {
    subscriptionGroupIdentifier: "20123456",
    status: 1,
    originalTransactionId: "2000000000123456",
    signedTransactionInfo: "jws.transaction",
    transaction: transaction(),
    signedRenewalInfo: "jws.renewal",
    renewalInfo: {
      originalTransactionId: "2000000000123456",
      autoRenewProductId: "premium_monthly",
      autoRenewStatus: 1,
      renewalDate: 1_747_056_130_000,
    },
    ...overrides,
  };
}

function fetchResult(
  entries: AppleSubscriptionStatusEntry[],
  overrides: Partial<AppleSubscriptionStatusFetchResult> = {},
): AppleSubscriptionStatusFetchResult {
  return {
    bundleId: "com.example.app",
    environment: "Production",
    appAppleId: 1234567890,
    entries,
    ...overrides,
  };
}

interface ClientBehavior {
  byEnv?: Partial<Record<"production" | "sandbox", AppleSubscriptionStatusFetchResult | Error>>;
  calls: GetSubscriptionStatusesArgs[];
}

function makeClient(behavior: ClientBehavior): AppleSubscriptionStatusClient {
  return {
    getSubscriptionStatuses(args) {
      behavior.calls.push(args);
      const hit = behavior.byEnv?.[args.environment];
      if (hit === undefined) {
        return Promise.reject(new AppleTransactionNotFoundError("transaction_id_not_found"));
      }
      if (hit instanceof Error) return Promise.reject(hit);
      return Promise.resolve(hit);
    },
  };
}

function deps(
  client: AppleSubscriptionStatusClient,
  credentialsLoader: AppleCredentialsLoader = loader(),
): AppleSubscriptionStatusDeps {
  return { credentialsLoader, clientFactory: () => client };
}

const INPUT = { tenantId: "tenant_1", originalTransactionId: "2000000000123456" };

Deno.test("apple subscription-status: returns Apple's status code and ISO timestamps", async () => {
  const calls: GetSubscriptionStatusesArgs[] = [];
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { production: fetchResult([entry({ status: 4 })]) }, calls })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.environment, "production");
  assertEquals(result.subscriptions.length, 1);
  const sub = result.subscriptions[0]!;
  assertEquals(sub.status, 4);
  assertEquals(sub.subscriptionGroupIdentifier, "20123456");
  assertEquals(sub.productId, "premium_monthly");
  assertEquals(sub.expiresDate, new Date(1_747_056_130_000).toISOString());
  assertEquals(sub.purchaseDate, new Date(1_744_464_130_000).toISOString());
  assertEquals(sub.renewalInfo?.renewalDate, new Date(1_747_056_130_000).toISOString());
  assertEquals(sub.renewalInfo?.autoRenewStatus, 1);
});

Deno.test("apple subscription-status: grace-period deadline comes through renewalInfo", async () => {
  // gracePeriodExpiresDate lives ONLY in renewal info — it is the field a
  // caller needs to tell "still paying, in grace" from "lapsed".
  const graced = entry({
    status: 4,
    renewalInfo: {
      originalTransactionId: "2000000000123456",
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
      gracePeriodExpiresDate: 1_747_660_930_000,
      expirationIntent: 1,
    },
  });
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { production: fetchResult([graced]) }, calls: [] })),
    INPUT,
  );

  assert(result.valid);
  const renewal = result.subscriptions[0]!.renewalInfo!;
  assertEquals(renewal.gracePeriodExpiresDate, new Date(1_747_660_930_000).toISOString());
  assertEquals(renewal.isInBillingRetryPeriod, true);
  assertEquals(renewal.expirationIntent, 1);
});

Deno.test("apple subscription-status: a revoked entry without renewal info reports the revocation", async () => {
  const revoked = entry({
    status: 5,
    signedRenewalInfo: null,
    renewalInfo: null,
    transaction: transaction({ revocationDate: 1_746_000_000_000, revocationReason: 1 }),
  });
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { production: fetchResult([revoked]) }, calls: [] })),
    INPUT,
  );

  assert(result.valid);
  const sub = result.subscriptions[0]!;
  assertEquals(sub.status, 5);
  assertEquals(sub.renewalInfo, null);
  assertEquals(sub.revocationDate, new Date(1_746_000_000_000).toISOString());
  assertEquals(sub.revocationReason, 1);
});

Deno.test("apple subscription-status: appUserId comes from the entry matching the request", async () => {
  const other = entry({
    originalTransactionId: "9999999999",
    transaction: transaction({
      originalTransactionId: "9999999999",
      appAccountToken: "someone-else",
    }),
  });
  const mine = entry({
    transaction: transaction({ appAccountToken: "household-uuid" }),
  });
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { production: fetchResult([other, mine]) }, calls: [] })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscriptions.length, 2);
  assertEquals(result.appUserId, "household-uuid");
});

Deno.test("apple subscription-status: appUserId is null when no entry matches the request", async () => {
  const unrelated = entry({
    originalTransactionId: "9999999999",
    transaction: transaction({
      originalTransactionId: "9999999999",
      appAccountToken: "someone-else",
    }),
  });
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { production: fetchResult([unrelated]) }, calls: [] })),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.appUserId, null);
});

Deno.test("apple subscription-status: a subscription from another bundle is rejected", async () => {
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: { production: fetchResult([entry()], { bundleId: "com.other.app" }) },
        calls: [],
      }),
    ),
    INPUT,
  );

  assert(!result.valid);
  assertEquals(result.error, "BUNDLE_ID_MISMATCH");
});

Deno.test("apple subscription-status: auto mode falls back to sandbox when production has no record", async () => {
  const calls: GetSubscriptionStatusesArgs[] = [];
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: { sandbox: fetchResult([entry()], { environment: "Sandbox" }) },
        calls,
      }),
    ),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.environment, "sandbox");
  assertEquals(calls.map((c) => c.environment), ["production", "sandbox"]);
});

Deno.test("apple subscription-status: auto mode falls back to sandbox on a production 401", async () => {
  // A pre-launch app authenticates fine but production refuses access.
  const calls: GetSubscriptionStatusesArgs[] = [];
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: {
          production: new AppleApiError("not authorized for production", 401),
          sandbox: fetchResult([entry()], { environment: "Sandbox" }),
        },
        calls,
      }),
    ),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.environment, "sandbox");
  assertEquals(calls.length, 2);
});

Deno.test("apple subscription-status: not found in either environment is SUBSCRIPTION_NOT_FOUND", async () => {
  const calls: GetSubscriptionStatusesArgs[] = [];
  const result = await getAppleSubscriptionStatus(
    deps(makeClient({ calls })),
    INPUT,
  );

  assert(!result.valid);
  assertEquals(result.error, "SUBSCRIPTION_NOT_FOUND");
  assertEquals(calls.map((c) => c.environment), ["production", "sandbox"]);
});

Deno.test("apple subscription-status: an environment hint pins the lookup to one environment", async () => {
  const calls: GetSubscriptionStatusesArgs[] = [];
  await getAppleSubscriptionStatus(
    deps(makeClient({ byEnv: { sandbox: fetchResult([entry()]) }, calls })),
    { ...INPUT, environmentHint: "sandbox" },
  );

  assertEquals(calls.map((c) => c.environment), ["sandbox"]);
});

Deno.test("apple subscription-status: a production-only tenant without appAppleId fails closed", async () => {
  const err = await assertRejects(
    () =>
      getAppleSubscriptionStatus(
        deps(
          makeClient({ byEnv: { production: fetchResult([entry()]) }, calls: [] }),
          loader({ ...MATERIAL, appAppleId: null }, "production"),
        ),
        INPUT,
      ),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.CREDENTIALS_MISSING);
});

Deno.test("apple subscription-status: a tenant without Apple credentials throws CREDENTIALS_MISSING", async () => {
  const err = await assertRejects(
    () =>
      getAppleSubscriptionStatus(
        deps(makeClient({ calls: [] }), loader(null)),
        INPUT,
      ),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.CREDENTIALS_MISSING);
});

Deno.test("apple subscription-status: an upstream Apple fault surfaces as APPLE_API_ERROR", async () => {
  const err = await assertRejects(
    () =>
      getAppleSubscriptionStatus(
        deps(
          makeClient({
            byEnv: { production: new AppleApiError("boom", 503) },
            calls: [],
          }),
          loader(MATERIAL, "production"),
        ),
        INPUT,
      ),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.APPLE_API_ERROR);
  // The raw upstream message must not leak into the client-facing error.
  assertEquals(err.message, "Apple API request failed");
});

Deno.test("apple subscription-status: an empty production response still tries sandbox", async () => {
  // Apple answering 200 with `data: []` is not a positive answer. Treating
  // it as one would return `valid: true, subscriptions: []` AND skip the
  // sandbox fallback — a pre-launch app would look permanently unsubscribed.
  const calls: GetSubscriptionStatusesArgs[] = [];
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: {
          production: fetchResult([], { bundleId: null }),
          sandbox: fetchResult([entry()], { environment: "Sandbox" }),
        },
        calls,
      }),
    ),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.environment, "sandbox");
  assertEquals(result.subscriptions.length, 1);
  assertEquals(calls.map((c) => c.environment), ["production", "sandbox"]);
});

Deno.test("apple subscription-status: empty in every environment is SUBSCRIPTION_NOT_FOUND", async () => {
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: {
          production: fetchResult([], { bundleId: null }),
          sandbox: fetchResult([], { bundleId: null }),
        },
        calls: [],
      }),
    ),
    INPUT,
  );

  assert(!result.valid);
  assertEquals(result.error, "SUBSCRIPTION_NOT_FOUND");
});

Deno.test("apple subscription-status: a nonsensical timestamp becomes null, not a crash", async () => {
  // Timestamps come from a verified JWS, but `new Date(NaN).toISOString()`
  // throws RangeError, which would escape unclassified as a 500.
  const result = await getAppleSubscriptionStatus(
    deps(
      makeClient({
        byEnv: {
          production: fetchResult([
            entry({ transaction: transaction({ expiresDate: Number.NaN }) }),
          ]),
        },
        calls: [],
      }),
    ),
    INPUT,
  );

  assert(result.valid);
  assertEquals(result.subscriptions[0]?.expiresDate, null);
});

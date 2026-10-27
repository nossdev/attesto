import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  findGoogleVoidedPurchase,
  type GoogleVoidedPurchasesDeps,
  listGoogleVoidedPurchases,
  rateLimitCostForPath,
  VOIDED_SCAN_MAX_PAGES,
  VOIDED_SCAN_PATH,
  VOIDED_SCAN_RATE_LIMIT_COST,
} from "@/services/google/voided-purchases.ts";
import {
  GoogleApiError,
  GooglePurchaseNotFoundError,
  type GoogleVoidedPurchasesClient,
  type ListVoidedPurchasesArgs,
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
      Promise.resolve(packageName === null ? null : { packageName, serviceAccount: FAKE_SA }),
    invalidate() {},
    clear() {},
  };
}

/** A client that serves a fixed sequence of pages, recording each request. */
function pagedClient(
  pages: Array<Record<string, unknown>> | Error,
): { client: GoogleVoidedPurchasesClient; calls: ListVoidedPurchasesArgs[] } {
  const calls: ListVoidedPurchasesArgs[] = [];
  let i = 0;
  return {
    calls,
    client: {
      listVoidedPurchases(args) {
        calls.push(args);
        if (pages instanceof Error) return Promise.reject(pages);
        const page = pages[Math.min(i, pages.length - 1)];
        i++;
        return Promise.resolve({ raw: page ?? {} });
      },
    },
  };
}

function deps(
  client: GoogleVoidedPurchasesClient,
  packageName: string | null = "com.example.app",
): GoogleVoidedPurchasesDeps {
  return {
    credentialsLoader: loader(packageName),
    tokenProvider: stubTokenProvider,
    clientFactory: () => client,
  };
}

const INPUT = { tenantId: "tenant_1", packageName: "com.example.app" };

function voided(token: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "androidpublisher#voidedPurchase",
    purchaseToken: token,
    orderId: "GPA.1234-5678-9012-34567",
    purchaseTimeMillis: "1744464130000",
    voidedTimeMillis: "1746000000000",
    voidedSource: 0,
    voidedReason: 1,
    ...overrides,
  };
}

// ─── list ─────────────────────────────────────────────────────────────────────

Deno.test("voided list: normalizes timestamps and keeps Google's own codes", async () => {
  const { client } = pagedClient([{ voidedPurchases: [voided("tok-a")] }]);

  const result = await listGoogleVoidedPurchases(deps(client), INPUT);

  assert(result.valid);
  assertEquals(result.voidedPurchases.length, 1);
  const v = result.voidedPurchases[0]!;
  assertEquals(v.purchaseToken, "tok-a");
  assertEquals(v.orderId, "GPA.1234-5678-9012-34567");
  assertEquals(v.purchaseTime, new Date(1_744_464_130_000).toISOString());
  assertEquals(v.voidedTime, new Date(1_746_000_000_000).toISOString());
  // Google's numeric vocabulary, passed through (PLAN.md §14).
  assertEquals(v.voidedSource, 0);
  assertEquals(v.voidedReason, 1);
});

Deno.test("voided list: surfaces the next page token and the raw body", async () => {
  const page = {
    voidedPurchases: [voided("tok-a")],
    tokenPagination: { nextPageToken: "page-2" },
  };
  const { client } = pagedClient([page]);

  const result = await listGoogleVoidedPurchases(deps(client), INPUT);

  assert(result.valid);
  assertEquals(result.nextPageToken, "page-2");
  assertEquals(result.rawResponse, page);
});

Deno.test("voided list: an empty window is a valid empty answer, not an error", async () => {
  const { client } = pagedClient([{}]);

  const result = await listGoogleVoidedPurchases(deps(client), INPUT);

  assert(result.valid);
  assertEquals(result.voidedPurchases, []);
  assertEquals(result.nextPageToken, null);
});

Deno.test("voided list: a package the tenant isn't configured for is rejected", async () => {
  const { client } = pagedClient([{}]);

  const result = await listGoogleVoidedPurchases(deps(client, "com.other.app"), INPUT);

  assert(!result.valid);
  assertEquals(result.error, "PACKAGE_NAME_MISMATCH");
});

Deno.test("voided list: a tenant without Google credentials throws CREDENTIALS_MISSING", async () => {
  const { client } = pagedClient([{}]);

  const err = await assertRejects(
    () => listGoogleVoidedPurchases(deps(client, null), INPUT),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.CREDENTIALS_MISSING);
});

Deno.test("voided list: an upstream fault surfaces as GOOGLE_API_ERROR, not a false negative", async () => {
  // Missing "View financial data" shows up here. Reporting it as "no voided
  // purchases" would turn a permissions problem into a wrong answer.
  const { client } = pagedClient(new GoogleApiError("denied", 403, "PERMISSION_DENIED"));

  const err = await assertRejects(
    () => listGoogleVoidedPurchases(deps(client), INPUT),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.GOOGLE_API_ERROR);
});

// ─── find one token ──────────────────────────────────────────────────────────

Deno.test("voided find: reports a token present on the first page", async () => {
  const { client, calls } = pagedClient([
    { voidedPurchases: [voided("other"), voided("tok-mine")] },
  ]);

  const result = await findGoogleVoidedPurchase(deps(client), {
    ...INPUT,
    purchaseToken: "tok-mine",
  });

  assert(result.valid);
  assertEquals(result.voided, true);
  assertEquals(result.voidedPurchase?.purchaseToken, "tok-mine");
  assertEquals(result.truncated, false);
  assertEquals(calls.length, 1);
});

Deno.test("voided find: follows pagination until it finds the token", async () => {
  const { client, calls } = pagedClient([
    { voidedPurchases: [voided("a")], tokenPagination: { nextPageToken: "p2" } },
    { voidedPurchases: [voided("b")], tokenPagination: { nextPageToken: "p3" } },
    { voidedPurchases: [voided("tok-mine")] },
  ]);

  const result = await findGoogleVoidedPurchase(deps(client), {
    ...INPUT,
    purchaseToken: "tok-mine",
  });

  assert(result.valid);
  assertEquals(result.voided, true);
  assertEquals(calls.length, 3);
  assertEquals(calls[1]?.pageToken, "p2");
  assertEquals(calls[2]?.pageToken, "p3");
});

Deno.test("voided find: stops at the last page and reports a conclusive no", async () => {
  const { client, calls } = pagedClient([
    { voidedPurchases: [voided("a")], tokenPagination: { nextPageToken: "p2" } },
    { voidedPurchases: [voided("b")] },
  ]);

  const result = await findGoogleVoidedPurchase(deps(client), {
    ...INPUT,
    purchaseToken: "absent",
  });

  assert(result.valid);
  assertEquals(result.voided, false);
  assertEquals(result.voidedPurchase, null);
  // Not truncated — the list was exhausted, so "no" is an answer.
  assertEquals(result.truncated, false);
  assertEquals(calls.length, 2);
});

Deno.test("voided find: a scan that hits the page cap says so rather than claiming a no", async () => {
  // An endless list, each page advancing the cursor so the scan really
  // runs to the cap. `voided: false` here would be a guess, and a caller
  // would read it as "not refunded" — so the cap must be visible.
  const calls: ListVoidedPurchasesArgs[] = [];
  let page = 0;
  const client: GoogleVoidedPurchasesClient = {
    listVoidedPurchases(args) {
      calls.push(args);
      page++;
      return Promise.resolve({
        raw: {
          voidedPurchases: [voided(`filler-${page}`)],
          tokenPagination: { nextPageToken: `page-${page}` },
        },
      });
    },
  };

  const result = await findGoogleVoidedPurchase(deps(client), {
    ...INPUT,
    purchaseToken: "never-appears",
  });

  assert(result.valid);
  assertEquals(result.voided, false);
  assertEquals(result.truncated, true);
  assertEquals(calls.length, VOIDED_SCAN_MAX_PAGES);
  assertEquals(result.pagesScanned, VOIDED_SCAN_MAX_PAGES);
});

Deno.test("voided find: a package mismatch is rejected before any Play call", async () => {
  const { client, calls } = pagedClient([{}]);

  const result = await findGoogleVoidedPurchase(deps(client, "com.other.app"), {
    ...INPUT,
    purchaseToken: "tok",
  });

  assert(!result.valid);
  assertEquals(result.error, "PACKAGE_NAME_MISMATCH");
  assertEquals(calls.length, 0);
});

Deno.test("voided list: a 404 is an upstream fault, not an unhandled 500", async () => {
  // `playGet` turns any 404 into GooglePurchaseNotFoundError, which
  // mapGoogleApiError deliberately leaves alone — a missing PURCHASE is a
  // domain outcome each caller names. But this endpoint never looks up a
  // purchase: a 404 means the app is unreachable for this service account,
  // and letting it escape produced a 500 logged as "purchase token not
  // found" on a call that looked up no token.
  const { client } = pagedClient(new GooglePurchaseNotFoundError("not_found"));

  const err = await assertRejects(
    () => listGoogleVoidedPurchases(deps(client), INPUT),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.GOOGLE_API_ERROR);
});

Deno.test("voided find: a 404 mid-scan is an upstream fault too", async () => {
  const { client } = pagedClient(new GooglePurchaseNotFoundError("gone"));

  const err = await assertRejects(
    () => findGoogleVoidedPurchase(deps(client), { ...INPUT, purchaseToken: "tok" }),
    AppError,
  );
  assertEquals(err.code, ErrorCodes.GOOGLE_API_ERROR);
});

Deno.test("voided list: a nonsensical timestamp becomes null rather than throwing", async () => {
  // new Date(9e15).toISOString() throws RangeError. Upstream data is
  // untrusted, and one bad field must not 500 a whole page.
  const { client } = pagedClient([{
    voidedPurchases: [voided("tok", { voidedTimeMillis: "9000000000000000" })],
  }]);

  const result = await listGoogleVoidedPurchases(deps(client), INPUT);

  assert(result.valid);
  assertEquals(result.voidedPurchases[0]?.voidedTime, null);
  // The rest of the row still comes through.
  assertEquals(result.voidedPurchases[0]?.purchaseToken, "tok");
});

Deno.test("voided find: a repeated page token stops the scan instead of burning the cap", async () => {
  // A degenerate upstream handing back the same cursor would otherwise
  // cost 50 identical round-trips before answering.
  const { client, calls } = pagedClient([
    { voidedPurchases: [voided("filler")], tokenPagination: { nextPageToken: "same" } },
  ]);

  const result = await findGoogleVoidedPurchase(deps(client), {
    ...INPUT,
    purchaseToken: "absent",
  });

  assert(result.valid);
  assertEquals(result.voided, false);
  assertEquals(result.truncated, true);
  // Second call returns the same cursor as the first, so we stop there.
  assertEquals(calls.length, 2);
});

Deno.test("voided find: the scan stops at its time budget, not just its page cap", async () => {
  // 50 pages at Google's 10s per-call timeout is ~500s of one request
  // holding a connection. The budget bounds wall clock too.
  let now = 0;
  const { client, calls } = pagedClient([
    { voidedPurchases: [voided("filler")], tokenPagination: { nextPageToken: "p-next" } },
  ]);
  // Each page "takes" 9 seconds.
  const slow: typeof client = {
    listVoidedPurchases: (args) => {
      now += 9_000;
      return client.listVoidedPurchases({ ...args, pageToken: `p-${calls.length}` });
    },
  };

  const result = await findGoogleVoidedPurchase(
    { ...deps(slow) },
    { ...INPUT, purchaseToken: "absent" },
    () => now,
  );

  assert(result.valid);
  assertEquals(result.truncated, true);
  // Stopped on the clock, long before 50 pages.
  assert(result.pagesScanned < VOIDED_SCAN_MAX_PAGES, `scanned ${result.pagesScanned}`);
});

// ─── Rate-limit pricing ───────────────────────────────────────────────────────

Deno.test("rate-limit cost: the scan costs more than an ordinary lookup", () => {
  assert(
    VOIDED_SCAN_RATE_LIMIT_COST > 1,
    "a scan that fans out upstream must not cost the same as a single call",
  );
  assertEquals(rateLimitCostForPath(VOIDED_SCAN_PATH), VOIDED_SCAN_RATE_LIMIT_COST);
});

Deno.test("rate-limit cost: every other route still costs one token", () => {
  for (
    const path of [
      "/v1/google/verify",
      "/v1/google/subscription-status",
      "/v1/google/voided-purchases",
      "/v1/apple/verify",
      "/v1/apple/subscription-status",
    ]
  ) {
    assertEquals(rateLimitCostForPath(path), 1, path);
  }
});

Deno.test("rate-limit cost: VOIDED_SCAN_PATH is the path the router actually registers", async () => {
  // The cost is keyed on an exact path. If the route were renamed and this
  // constant were not, the scan would silently revert to one token.
  const source = await Deno.readTextFile(
    new URL("../../app/routes/google.ts", import.meta.url),
  );
  const registered = VOIDED_SCAN_PATH.replace(/^\/v1/, "");
  assertStringIncludes(source, `app.post("${registered}"`);
});

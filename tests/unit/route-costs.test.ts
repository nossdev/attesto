import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { rateLimitCostForPath, VOIDED_SCAN_PATH } from "@/middleware/route-costs.ts";
import { VOIDED_SCAN_RATE_LIMIT_COST } from "@/services/google/voided-purchases.ts";

Deno.test("route costs: the scan costs more than an ordinary lookup", () => {
  assert(
    VOIDED_SCAN_RATE_LIMIT_COST > 1,
    "a scan that fans out upstream must not cost the same as a single call",
  );
  assertEquals(rateLimitCostForPath(VOIDED_SCAN_PATH), VOIDED_SCAN_RATE_LIMIT_COST);
});

Deno.test("route costs: every other route costs one token", () => {
  for (
    const path of [
      "/v1/google/verify",
      "/v1/google/subscription-status",
      "/v1/google/voided-purchases",
      "/v1/apple/verify",
      "/v1/apple/subscription-status",
      "/health",
    ]
  ) {
    assertEquals(rateLimitCostForPath(path), 1, path);
  }
});

Deno.test("route costs: VOIDED_SCAN_PATH matches the path the router registers", async () => {
  // The cost is an exact path compare. A renamed route would silently
  // revert to one token, which is the control quietly switching off.
  const source = await Deno.readTextFile(
    new URL("../../app/routes/google.ts", import.meta.url),
  );
  assertStringIncludes(source, `app.post("${VOIDED_SCAN_PATH.replace(/^\/v1/, "")}"`);
});

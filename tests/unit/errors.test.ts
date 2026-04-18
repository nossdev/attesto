import { assertEquals } from "@std/assert";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

Deno.test("AppError uses default status for known code", () => {
  const err = new AppError(ErrorCodes.UNAUTHENTICATED, "nope");
  assertEquals(err.status, 401);
  assertEquals(err.code, "UNAUTHENTICATED");
});

Deno.test("AppError respects explicit status override", () => {
  const err = new AppError(ErrorCodes.INVALID_REQUEST, "bad", { status: 422 });
  assertEquals(err.status, 422);
});

Deno.test("AppError.toResponseBody produces the plan §4.7 envelope", () => {
  const err = new AppError(ErrorCodes.TRANSACTION_NOT_FOUND, "not in prod or sandbox", {
    details: { env: "production" },
  });
  assertEquals(err.toResponseBody(), {
    valid: false,
    error: "TRANSACTION_NOT_FOUND",
    message: "not in prod or sandbox",
    details: { env: "production" },
  });
});

Deno.test("AppError omits details when not supplied", () => {
  const err = new AppError(ErrorCodes.INTERNAL_ERROR, "boom");
  const body = err.toResponseBody();
  assertEquals("details" in body, false);
});

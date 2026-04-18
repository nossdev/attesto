import { assert, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import type { HonoEnv } from "@/hono-env.ts";
import { createErrorHandler } from "@/middleware/error.ts";
import { AppError, ErrorCodes } from "@/lib/errors.ts";

function buildApp(opts: { isProduction?: boolean } = {}) {
  const app = new Hono<HonoEnv>();
  app.onError(createErrorHandler({ isProduction: opts.isProduction ?? false }));
  return app;
}

type CapturedLog = { raw: string; parsed: Record<string, unknown> };

async function captureStderr<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; logs: CapturedLog[] }> {
  const logs: CapturedLog[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const raw = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    try {
      logs.push({ raw, parsed: JSON.parse(raw) });
    } catch {
      logs.push({ raw, parsed: {} });
    }
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.error = original;
  }
}

function requireLog(logs: CapturedLog[], index = 0): CapturedLog {
  const entry = logs[index];
  if (!entry) throw new Error(`expected log entry at index ${index}, got none`);
  return entry;
}

Deno.test("errorHandler: AppError maps to plan §4.7 envelope with its status", async () => {
  const app = buildApp();
  app.get("/boom", () => {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, "missing token");
  });
  const res = await app.request("/boom");
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("content-type"), "application/json; charset=utf-8");
  const body = await res.json();
  assertEquals(body, {
    valid: false,
    error: "UNAUTHENTICATED",
    message: "missing token",
  });
});

Deno.test("errorHandler: AppError details pass through", async () => {
  const app = buildApp();
  app.get("/boom", () => {
    throw new AppError(ErrorCodes.INVALID_REQUEST, "bad body", {
      details: { field: "transactionId" },
    });
  });
  const res = await app.request("/boom");
  const body = await res.json();
  assertEquals(body.details, { field: "transactionId" });
});

Deno.test("errorHandler: unknown error returns 500 with INTERNAL_ERROR and no details", async () => {
  const app = buildApp();
  app.get("/boom", () => {
    throw new Error("something exploded");
  });
  const { result: res } = await captureStderr(() => app.request("/boom"));
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "INTERNAL_ERROR");
  assertEquals(body.message, "An internal error occurred");
  assert(!("details" in body));
});

Deno.test("errorHandler: stack trace is included when isProduction=false", async () => {
  const app = buildApp({ isProduction: false });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  const { logs } = await captureStderr(() => app.request("/boom"));
  assertEquals(logs.length, 1);
  const entry = requireLog(logs);
  assert(typeof entry.parsed.stack === "string", "expected stack in dev");
  assert((entry.parsed.stack as string).includes("kaboom"));
});

Deno.test("errorHandler: stack, message, and details all redacted in production", async () => {
  const app = buildApp({ isProduction: true });
  app.get("/boom", () => {
    throw new Error("password authentication failed for user 'attesto' at db.internal:5432");
  });
  const { logs } = await captureStderr(() => app.request("/boom"));
  assertEquals(logs.length, 1);
  const entry = requireLog(logs);
  assertEquals(entry.parsed.stack, undefined);
  // Full message never appears in prod logs — only the class name.
  const logged = entry.parsed.error;
  assert(typeof logged === "string");
  assert(
    !logged.includes("password"),
    `prod log must not carry raw error message, got: ${logged}`,
  );
  assertEquals(entry.parsed.errorClass, "Error");
});

Deno.test("errorHandler: preserves error class name for diagnostics in prod", async () => {
  class PostgresError extends Error {
    override name = "PostgresError";
  }
  const app = buildApp({ isProduction: true });
  app.get("/boom", () => {
    throw new PostgresError("connection refused at 127.0.0.1:5432");
  });
  const { logs } = await captureStderr(() => app.request("/boom"));
  const entry = requireLog(logs);
  assertEquals(entry.parsed.errorClass, "PostgresError");
});

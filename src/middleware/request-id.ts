import type { MiddlewareHandler } from "@hono/hono";
import { makeId } from "@/lib/id.ts";

export const REQUEST_ID_HEADER = "X-Request-Id";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeRequestId(value: string | undefined): value is string {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value);
}

export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id = isSafeRequestId(incoming) ? incoming : makeId.request();
  c.set("requestId", id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
};

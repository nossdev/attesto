import type { MiddlewareHandler } from "@hono/hono";
import { makeId } from "@/lib/id.ts";

export const REQUEST_ID_HEADER = "X-Request-Id";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : makeId.request();
  c.set("requestId", id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
};

import { ulid } from "@std/ulid";

function prefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const makeId = {
  tenant: () => prefixedId("tenant"),
  apiKey: () => prefixedId("key"),
  event: () => prefixedId("evt"),
  delivery: () => prefixedId("del"),
  request: () => prefixedId("req"),
  audit: () => prefixedId("aud"),
};

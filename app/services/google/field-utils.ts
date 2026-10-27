/**
 * Coercion helpers shared by the Google verify and subscription-status
 * normalizers.
 *
 * `asString` / `asNumber` / `asBoolean` DROP mistyped fields rather than
 * coercing them — coerced bad data is worse than missing data. Clients that
 * need a field the envelope reports as null should read `rawResponse`.
 */

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

export function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v as Array<Record<string, unknown>> : [];
}

export function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((e): e is string => typeof e === "string");
  return out.length === v.length ? out : null;
}

/**
 * Google's Money type exposes {units: string, nanos: number} where
 * 1 unit = 1 whole currency unit and 10⁹ nanos = 1 unit. Micros = 10⁶
 * sub-units, so `micros = units * 1_000_000 + nanos / 1_000`. Returned as
 * string because `units` may exceed Number.MAX_SAFE_INTEGER for some
 * currencies and we prefer exactness over a potential truncation.
 */
export function moneyToMicros(money: Record<string, unknown> | undefined | null): string | null {
  if (!money) return null;
  const unitsStr = money.units;
  const nanosN = money.nanos;
  if (typeof unitsStr !== "string" && typeof unitsStr !== "number") return null;
  try {
    const units = BigInt(String(unitsStr));
    const nanos = typeof nanosN === "number" ? BigInt(nanosN) : 0n;
    return (units * 1_000_000n + nanos / 1000n).toString();
  } catch {
    return null;
  }
}

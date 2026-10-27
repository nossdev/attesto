/**
 * Millisecond epoch → ISO-8601, or null.
 *
 * `new Date(NaN).toISOString()` throws `RangeError`, and so does any value
 * outside ±8.64e15 ms (ECMA-262's time-value range). A bare
 * `typeof ms === "number"` guard admits both. These timestamps arrive from
 * decoded store payloads, so an unguarded conversion turns a malformed
 * upstream field into an unclassified 500.
 */
const MAX_TIME_VALUE = 8.64e15;

export function toIsoOrNull(ms: number | undefined | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_VALUE) {
    return null;
  }
  return new Date(ms).toISOString();
}

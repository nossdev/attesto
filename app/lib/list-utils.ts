/**
 * Shared utilities for paginated list queries on the admin/CLI surface.
 *
 * Used by `listWebhookEventsByTenant`, `listWebhookDeliveriesByTenant`,
 * `listValidationAuditByTenant`, and any future `list*ByTenant` helper.
 */

const HARD_CEILING = 500;

/**
 * Clamp a caller-supplied row limit into `[1, HARD_CEILING]` with a per-call
 * default. Operators wanting more than `HARD_CEILING` rows should use raw
 * SQL — the CLI's JSON-per-line output gets unwieldy past ~500 rows.
 */
export function clampLimit(value: number | undefined, defaultValue: number): number {
  return Math.min(Math.max(value ?? defaultValue, 1), HARD_CEILING);
}

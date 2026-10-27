/**
 * Read-only reporting subcommands: validation audit and subscriber stats.
 *
 * See `shared.ts` for the handler contract these all follow.
 */
import {
  type AdminContext,
  type CliIO,
  defaultIo,
  listLimit,
  parseArgs,
  reportZodIssues,
  TenantId,
} from "@/cli/shared.ts";
import { getSubscriberStats, type StatsPeriod, type SubscriberStats } from "@/db/queries/stats.ts";
import { listValidationAuditByTenant } from "@/db/queries/validation-audit.ts";
import { z } from "zod";

const AuditListArgs = z.object({
  tenantId: TenantId,
  limit: listLimit(20),
});

export async function runAuditList(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = AuditListArgs.safeParse({
    tenantId: positional[0],
    limit: flags.limit,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto audit:list <tenant_id> [--limit 20]",
      parsed.error,
    );
  }
  const rows = await listValidationAuditByTenant(ctx.db.db, parsed.data.tenantId, {
    limit: parsed.data.limit,
  });
  for (const r of rows) {
    io.write(
      JSON.stringify({
        id: r.id,
        source: r.source,
        valid: r.valid,
        errorCode: r.errorCode,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
      }),
    );
  }
  return 0;
}

// ─── stats:subscribers ────────────────────────────────────────────────────────
// Operator-facing analytics: how many users have subscribed for a tenant.
// Two output formats — `pretty` (default, ASCII box-drawing table for at-a-
// glance reading) and `json` (single-line, for piping / future automation).
// Three counts side-by-side: net-new in period, active in period, lifetime.

const StatsPeriodEnum = z.enum(["day", "week", "month", "year"]);
const StatsFormatEnum = z.enum(["pretty", "json"]);

const StatsSubscribersArgs = z.object({
  tenantId: TenantId,
  period: StatsPeriodEnum.default("month"),
  format: StatsFormatEnum.default("pretty"),
});

/**
 * `now` is exposed as a 4th parameter so integration tests can pin the
 * trailing-N-days window deterministically. Production callers
 * (`runAdminSubcommand`) omit it and get `new Date()` per call.
 */
export async function runStatsSubscribers(
  ctx: AdminContext,
  args: string[],
  io: CliIO = defaultIo,
  now: () => Date = () => new Date(),
): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const parsed = StatsSubscribersArgs.safeParse({
    tenantId: positional[0],
    period: flags.period,
    format: flags.format,
  });
  if (!parsed.success) {
    return reportZodIssues(
      io,
      "Usage: attesto stats:subscribers <tenant_id> [--period day|week|month|year] [--format pretty|json]",
      parsed.error,
    );
  }
  const { tenantId, period, format } = parsed.data;
  const stats = await getSubscriberStats(ctx.db.db, tenantId, period, now);

  if (format === "json") {
    io.write(
      JSON.stringify({
        tenantId,
        period,
        periodStart: stats.periodStart.toISOString(),
        periodEnd: stats.periodEnd.toISOString(),
        subscribers: {
          newInPeriod: stats.newInPeriod,
          activeInPeriod: stats.activeInPeriod,
          lifetime: stats.lifetime,
        },
      }),
    );
    return 0;
  }

  // Pretty (default): each io.write call is one rendered line.
  for (const line of renderSubscriberStatsPretty(tenantId, period, stats)) {
    io.write(line);
  }
  return 0;
}

/**
 * Render a SubscriberStats result as an ASCII box-drawing table.
 *
 * Returned as an array of lines (one per `io.write`) so the runner can
 * preserve the existing "one io.write per line" convention used by all
 * other CLI subcommands. The label column is fixed to the longest known
 * label width; the count column right-aligns to the longest stringified
 * count so million-range totals still render cleanly.
 */
function renderSubscriberStatsPretty(
  tenantId: string,
  period: StatsPeriod,
  stats: SubscriberStats,
): string[] {
  const rows: Array<[label: string, count: number]> = [
    ["New in period", stats.newInPeriod],
    ["Active in period", stats.activeInPeriod],
    ["Lifetime", stats.lifetime],
  ];

  const LABEL_HEADER = "Metric";
  const COUNT_HEADER = "Count";
  const labelWidth = Math.max(
    LABEL_HEADER.length,
    ...rows.map(([label]) => label.length),
  );
  const countWidth = Math.max(
    COUNT_HEADER.length,
    ...rows.map(([, n]) => String(n).length),
  );

  // +2 inner padding (one space each side of the cell content).
  const labelBar = "─".repeat(labelWidth + 2);
  const countBar = "─".repeat(countWidth + 2);

  const headerCell = (text: string, width: number, align: "left" | "right") =>
    align === "left" ? text.padEnd(width) : text.padStart(width);

  return [
    `Tenant: ${tenantId}`,
    `Period: ${period} (${stats.periodStart.toISOString()} → ${stats.periodEnd.toISOString()})`,
    "",
    `┌${labelBar}┬${countBar}┐`,
    `│ ${headerCell(LABEL_HEADER, labelWidth, "left")} │ ${
      headerCell(COUNT_HEADER, countWidth, "right")
    } │`,
    `├${labelBar}┼${countBar}┤`,
    ...rows.map(
      ([label, n]) => `│ ${label.padEnd(labelWidth)} │ ${String(n).padStart(countWidth)} │`,
    ),
    `└${labelBar}┴${countBar}┘`,
  ];
}

// ─── webhook:probe ────────────────────────────────────────────────────────────
// End-to-end smoke test for the webhook chain. Dispatches a real test event
// through whichever platform(s) are configured for the tenant:
//   - Apple: hits `inApps/v1/notifications/test` (already done via
//     `apple:request-test-notification`); arrives at the receiver as
//     notificationType=TEST → unified `event: "test"`.
//   - Google: publishes a synthetic `testNotification` to the configured
//     Pub/Sub topic via the REST publish API; Google delivers via the push
//     subscription, OIDC verification runs, normalize maps it to
//     `event: "test"` with `platformEvent: "google.test"`.
// Both arrive at the backend dev's webhook URL with `event: "test"` so a
// "log everything" handler can confirm the chain is wired up.

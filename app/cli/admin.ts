/**
 * The admin subcommand registry and dispatcher.
 *
 * The handlers themselves live in topic modules beside this one
 * (`tenants`, `keys`, `credentials`, `webhooks`, `reports`), all built on
 * `shared.ts`. They are re-exported here so callers and tests keep a
 * single import site.
 *
 * Every subcommand validates its args through a Zod schema before touching
 * the DB, so malformed IDs / flags produce a clean usage error instead of a
 * Postgres driver exception (which could leak connection details).
 */
import { type AdminContext, type CliIO, defaultIo } from "@/cli/shared.ts";
import {
  runTenantCreate,
  runTenantDeactivate,
  runTenantList,
  runTenantPurge,
  runTenantSetAuditLog,
} from "@/cli/tenants.ts";
import { runKeyCreate, runKeyList, runKeyRevoke } from "@/cli/keys.ts";
import {
  runAppleGetCredentials,
  runAppleRequestTestNotification,
  runAppleSetCredentials,
  runGoogleSetCredentials,
} from "@/cli/credentials.ts";
import {
  runWebhookGet,
  runWebhookListDeliveries,
  runWebhookListEvents,
  runWebhookPing,
  runWebhookProbe,
  runWebhookSetConfig,
} from "@/cli/webhooks.ts";
import { runAuditList, runStatsSubscribers } from "@/cli/reports.ts";

// Re-exported so existing callers and tests keep importing from one place.
export { type AdminContext, type CliIO, defaultIo } from "@/cli/shared.ts";
export {
  runTenantCreate,
  runTenantDeactivate,
  runTenantList,
  runTenantPurge,
  runTenantSetAuditLog,
} from "@/cli/tenants.ts";
export { runKeyCreate, runKeyList, runKeyRevoke } from "@/cli/keys.ts";
export {
  runAppleGetCredentials,
  runAppleRequestTestNotification,
  runAppleSetCredentials,
  runGoogleSetCredentials,
} from "@/cli/credentials.ts";
export {
  runWebhookGet,
  runWebhookListDeliveries,
  runWebhookListEvents,
  runWebhookPing,
  runWebhookProbe,
  runWebhookSetConfig,
  type WebhookProbeDeps,
} from "@/cli/webhooks.ts";
export { runAuditList, runStatsSubscribers } from "@/cli/reports.ts";

const RUNNERS = {
  "tenant:create": runTenantCreate,
  "tenant:list": runTenantList,
  "tenant:deactivate": runTenantDeactivate,
  "tenant:set-audit-log": runTenantSetAuditLog,
  "tenant:purge": runTenantPurge,
  "key:create": runKeyCreate,
  "key:revoke": runKeyRevoke,
  "key:list": runKeyList,
  "apple:set-credentials": runAppleSetCredentials,
  "apple:get-credentials": runAppleGetCredentials,
  "apple:request-test-notification": runAppleRequestTestNotification,
  "google:set-credentials": runGoogleSetCredentials,
  "webhook:set-config": runWebhookSetConfig,
  "webhook:get": runWebhookGet,
  "webhook:list-events": runWebhookListEvents,
  "webhook:list-deliveries": runWebhookListDeliveries,
  "webhook:ping": runWebhookPing,
  "webhook:probe": runWebhookProbe,
  "audit:list": runAuditList,
  "stats:subscribers": runStatsSubscribers,
} as const satisfies Record<string, (c: AdminContext, a: string[], io: CliIO) => Promise<number>>;

export type AdminSubcommand = keyof typeof RUNNERS;

export const ADMIN_SUBCOMMANDS = Object.keys(RUNNERS) as AdminSubcommand[];

export function isAdminSubcommand(s: string): s is AdminSubcommand {
  return s in RUNNERS;
}

export async function runAdminSubcommand(
  ctx: AdminContext,
  subcommand: AdminSubcommand,
  args: string[],
  io: CliIO = defaultIo,
): Promise<number> {
  return await RUNNERS[subcommand](ctx, args, io);
}

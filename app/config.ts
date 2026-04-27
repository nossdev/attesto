import { z } from "zod";
import { RETRY_SCHEDULE_SECONDS } from "@/services/webhooks/delivery.ts";

const LogLevel = z.enum(["trace", "debug", "info", "warn", "error"]);
const NodeEnv = z.enum(["development", "production", "test"]);

function isBase64Encoded32Bytes(v: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
    return bytes.length === 32;
  } catch {
    return false;
  }
}

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: LogLevel.default("info"),
    NODE_ENV: NodeEnv.default("development"),
    DATABASE_URL: z.string().url(),
    ATTESTO_ENCRYPTION_KEY: z
      .string()
      .refine(
        isBase64Encoded32Bytes,
        "ATTESTO_ENCRYPTION_KEY must be base64-encoded 32 bytes (generate: openssl rand -base64 32)",
      ),

    RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_BURST: z.coerce.number().int().positive().default(200),

    /** Cap on retry attempts for outbound webhook deliveries. Default 5
     * matches the hardcoded backoff schedule in delivery.ts (RETRY_SCHEDULE_SECONDS).
     * Operators can lower this to fail faster on broken receivers. Upper-
     * bounded by the schedule length — beyond that, we'd need additional
     * backoff slots to define behavior, so we fail fast at boot rather than
     * silently reuse the last entry. */
    WEBHOOK_MAX_RETRIES: z.coerce
      .number()
      .int()
      .nonnegative()
      .lte(RETRY_SCHEDULE_SECONDS.length)
      .default(RETRY_SCHEDULE_SECONDS.length),
    /** Dispatcher poll interval — how often the loop scans for due
     * deliveries. NOT the retry delay (those are hardcoded in delivery.ts).
     * Default 10s; lower for faster pickup at the cost of more DB queries. */
    WEBHOOK_DISPATCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
    /** Max concurrent in-flight outbound webhook deliveries per tick. The
     * dispatcher claims up to this many pending rows and processes them in
     * parallel before the next tick. Capped at 100 to keep promise fan-out
     * bounded — going higher risks DB connection-pool exhaustion under load
     * (each in-flight delivery does ~3 DB queries). */
    WEBHOOK_DISPATCH_CONCURRENCY: z.coerce.number().int().positive().lte(100).default(10),
    /** Per-attempt HTTP timeout for delivering to the tenant's callback URL. */
    WEBHOOK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),

    ENABLE_VALIDATION_AUDIT_LOG: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${formatted}`);
  }
  return result.data;
}

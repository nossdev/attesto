import { z } from "zod";

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

    WEBHOOK_MAX_RETRIES: z.coerce.number().int().nonnegative().default(8),
    WEBHOOK_RETRY_INITIAL_DELAY_SECONDS: z.coerce.number().int().positive().default(30),
    WEBHOOK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),

    ENABLE_VALIDATION_AUDIT_LOG: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    ENABLE_ADMIN_API: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    ADMIN_API_TOKEN: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.ENABLE_ADMIN_API && !cfg.ADMIN_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ADMIN_API_TOKEN"],
        message: "ADMIN_API_TOKEN is required when ENABLE_ADMIN_API=true",
      });
    }
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

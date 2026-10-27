/**
 * Primitives every admin subcommand shares.
 *
 * Extracted so the runners can live in topic files instead of one module:
 * `admin.ts` was past 1600 lines against the repo's own 800-line ceiling,
 * and the only thing holding it together was that `parseArgs`, the id
 * validators and the IO shim were module-private.
 */
import { z } from "zod";
import type { DbHandle } from "@/db/client.ts";
import type { EncryptionService } from "@/services/crypto/encryption.ts";

export interface AdminContext {
  db: DbHandle;
  encryption: EncryptionService;
}

export interface CliIO {
  write: (line: string) => void;
  err: (line: string) => void;
}

export const defaultIo: CliIO = {
  write: (line) => console.log(line),
  err: (line) => console.error(line),
};

// ─── Shared validators ────────────────────────────────────────────────────────

// tenant_<26-char Crockford ULID>. The ULID alphabet excludes I/L/O/U.
export const TenantId = z.string().regex(/^tenant_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid tenant_id");
export const KeyId = z.string().regex(/^key_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid key_id");
export const TenantName = z.string().trim().min(1).max(200);
export const KeyName = z.string().trim().min(1).max(200).optional();
export const KeyEnv = z.enum(["live", "test"]).default("live");

// ─── Arg parsing ──────────────────────────────────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = "true"; // valueless flag; schema decides meaning
    }
  }
  return { positional, flags };
}

export function reportZodIssues(io: CliIO, usage: string, err: z.ZodError): number {
  io.err(`${usage}`);
  for (const issue of err.issues) {
    io.err(`  - ${issue.path.join(".") || "(arg)"}: ${issue.message}`);
  }
  return 2;
}

/** Row-limit flag shared by the `*:list` subcommands. */
export const listLimit = (defaultValue: number) =>
  z.coerce.number().int().positive().max(500).default(defaultValue);

/**
 * Asks Apple to dispatch a synthetic V2 server notification to whatever
 * webhook URL is configured for the app in App Store Connect.
 *
 * Pure local diagnostic — does NOT touch Attesto's DB. You provide the .p8
 * + IDs directly. Useful for verifying:
 *   1. That you've put the right URL into App Store Connect
 *   2. That the App Store Server API endpoint Attesto targets is correct
 *   3. That your `.p8` / Key ID / Issuer ID / Bundle ID are mutually valid
 *
 * Apple endpoint: POST /inApps/v1/notifications/test
 *   Sandbox:    https://api.storekit-sandbox.itunes.apple.com
 *   Production: https://api.storekit.itunes.apple.com
 *
 * The configured URL is **whatever you set in App Store Connect** — Apple
 * doesn't take it as a request parameter. Sandbox env → Sandbox URL field.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/apple-test-notification.ts \
 *     --key-path </path/to/AuthKey_ABC123.p8> \
 *     --key-id <ABC123XYZ0> \
 *     --issuer-id <issuer-uuid> \
 *     --bundle-id <com.example.app> \
 *     [--env sandbox|production]   (default: sandbox)
 *
 * Or via the mise task:
 *   mise run apple:test-notification --key-path X --key-id Y --issuer-id Z \
 *     --bundle-id W [--env sandbox|production]
 */

import {
  type AppleTestNotificationEnv,
  requestAppleTestNotification,
} from "@/services/apple/test-notification.ts";
import { AppleApiError } from "@/services/apple/client.ts";

interface ParsedFlags {
  keyPath?: string;
  keyId?: string;
  issuerId?: string;
  bundleId?: string;
  env?: string;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    }
  }
  // Accept both --key-path and --keyPath spellings, mirroring admin.ts.
  return {
    keyPath: out["key-path"] ?? out.keyPath,
    keyId: out["key-id"] ?? out.keyId,
    issuerId: out["issuer-id"] ?? out.issuerId,
    bundleId: out["bundle-id"] ?? out.bundleId,
    env: out.env,
  };
}

const USAGE = `usage: apple-test-notification.ts \\
  --key-path </path/to/AuthKey.p8> \\
  --key-id <ABC123XYZ0> \\
  --issuer-id <issuer-uuid> \\
  --bundle-id <com.example.app> \\
  [--env sandbox|production]    (default: sandbox)`;

const flags = parseFlags(Deno.args);
const missing: string[] = [];
if (!flags.keyPath) missing.push("--key-path");
if (!flags.keyId) missing.push("--key-id");
if (!flags.issuerId) missing.push("--issuer-id");
if (!flags.bundleId) missing.push("--bundle-id");
if (missing.length > 0) {
  console.error(`error: missing required flag(s): ${missing.join(", ")}`);
  console.error(USAGE);
  Deno.exit(2);
}

const env = (flags.env ?? "sandbox") as AppleTestNotificationEnv;
if (env !== "sandbox" && env !== "production") {
  console.error(`error: --env must be 'sandbox' or 'production' (got '${flags.env}')`);
  Deno.exit(2);
}

let pem: string;
try {
  pem = await Deno.readTextFile(flags.keyPath!);
} catch (err) {
  console.error(
    `error: failed to read .p8 from ${flags.keyPath}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  Deno.exit(1);
}

try {
  const result = await requestAppleTestNotification({
    material: {
      bundleId: flags.bundleId!,
      keyId: flags.keyId!,
      issuerId: flags.issuerId!,
      privateKeyPem: pem,
      appAppleId: null,
    },
    env,
  });
  console.log(
    JSON.stringify(
      {
        env,
        testNotificationToken: result.testNotificationToken,
        hint:
          "Apple has dispatched the test notification. Watch your configured webhook URL for an inbound POST within ~15s.",
      },
      null,
      2,
    ),
  );
} catch (err) {
  if (err instanceof AppleApiError) {
    console.error(err.message);
    Deno.exit(1);
  }
  throw err;
}

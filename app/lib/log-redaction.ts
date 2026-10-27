/**
 * Redaction helpers for anything that reaches a log line.
 *
 * The rule this enforces: **no purchase token and no transaction id is ever
 * logged in plaintext.** Two things made that hard before:
 *
 *   1. Truncating a token ("abcd1234…wxyz") still publishes part of it, and
 *      tells an operator nothing a one-way handle wouldn't.
 *   2. Deno's `fetch` failure message embeds the *full request URL*, and both
 *      stores put the identifier in the URL path. Logging `err.message` from
 *      a transport failure therefore leaks the whole token — even on a line
 *      that carefully redacts its own `purchaseToken` field.
 */

const encoder = new TextEncoder();

/**
 * Per-process random salt.
 *
 * Deliberate: fingerprints correlate log lines **within one process's
 * lifetime**, which is what an operator reading a log actually needs, while
 * a captured log can never be brute-forced back to the identifiers. That
 * matters because Apple transaction ids are low-entropy enough that an
 * unsalted SHA-256 is reversible on a laptop — the same reasoning behind the
 * keyed hash in `services/audit/validation-audit.ts`.
 *
 * A salt rather than the master key so nothing has to thread
 * `ATTESTO_ENCRYPTION_KEY` down to every log statement.
 */
const salt = crypto.getRandomValues(new Uint8Array(32));

let keyPromise: Promise<CryptoKey> | null = null;

function hmacKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return keyPromise;
}

/**
 * A short, one-way handle for a sensitive identifier, safe to log.
 *
 * Returns `null` for an absent value so a caller can log "no token" without
 * fabricating a hash of the empty string.
 */
export async function logFingerprint(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(value));
  const hex = Array.from(new Uint8Array(mac).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `fp:${hex}`;
}

// Matches a URL up to the first whitespace or closing paren — Deno wraps the
// URL in parentheses in its fetch error text.
const URL_PATTERN = /\bhttps?:\/\/[^\s)]+/g;

/**
 * Remove every URL from a message before it is logged.
 *
 * Applied to upstream error text, which we do not construct and therefore
 * cannot trust to be free of identifiers.
 */
export function scrubUrls(message: string): string {
  return message.replace(URL_PATTERN, "<url>");
}

/** Convenience: the scrubbed message of an unknown thrown value. */
export function scrubbedErrorMessage(err: unknown): string {
  return scrubUrls(err instanceof Error ? err.message : String(err));
}

/**
 * HMAC-SHA256 signing + verification for outbound webhook deliveries.
 *
 * Wire format per PLAN.md §4.5:
 *   X-Attesto-Signature: t=<unix_ts>,v1=<hex_hmac>
 *
 * Signed value is `<timestamp>.<body>` — prepending the timestamp makes it
 * impossible for an attacker to replay a captured signature on a request
 * sent later (verifier enforces a 5-minute skew window).
 */

const DEFAULT_MAX_SKEW_SECONDS = 5 * 60;

export const ATTESTO_SIGNATURE_HEADER = "X-Attesto-Signature";
export const ATTESTO_TIMESTAMP_HEADER = "X-Attesto-Timestamp";
export const ATTESTO_EVENT_HEADER = "X-Attesto-Event";
export const ATTESTO_EVENT_ID_HEADER = "X-Attesto-Event-Id";

export interface SignOptions {
  secret: string;
  body: string;
  /** Override timestamp for deterministic tests. Seconds since epoch. */
  timestamp?: number;
}

export interface SignedHeaders {
  timestamp: number;
  signature: string; // hex
  headerValue: string; // "t=<ts>,v1=<hex>"
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const keyBytes = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payloadBytes = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    payloadBytes.buffer as ArrayBuffer,
  );
  return new Uint8Array(sig);
}

export async function signWebhook(opts: SignOptions): Promise<SignedHeaders> {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${opts.body}`;
  const sigBytes = await hmacSha256(opts.secret, payload);
  const signature = toHex(sigBytes);
  return {
    timestamp,
    signature,
    headerValue: `t=${timestamp},v1=${signature}`,
  };
}

function parseHeader(value: string | undefined): { t?: number; v1?: string } | null {
  if (!value) return null;
  const parts = value.split(",").map((p) => p.trim());
  const parsed: { t?: number; v1?: string } = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) return null;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
      parsed.t = n;
    } else if (k === "v1") {
      if (!/^[0-9a-fA-F]+$/.test(v)) return null;
      parsed.v1 = v.toLowerCase();
    }
  }
  return parsed;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyOptions {
  secret: string;
  body: string;
  headerValue: string | undefined;
  /** Override `now` for deterministic tests. Milliseconds since epoch. */
  nowMs?: number;
  /** Max drift between header `t` and `now`. Default 5 minutes. */
  maxSkewSeconds?: number;
}

export type VerifyFailureReason =
  | "missing_header"
  | "malformed_header"
  | "timestamp_out_of_window"
  | "signature_mismatch";

export interface VerifyResult {
  valid: boolean;
  reason?: VerifyFailureReason;
}

export async function verifyWebhookSignature(opts: VerifyOptions): Promise<VerifyResult> {
  const parsed = parseHeader(opts.headerValue);
  if (!opts.headerValue) return { valid: false, reason: "missing_header" };
  if (!parsed || parsed.t === undefined || parsed.v1 === undefined) {
    return { valid: false, reason: "malformed_header" };
  }
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const skew = Math.abs(nowSec - parsed.t);
  const maxSkew = opts.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (skew > maxSkew) return { valid: false, reason: "timestamp_out_of_window" };

  const payload = `${parsed.t}.${opts.body}`;
  const expected = toHex(await hmacSha256(opts.secret, payload));
  if (!timingSafeEqualHex(expected, parsed.v1)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

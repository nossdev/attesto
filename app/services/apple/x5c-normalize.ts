/**
 * JWS x5c chain normalization for Apple's `@apple/app-store-server-library`.
 *
 * The SDK requires `header.x5c.length === 3` (leaf + intermediate + root).
 * When the chain length is anything else, the SDK's verifyJWT() throws
 * VerificationException(INVALID_CHAIN_LENGTH=5) and silently re-classifies it
 * as INVALID_CERTIFICATE=6 in the surrounding catch block — so the failure
 * mode is opaque from the outside.
 *
 * Apple's signed App Store Server Notifications V2 payloads, in practice,
 * arrive with a 2-element x5c (leaf + intermediate) — the root is expected to
 * live in the verifier's trust store, which is the standard JOSE convention.
 * This module pads the chain to 3 by appending the matching trusted root,
 * looked up dynamically by the intermediate cert's issuer DN.
 *
 * Forward-compatible by design:
 *   - length === 3: pass through byte-for-byte (no mutation)
 *   - length === 2: append matching root (selected by intermediate.issuer)
 *   - any other length: pass through (let SDK reject as it would have)
 *
 * If Apple ever fixes the SDK or starts sending 3-element chains, the
 * length-3 branch returns the JWS unchanged — no behavior shift.
 */

import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { fromBase64Url, toBase64UrlString } from "@/lib/crypto-utils.ts";

/** Snapshot of what we observed in the JWS header — for diagnostic logging. */
export interface X5cObservation {
  length: number;
  /** Subject DN of each cert in chain order (leaf first). Apple cert DNs are
   * public information; safe to log. */
  certs: { subject: string; issuer: string }[];
}

export interface NormalizeResult {
  /** The (possibly-modified) JWS — pass this to the SDK verifier. */
  jws: string;
  observation: X5cObservation;
  /** True iff we mutated the chain (length was 2 → padded to 3). */
  modified: boolean;
  /** Set when length===2 and we couldn't find a matching trusted root. The
   * SDK will then reject the unmodified JWS (status 6), surfacing in logs. */
  rootLookupFailed?: boolean;
}

// JOSE compact-serialized JWS uses base64url for header/payload (RFC 7515),
// but the `x5c` entries themselves are standard base64 (not URL-safe) per
// the same RFC. So we reuse the project's base64url helpers from
// crypto-utils.ts for the header, and use Buffer's standard-base64 codec for
// individual cert entries.
const decoder = new TextDecoder();

/**
 * Normalize the x5c header of a JWS so it satisfies Apple's SDK's
 * length-must-equal-3 invariant.
 *
 * @param jws Compact-serialized JWS string (`header.payload.signature`).
 * @param trustedRoots DER-encoded root certificates we trust. Used to
 *   look up the right root to append when chain length is 2.
 */
export function normalizeJwsX5c(jws: string, trustedRoots: Uint8Array[]): NormalizeResult {
  const segments = jws.split(".");
  if (segments.length !== 3) {
    // Malformed JWS — let SDK handle it.
    return { jws, observation: { length: 0, certs: [] }, modified: false };
  }
  const headerSeg = segments[0]!;
  let header: { x5c?: unknown; [k: string]: unknown };
  try {
    header = JSON.parse(decoder.decode(fromBase64Url(headerSeg)));
  } catch {
    return { jws, observation: { length: 0, certs: [] }, modified: false };
  }

  // Defensive: x5c must be an array of strings per RFC 7515. Reject any
  // non-string entry rather than handing garbage to Buffer.from / X509.
  const x5c: string[] = Array.isArray(header.x5c) && header.x5c.every((s) => typeof s === "string")
    ? header.x5c as string[]
    : [];
  const observation: X5cObservation = {
    length: x5c.length,
    certs: x5c.map((b64) => {
      try {
        const cert = new X509Certificate(Buffer.from(b64, "base64"));
        return {
          subject: cert.subject.replace(/\n/g, "; "),
          issuer: cert.issuer.replace(/\n/g, "; "),
        };
      } catch {
        return { subject: "(unparseable)", issuer: "(unparseable)" };
      }
    }),
  };

  // Length 3 → no change. Length 0/1/4+ → pass through unchanged so the SDK
  // surfaces the failure cleanly via its own paths.
  if (x5c.length !== 2) {
    return { jws, observation, modified: false };
  }

  // Length 2: leaf + intermediate. Look up which trusted root matches the
  // intermediate's issuer DN.
  let intermediate: X509Certificate;
  try {
    intermediate = new X509Certificate(Buffer.from(x5c[1]!, "base64"));
  } catch {
    return { jws, observation, modified: false };
  }
  // Match by string-rendered DN. Both sides are produced by the same Node
  // X509Certificate impl in the same process, so attribute ordering and
  // formatting agree — we're not comparing across DER encoders. If we ever
  // add a non-Node cert source on either side, switch to comparing the raw
  // DER-encoded `subject` / `issuer` bytes (Node 19+ exposes these via
  // `.subjectRaw` / `.issuerRaw`).
  const intermediateIssuer = intermediate.issuer;
  let matchingRoot: Uint8Array | null = null;
  for (const der of trustedRoots) {
    try {
      const root = new X509Certificate(Buffer.from(der));
      if (root.subject === intermediateIssuer) {
        matchingRoot = der;
        break;
      }
    } catch {
      // skip unparseable root
    }
  }
  if (!matchingRoot) {
    return { jws, observation, modified: false, rootLookupFailed: true };
  }

  // Append the matching root and re-serialize the header. Buffer.from(...)
  // takes Uint8Array directly; .toString("base64") gives standard (not
  // URL-safe) base64, which is what `x5c` requires per RFC 7515.
  const rootB64 = Buffer.from(matchingRoot).toString("base64");
  const newHeader = { ...header, x5c: [...x5c, rootB64] };
  const newHeaderSeg = toBase64UrlString(JSON.stringify(newHeader));
  const newJws = `${newHeaderSeg}.${segments[1]}.${segments[2]}`;

  return {
    jws: newJws,
    observation,
    modified: true,
  };
}

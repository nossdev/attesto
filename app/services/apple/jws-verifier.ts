/**
 * Apple JWS signature verification via the official SDK.
 *
 * Apple's App Store Server Notifications V2 and App Store Server API responses
 * are JWS payloads signed by Apple. We verify the signature against Apple's
 * pinned root certificates (AppleInc / G2 / G3) — not just TLS — so that:
 *   - Webhook receivers can trust the origin without an IP allowlist
 *   - Verify-endpoint responses are cryptographically authenticated (defense
 *     in depth over TLS)
 *
 * Uses `@apple/app-store-server-library@^3` for:
 *   - X.509 chain walking with pinned roots
 *   - OCSP revocation checks (optional, default on)
 *   - Apple cert-rotation handling (SDK updates track it)
 *
 * Root certs are bundled as CER files under `./roots/` — `deno compile`
 * embeds them via `--include` so production binaries are self-contained.
 */

// deno-lint-ignore verbatim-module-syntax
import pkg from "npm:@apple/app-store-server-library@^3";
const { SignedDataVerifier, Environment } = pkg;

import type { AppleEnvironmentResolved } from "@/services/apple/types.ts";
import { normalizeJwsX5c } from "@/services/apple/x5c-normalize.ts";

/**
 * Narrow structural view of the SDK's `SignedDataVerifier`. The SDK's
 * own types are partial; casting once at construction (rather than at
 * every call site) localizes the `any` bridge.
 */
interface SignedDataVerifierLike {
  verifyAndDecodeNotification(signedPayload: string): Promise<unknown>;
  verifyAndDecodeTransaction(signedTransaction: string): Promise<unknown>;
}

// Resolve cert file paths relative to THIS file. Works in both `deno run` and
// `deno compile` (which embeds the files via --include).
const ROOT_DIR = new URL("./roots/", import.meta.url);
const ROOT_FILES = [
  "AppleIncRootCertificate.cer",
  "AppleRootCA-G2.cer",
  "AppleRootCA-G3.cer",
];

let cachedRoots: Uint8Array[] | null = null;

async function loadRootCerts(): Promise<Uint8Array[]> {
  if (cachedRoots) return cachedRoots;
  const roots: Uint8Array[] = [];
  for (const name of ROOT_FILES) {
    const path = new URL(name, ROOT_DIR);
    roots.push(await Deno.readFile(path));
  }
  cachedRoots = roots;
  return roots;
}

function toSdkEnvironment(env: AppleEnvironmentResolved): unknown {
  return env === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
}

export interface AppleJwsVerifierOptions {
  bundleId: string;
  environment: AppleEnvironmentResolved;
  /** Apple's numeric App ID. The SDK's SignedDataVerifier ctor REQUIRES this
   * for environment=production (throws otherwise). Sandbox doesn't need it. */
  appAppleId?: number;
  /** OCSP online checks — default on in production, off in tests. */
  enableOnlineChecks?: boolean;
  /** For testing: override loaded root certs with custom ones. */
  rootCertsOverride?: Uint8Array[];
}

export interface DecodedJwsPayload {
  [key: string]: unknown;
}

export interface AppleJwsVerifier {
  verifyNotification(signedPayload: string): Promise<DecodedJwsPayload>;
  verifyTransaction(signedTransaction: string): Promise<DecodedJwsPayload>;
}

export class AppleJwsVerificationError extends Error {
  /**
   * The original error from Apple's SDK. The SDK's `VerificationException`
   * extends Error but constructs with `super()` (no message), so `.message`
   * is empty and the real failure mode lives on `.status` (a numeric
   * `VerificationStatus` enum) and `.cause`. Preserving the original lets
   * callers log full context without us hard-coding the SDK's enum here.
   */
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AppleJwsVerificationError";
    this.cause = cause;
  }
}

async function createAppleJwsVerifier(
  opts: AppleJwsVerifierOptions,
): Promise<AppleJwsVerifier> {
  const roots = opts.rootCertsOverride ?? await loadRootCerts();
  // Single cast at construction — `any` confined to this one line; the
  // rest of the module uses the typed `SignedDataVerifierLike` view.
  // appAppleId is the 5th ctor arg; SDK validates it's set for production
  // (throws otherwise) and ignores it for sandbox.
  // deno-lint-ignore no-explicit-any
  const verifier = new (SignedDataVerifier as any)(
    roots,
    opts.enableOnlineChecks ?? true,
    toSdkEnvironment(opts.environment),
    opts.bundleId,
    opts.appAppleId,
  ) as SignedDataVerifierLike;

  // Log observed x5c shape once per (bundleId, env) — useful for confirming
  // whether Apple still ships 2-element chains, or whether the upstream
  // started sending 3 (in which case our normalizer becomes a no-op and we
  // could remove it eventually). Keyed by length+modified so we don't spam.
  const seenX5cShapes = new Set<string>();
  const observe = (where: string, normalized: ReturnType<typeof normalizeJwsX5c>) => {
    const key = `${where}:${normalized.observation.length}:${normalized.modified}`;
    if (seenX5cShapes.has(key)) return;
    seenX5cShapes.add(key);
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "apple_jws_x5c_observed",
        where,
        bundleId: opts.bundleId,
        environment: opts.environment,
        x5cLength: normalized.observation.length,
        modified: normalized.modified,
        rootLookupFailed: normalized.rootLookupFailed ?? false,
        certs: normalized.observation.certs,
      }),
    );
  };

  return {
    async verifyNotification(signedPayload) {
      // Apple's signed notifications arrive with x5c=[leaf, intermediate]
      // (no root). The SDK enforces length===3, so pad with the matching
      // bundled root before handing off. No-op when length is already 3.
      const normalized = normalizeJwsX5c(signedPayload, roots);
      observe("notification", normalized);
      try {
        const decoded = await verifier.verifyAndDecodeNotification(normalized.jws);
        return decoded as DecodedJwsPayload;
      } catch (err) {
        throw new AppleJwsVerificationError(
          err instanceof Error ? err.message : String(err),
          err,
        );
      }
    },
    async verifyTransaction(signedTransaction) {
      const normalized = normalizeJwsX5c(signedTransaction, roots);
      observe("transaction", normalized);
      try {
        const decoded = await verifier.verifyAndDecodeTransaction(normalized.jws);
        return decoded as DecodedJwsPayload;
      } catch (err) {
        throw new AppleJwsVerificationError(
          err instanceof Error ? err.message : String(err),
          err,
        );
      }
    },
  };
}

// ─── Per-(bundle, env) verifier cache ─────────────────────────────────────────
// SDK construction is expensive (reads cert bytes, imports crypto). For
// multi-tenant deployments we reuse verifiers keyed by (bundleId, env).

export interface AppleJwsVerifierCache {
  /**
   * Get (or construct) a verifier for a (bundleId, env, appAppleId) triple.
   * appAppleId is part of the cache key because the verifier instance bakes
   * it in — a tenant whose appAppleId moves from null → number gets a fresh
   * verifier under a new key, leaving the old (broken) entry as a small leak
   * that's never returned to a request again. We accept that leak for now;
   * the credentials-loader's TTL (5min) bounds how long stale credentials
   * stay served, and verifier instances are small.
   */
  get(
    bundleId: string,
    environment: AppleEnvironmentResolved,
    appAppleId?: number,
  ): Promise<AppleJwsVerifier>;
  /** Clear the entire cache (test cleanup, never used in prod). */
  clear(): void;
}

export interface CreateAppleJwsVerifierCacheOptions {
  enableOnlineChecks?: boolean;
  rootCertsOverride?: Uint8Array[];
}

export function createAppleJwsVerifierCache(
  opts: CreateAppleJwsVerifierCacheOptions = {},
): AppleJwsVerifierCache {
  const store = new Map<string, Promise<AppleJwsVerifier>>();

  return {
    get(bundleId, environment, appAppleId) {
      const key = `${bundleId}|${environment}|${appAppleId ?? ""}`;
      const existing = store.get(key);
      if (existing) return existing;
      const promise = createAppleJwsVerifier({
        bundleId,
        environment,
        appAppleId,
        enableOnlineChecks: opts.enableOnlineChecks,
        rootCertsOverride: opts.rootCertsOverride,
      }).catch((err) => {
        // Don't cache failed construction — remove and re-throw.
        store.delete(key);
        throw err;
      });
      store.set(key, promise);
      return promise;
    },
    clear() {
      store.clear();
    },
  };
}

/** Eagerly load root certs at boot so a missing file fails fast rather than
 * on the first webhook. */
export async function preloadAppleRootCerts(): Promise<void> {
  await loadRootCerts();
}

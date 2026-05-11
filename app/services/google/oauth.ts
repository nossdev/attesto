/**
 * Exchanges a service-account JWT for an OAuth 2.0 access token and caches it
 * until just before expiry. Google access tokens live ~1 hour; refreshing
 * within that window is cheap but not free, so we cache per tenant and
 * proactively expire 60s before Google's reported `expires_in`.
 */

import {
  ANDROIDPUBLISHER_SCOPE,
  signGoogleServiceAccountJwt,
} from "@/services/google/jwt-signer.ts";
import { createTtlCache, type TtlCache } from "@/lib/ttl-cache.ts";
import type { FetchLike } from "@/lib/http-utils.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";

const REFRESH_SKEW_SECONDS = 60;

export class GoogleOAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export interface AccessTokenProvider {
  /**
   * Returns a valid access token, fetching a new one if the cached one has expired.
   * `scope` defaults to androidpublisher (purchase-verification path). Pass an
   * explicit scope (e.g. `https://www.googleapis.com/auth/pubsub`) for callers
   * outside that path; the cache namespaces tokens per-scope so different
   * scopes don't collide.
   */
  getAccessToken(
    cacheKey: string,
    serviceAccount: GoogleServiceAccount,
    scope?: string,
  ): Promise<string>;
}

export interface CreateAccessTokenProviderOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
}

interface TokenEntry {
  token: string;
  expiresAt: number; // ms epoch
}

export function createAccessTokenProvider(
  opts: CreateAccessTokenProviderOptions = {},
): AccessTokenProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  // Tokens are cached keyed by tenant id; individual entries self-report
  // expiry via `expiresAt`, and the ttl-cache's TTL is a belt-and-braces
  // upper bound. We use a very long cache TTL (2h) because the real
  // expiry check is `expiresAt`; the TTL just prevents unbounded growth.
  const cache: TtlCache<TokenEntry> = createTtlCache({ ttlMs: 2 * 60 * 60 * 1000, now });

  async function fetchFresh(sa: GoogleServiceAccount, scope?: string): Promise<TokenEntry> {
    const jwt = await signGoogleServiceAccountJwt({
      privateKeyPem: sa.private_key,
      clientEmail: sa.client_email,
      tokenUri: sa.token_uri,
      scope,
      now: () => now(),
    });
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });
    const response = await fetchImpl(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new GoogleOAuthError(
        `Google OAuth exchange failed: ${response.status}`,
        response.status,
      );
    }
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token || typeof data.expires_in !== "number") {
      throw new GoogleOAuthError(
        "Google OAuth response missing access_token or expires_in",
        response.status,
      );
    }
    return {
      token: data.access_token,
      expiresAt: now() + (data.expires_in - REFRESH_SKEW_SECONDS) * 1000,
    };
  }

  return {
    async getAccessToken(cacheKey, serviceAccount, scope) {
      // Always namespace by scope (defaulting to androidpublisher to match
      // jwt-signer's default) so tokens minted under different scopes can
      // never alias. Resolving the default here — rather than only when an
      // explicit scope is passed — closes a foot-gun where a future caller
      // omitting `scope` and expecting some non-androidpublisher default
      // would silently collide with existing androidpublisher entries.
      const effectiveScope = scope ?? ANDROIDPUBLISHER_SCOPE;
      const namespacedKey = `${cacheKey}::${effectiveScope}`;
      const cached = cache.get(namespacedKey);
      if (cached && cached.expiresAt > now()) return cached.token;
      // Use loadOrFetch to dedupe concurrent refreshes on cold-cache or
      // expired-entry boundaries. If cached but expired, evict first so
      // loadOrFetch actually loads.
      if (cached) cache.delete(namespacedKey);
      const entry = await cache.loadOrFetch(
        namespacedKey,
        () => fetchFresh(serviceAccount, effectiveScope),
      );
      return entry.token;
    },
  };
}

/**
 * Google subscription upgrade-chain resolution.
 *
 * Google issues a NEW `purchaseToken` whenever a user moves between SKUs
 * within a subscription group (monthly → annual, basic → premium). The new
 * SubscriptionPurchaseV2 record carries `linkedPurchaseToken` pointing at
 * the prior token. Without help, every webhook for the new token would
 * miss the integrator's `(google, original_token) → user_id` mapping.
 *
 * This module:
 *   - records `(currentToken, previousToken)` pairs as Attesto sees them
 *     (idempotent — duplicate INSERTs are no-ops)
 *   - walks the chain backward to find the **root token** (the original
 *     subscription, oldest token Attesto has ever recorded a link from)
 *
 * The root token is what we surface as `subject.key` on the outbound
 * webhook payload. Result: integrator's first-verify mapping just works
 * across upgrades — no fallback logic on their side.
 *
 * Cycle / depth safety: a real Google chain is short (typical: 1-2 hops
 * per upgrade). We cap the walk at MAX_CHAIN_DEPTH to defend against any
 * pathological input (cycles can't happen via Google's data — `linked` is
 * always a strictly older token — but better to fail loud than spin).
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { googlePurchaseChains } from "@/db/schema.ts";

const MAX_CHAIN_DEPTH = 16;

export interface RecordChainLinkInput {
  tenantId: string;
  currentToken: string;
  previousToken: string;
}

/**
 * Record a chain link. Idempotent: if the same `(tenantId, currentToken)`
 * already exists, this is a no-op (we never overwrite a previous_token
 * because Google's link is immutable per token).
 */
export async function recordChainLink(
  db: Database,
  input: RecordChainLinkInput,
): Promise<void> {
  if (!input.currentToken || !input.previousToken) return;
  if (input.currentToken === input.previousToken) return; // self-link guard
  await db
    .insert(googlePurchaseChains)
    .values({
      tenantId: input.tenantId,
      currentToken: input.currentToken,
      previousToken: input.previousToken,
    })
    .onConflictDoNothing({
      target: [googlePurchaseChains.tenantId, googlePurchaseChains.currentToken],
    });
}

/**
 * Walk the chain backward from `token` and return the root — the oldest
 * predecessor we have on file. If `token` has no recorded link, returns
 * `token` unchanged (it's already a root from our point of view).
 *
 * Stops if the walk exceeds `MAX_CHAIN_DEPTH` (defensive). On overflow,
 * returns the deepest token seen and logs a warn so operators can spot
 * pathological data.
 */
export async function resolveToRoot(
  db: Database,
  tenantId: string,
  token: string,
): Promise<string> {
  let cursor = token;
  const seen = new Set<string>([cursor]);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const rows = await db
      .select({ previousToken: googlePurchaseChains.previousToken })
      .from(googlePurchaseChains)
      .where(
        and(
          eq(googlePurchaseChains.tenantId, tenantId),
          eq(googlePurchaseChains.currentToken, cursor),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return cursor; // reached a root — `cursor` has no predecessor
    if (seen.has(row.previousToken)) {
      // Cycle. Shouldn't happen given Google's invariants, but defend.
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "google_chain_cycle_detected",
          tenantId,
          token,
          cursor,
        }),
      );
      return cursor;
    }
    seen.add(row.previousToken);
    cursor = row.previousToken;
  }
  // Hit the depth cap — log so an operator can investigate. Returning the
  // deepest seen value is harmless; if a chain really is longer than 16
  // hops, the integrator's mapping for `cursor` may not be the absolute
  // root, but it's still a stable canonical key for everything below this
  // point in the chain.
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "google_chain_depth_exceeded",
      tenantId,
      startToken: token,
      maxDepth: MAX_CHAIN_DEPTH,
    }),
  );
  return cursor;
}

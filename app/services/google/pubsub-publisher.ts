/**
 * Publishes messages to a Google Cloud Pub/Sub topic via the REST API.
 *
 * Used by `webhook:probe` to inject a synthetic Google `testNotification`
 * end-to-end through the chain (Pub/Sub publish → Google delivers via push
 * subscription → Attesto receiver verifies OIDC → outbound webhook to backend).
 *
 * Auth: a short-lived OAuth access token minted from the tenant's stored
 * service-account JSON, scoped to `https://www.googleapis.com/auth/pubsub`.
 * The service account must have `roles/pubsub.publisher` on the topic.
 *
 * REST endpoint: https://pubsub.googleapis.com/v1/{topic}:publish
 * Body: { messages: [{ data: <base64>, attributes? }] }
 * Response: { messageIds: ["<id>"] }
 */

import type { AccessTokenProvider } from "@/services/google/oauth.ts";
import type { GoogleServiceAccount } from "@/services/google/types.ts";
import type { FetchLike } from "@/lib/http-utils.ts";

const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";
const PUBSUB_BASE_URL = "https://pubsub.googleapis.com/v1/";

export class PubSubPublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly topic: string,
  ) {
    super(message);
    this.name = "PubSubPublishError";
  }
}

export interface PubSubPublishOpts {
  tenantId: string;
  serviceAccount: GoogleServiceAccount;
  topic: string; // projects/<project>/topics/<name>
  data: Record<string, unknown>;
  attributes?: Record<string, string>;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: FetchLike;
}

export interface PubSubPublishResult {
  messageId: string;
}

export async function publishPubSubMessage(
  opts: PubSubPublishOpts,
): Promise<PubSubPublishResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const accessToken = await opts.tokenProvider.getAccessToken(
    opts.tenantId,
    opts.serviceAccount,
    PUBSUB_SCOPE,
  );
  const url = `${PUBSUB_BASE_URL}${opts.topic}:publish`;
  const body = {
    messages: [
      {
        data: encodeBase64(JSON.stringify(opts.data)),
        ...(opts.attributes ? { attributes: opts.attributes } : {}),
      },
    ],
  };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Body is read so the response stream is drained, but we DO NOT echo it
    // into the thrown message. Google's error envelopes can include the
    // rejecting service-account email and project numbers in `details[]`.
    // The probe's whole purpose is to share output with the backend dev /
    // paste into a chat or issue, so leaking those identifiers is a real
    // exposure. Operators can still get the upstream body via Fly logs
    // when needed.
    await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new PubSubPublishError(
        `Pub/Sub publish forbidden (${response.status}): the configured service ` +
          `account lacks roles/pubsub.publisher on topic ${opts.topic}. Grant ` +
          `the role on the topic and retry.`,
        response.status,
        opts.topic,
      );
    }
    if (response.status === 404) {
      throw new PubSubPublishError(
        `Pub/Sub topic not found (404): ${opts.topic}. Confirm the topic exists ` +
          `in the project and the resource name matches projects/<project>/topics/<name>.`,
        response.status,
        opts.topic,
      );
    }
    throw new PubSubPublishError(
      `Pub/Sub publish failed: ${response.status}`,
      response.status,
      opts.topic,
    );
  }

  const json = await response.json() as { messageIds?: string[] };
  const id = json.messageIds?.[0];
  if (!id) {
    throw new PubSubPublishError(
      `Pub/Sub publish returned no messageId for ${opts.topic}`,
      response.status,
      opts.topic,
    );
  }
  return { messageId: id };
}

function encodeBase64(input: string): string {
  // Standard base64 (NOT base64url — Pub/Sub's data field expects the padded
  // RFC 4648 §4 form). UTF-8 safe via TextEncoder → byte-by-byte binary string.
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

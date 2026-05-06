import { assert, assertEquals } from "@std/assert";
import {
  attemptDelivery,
  DEFAULT_MAX_RETRIES,
  RETRY_SCHEDULE_SECONDS,
} from "@/services/webhooks/delivery.ts";
import type { WebhookDelivery, WebhookEvent } from "@/db/schema.ts";

// Fixture builders — keep callers tight by defaulting noise.

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: "evt_01HXY",
    tenantId: "tenant_01HXY",
    source: "apple",
    externalId: "uuid-test",
    eventType: "apple.did_renew",
    rawPayload: {},
    decodedPayload: {},
    subjectKey: null,
    appUserId: null,
    receivedAt: new Date("2026-04-27T00:00:00Z"),
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: "del_01HXY",
    eventId: "evt_01HXY",
    tenantId: "tenant_01HXY",
    callbackUrl: "https://callback.example/hook",
    attemptCount: 0,
    status: "pending",
    lastAttemptAt: null,
    nextAttemptAt: new Date("2026-04-27T00:00:00Z"),
    lastResponseCode: null,
    lastResponseBody: null,
    deliveredAt: null,
    failedAt: null,
    createdAt: new Date("2026-04-27T00:00:00Z"),
    ...overrides,
  };
}

function failingFetch(status = 500): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "boom" }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

const NOW = () => new Date("2026-04-27T00:00:00Z");

Deno.test(
  "attemptDelivery: respects maxRetries cap — failed outcome at the cap, not retry",
  async () => {
    // attemptCount=1 means we just made our 2nd attempt (index into the
    // schedule). With maxRetries=2, we should declare failed (no more retries
    // budgeted) instead of computing the next backoff.
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 2 }),
      event: makeEvent(),
      secret: "test-secret",
      fetchImpl: failingFetch(500),
      now: NOW,
      maxRetries: 2,
    });
    assertEquals(result.outcome, "failed");
    assertEquals(result.responseCode, 500);
    assert(result.nextAttemptAt === undefined, "no nextAttemptAt for failed outcome");
  },
);

Deno.test(
  "attemptDelivery: under maxRetries → retry with backoff from schedule",
  async () => {
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 0 }),
      event: makeEvent(),
      secret: "test-secret",
      fetchImpl: failingFetch(500),
      now: NOW,
      maxRetries: 5,
    });
    assertEquals(result.outcome, "retry");
    // attemptCount=0 → next backoff is RETRY_SCHEDULE_SECONDS[0] (30s)
    assert(result.nextAttemptAt !== undefined);
    assertEquals(
      result.nextAttemptAt!.getTime() - NOW().getTime(),
      RETRY_SCHEDULE_SECONDS[0]! * 1000,
    );
  },
);

Deno.test(
  "attemptDelivery: defaults to DEFAULT_MAX_RETRIES when caller omits the cap",
  async () => {
    // attemptCount === DEFAULT_MAX_RETRIES → exhausted with the default cap;
    // expect failed even though no explicit cap was passed.
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: DEFAULT_MAX_RETRIES }),
      event: makeEvent(),
      secret: "test-secret",
      fetchImpl: failingFetch(500),
      now: NOW,
    });
    assertEquals(result.outcome, "failed");
  },
);

Deno.test(
  "attemptDelivery: respects timeoutMs — slow fetch aborts and counts as failure for this round",
  async () => {
    let abortedSignal: AbortSignal | null = null;
    const slowFetch: typeof fetch = (_url, init) => {
      abortedSignal = (init as { signal?: AbortSignal })?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        // Never resolves on its own — only the controller.abort() can end it.
        if (abortedSignal) {
          abortedSignal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      });
    };

    const start = Date.now();
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 0 }),
      event: makeEvent(),
      secret: "test-secret",
      fetchImpl: slowFetch,
      now: NOW,
      timeoutMs: 50, // short — verifies the override path actually fires
      maxRetries: 5,
    });
    const elapsed = Date.now() - start;
    // Aborted within ~the configured timeout (with generous slack).
    assert(
      elapsed < 500,
      `expected quick abort via timeoutMs=50, took ${elapsed}ms`,
    );
    // The attempt registers as a network error (no response code), schedules
    // a retry per the backoff schedule.
    assertEquals(result.outcome, "retry");
    assertEquals(result.responseCode, null);
    // The error message ("aborted") got captured into responseBody.
    assert(
      result.responseBody !== null && result.responseBody.toLowerCase().includes("abort"),
      `expected aborted message in responseBody, got: ${result.responseBody}`,
    );
  },
);

Deno.test(
  "attemptDelivery: 2xx response → delivered (sanity check that wiring didn't regress)",
  async () => {
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 0 }),
      event: makeEvent(),
      secret: "test-secret",
      fetchImpl: () => Promise.resolve(new Response("ok", { status: 200 })),
      now: NOW,
    });
    assertEquals(result.outcome, "delivered");
    assertEquals(result.responseCode, 200);
  },
);

Deno.test(
  "attemptDelivery: outbound payload surfaces appUserId top-level when event row has it",
  async () => {
    let capturedBody: string | null = null;
    const captureFetch: typeof fetch = (_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : null;
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const result = await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 0 }),
      event: makeEvent({ appUserId: "11111111-2222-4333-8444-555555555555" }),
      secret: "test-secret",
      fetchImpl: captureFetch,
      now: NOW,
    });
    assertEquals(result.outcome, "delivered");
    assert(capturedBody !== null, "expected body captured");
    const payload = JSON.parse(capturedBody!) as Record<string, unknown>;
    assertEquals(payload.appUserId, "11111111-2222-4333-8444-555555555555");
  },
);

Deno.test(
  "attemptDelivery: outbound payload appUserId is null when event row has no appUserId",
  async () => {
    let capturedBody: string | null = null;
    const captureFetch: typeof fetch = (_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : null;
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    await attemptDelivery({
      delivery: makeDelivery({ attemptCount: 0 }),
      event: makeEvent({ appUserId: null }),
      secret: "test-secret",
      fetchImpl: captureFetch,
      now: NOW,
    });
    assert(capturedBody !== null);
    const payload = JSON.parse(capturedBody!) as Record<string, unknown>;
    // Field always present in the envelope (additive contract); null when
    // the original purchase didn't carry an appAccountToken.
    assert("appUserId" in payload, "appUserId must be a top-level key");
    assertEquals(payload.appUserId, null);
  },
);

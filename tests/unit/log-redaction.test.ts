import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { logFingerprint, scrubUrls } from "@/lib/log-redaction.ts";

const TOKEN = "mnopqrstuvwxyzabcdefghij.AO-J1OyFAKEPURCHASETOKENVALUE1234567890abcdefghijklmnop";

Deno.test("logFingerprint: never contains any run of the original value", async () => {
  const fp = await logFingerprint(TOKEN);
  assert(fp !== null);

  // Slide a window over the token: no 8-char run of it may survive.
  for (let i = 0; i + 8 <= TOKEN.length; i++) {
    assert(
      !fp.includes(TOKEN.slice(i, i + 8)),
      `fingerprint leaked "${TOKEN.slice(i, i + 8)}"`,
    );
  }
});

Deno.test("logFingerprint: is stable within a process, so log lines correlate", async () => {
  assertEquals(await logFingerprint(TOKEN), await logFingerprint(TOKEN));
});

Deno.test("logFingerprint: different values get different fingerprints", async () => {
  assertNotEquals(await logFingerprint(TOKEN), await logFingerprint(`${TOKEN}x`));
});

Deno.test("logFingerprint: is tagged and short enough to read in a log line", async () => {
  const fp = await logFingerprint(TOKEN);
  assert(fp !== null);

  assertStringIncludes(fp, "fp:");
  assert(fp.length <= 24, `fingerprint too long for a log line: ${fp}`);
});

Deno.test("logFingerprint: an empty value is reported as absent, not hashed", async () => {
  assertEquals(await logFingerprint(""), null);
});

Deno.test("scrubUrls: strips a URL whose path carries a purchase token", () => {
  // This is the real leak: Deno's fetch failure message embeds the full
  // request URL, and the Play API puts the purchase token in the path.
  const message =
    `error sending request for url (https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/purchases/subscriptionsv2/tokens/${TOKEN}): client error`;

  const scrubbed = scrubUrls(message);

  assert(!scrubbed.includes(TOKEN), `token survived: ${scrubbed}`);
  assert(!scrubbed.includes("androidpublisher.googleapis.com"));
  assertStringIncludes(scrubbed, "error sending request for url");
  assertStringIncludes(scrubbed, "client error");
});

Deno.test("scrubUrls: strips an Apple URL carrying a transaction id", () => {
  const message =
    "error sending request for url (https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/2000000000123456): dns error";

  const scrubbed = scrubUrls(message);

  assert(!scrubbed.includes("2000000000123456"));
  assertStringIncludes(scrubbed, "dns error");
});

Deno.test("scrubUrls: strips every URL when a message carries more than one", () => {
  const scrubbed = scrubUrls("redirect https://a.example/tok-aaa to http://b.example/tok-bbb now");

  assert(!scrubbed.includes("tok-aaa"));
  assert(!scrubbed.includes("tok-bbb"));
  assertStringIncludes(scrubbed, "now");
});

Deno.test("scrubUrls: leaves a message with no URL untouched", () => {
  assertEquals(scrubUrls("google returned 503"), "google returned 503");
});

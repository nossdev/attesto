import { assert, assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { normalizeJwsX5c } from "@/services/apple/x5c-normalize.ts";

const ROOTS_DIR = new URL("../../app/services/apple/roots/", import.meta.url);
const ROOT_FILES = [
  "AppleIncRootCertificate.cer",
  "AppleRootCA-G2.cer",
  "AppleRootCA-G3.cer",
] as const;

async function loadBundledRoots(): Promise<Uint8Array[]> {
  return await Promise.all(
    ROOT_FILES.map((name) => Deno.readFile(new URL(name, ROOTS_DIR))),
  );
}

function b64urlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwsWithX5c(x5cB64Std: string[]): string {
  const header = { alg: "ES256", x5c: x5cB64Std };
  const payload = { data: { bundleId: "com.example.app", environment: "Sandbox" } };
  return `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}.AAAA`;
}

Deno.test("normalizeJwsX5c: length 3 returns JWS unchanged byte-for-byte", async () => {
  const roots = await loadBundledRoots();
  const rootB64 = Buffer.from(roots[2]!).toString("base64"); // G3
  const original = makeJwsWithX5c(["LEAF", "INTER", rootB64]);
  const result = normalizeJwsX5c(original, roots);
  assertEquals(result.modified, false);
  assertEquals(result.jws, original);
  assertEquals(result.observation.length, 3);
});

Deno.test("normalizeJwsX5c: length 2 with intermediate issued by G3 → appends G3", async () => {
  const roots = await loadBundledRoots();
  // Use G3 itself as the "intermediate" — its issuer is its own subject (it's
  // a self-signed root), so the lookup will find G3 in trustedRoots.
  const g3Der = roots[2]!;
  const interB64 = Buffer.from(g3Der).toString("base64");
  const jws = makeJwsWithX5c(["LEAF", interB64]);
  const result = normalizeJwsX5c(jws, roots);
  assertEquals(result.modified, true);
  assertEquals(result.rootLookupFailed, undefined);
  // Decode the new header and inspect x5c
  const newHeader = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(
          result.jws.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (result.jws.split(".")[0]!.length % 4)) % 4),
        ),
        (c) => c.charCodeAt(0),
      ),
    ),
  ) as { x5c: string[] };
  assertEquals(newHeader.x5c.length, 3);
  assertEquals(newHeader.x5c[0], "LEAF");
  assertEquals(newHeader.x5c[1], interB64);
  // Third element is the appended root — must be valid base64 of G3 DER bytes
  assertEquals(newHeader.x5c[2], Buffer.from(g3Der).toString("base64"));
});

Deno.test("normalizeJwsX5c: length 2 with no matching root → unchanged + flag set", async () => {
  // Pass an empty trustedRoots list — no root can match.
  const g3Der = await Deno.readFile(new URL("AppleRootCA-G3.cer", ROOTS_DIR));
  const jws = makeJwsWithX5c(["LEAF", Buffer.from(g3Der).toString("base64")]);
  const result = normalizeJwsX5c(jws, []);
  assertEquals(result.modified, false);
  assertEquals(result.rootLookupFailed, true);
  assertEquals(result.jws, jws);
});

Deno.test("normalizeJwsX5c: length 0 (no x5c header) → unchanged, length 0 observation", async () => {
  const roots = await loadBundledRoots();
  const headerNoX5c = b64urlEncode(JSON.stringify({ alg: "ES256" }));
  const payload = b64urlEncode(JSON.stringify({}));
  const jws = `${headerNoX5c}.${payload}.AAAA`;
  const result = normalizeJwsX5c(jws, roots);
  assertEquals(result.modified, false);
  assertEquals(result.jws, jws);
  assertEquals(result.observation.length, 0);
});

Deno.test("normalizeJwsX5c: length 4 (oversized chain) → unchanged", async () => {
  const roots = await loadBundledRoots();
  const jws = makeJwsWithX5c(["A", "B", "C", "D"]);
  const result = normalizeJwsX5c(jws, roots);
  assertEquals(result.modified, false);
  assertEquals(result.jws, jws);
  assertEquals(result.observation.length, 4);
});

Deno.test("normalizeJwsX5c: malformed JWS (not 3 segments) → unchanged", async () => {
  const roots = await loadBundledRoots();
  const result = normalizeJwsX5c("not.a.valid.jws", roots);
  assertEquals(result.modified, false);
  assertEquals(result.jws, "not.a.valid.jws");
});

Deno.test("normalizeJwsX5c: malformed header (non-JSON) → unchanged", async () => {
  const roots = await loadBundledRoots();
  const jws = `${b64urlEncode("not json")}.${b64urlEncode("{}")}.AAAA`;
  const result = normalizeJwsX5c(jws, roots);
  assertEquals(result.modified, false);
  assertEquals(result.jws, jws);
});

Deno.test("normalizeJwsX5c: length 2 with garbage intermediate → unchanged", async () => {
  const roots = await loadBundledRoots();
  // Valid base64 but not a parseable cert
  const jws = makeJwsWithX5c(["LEAF", btoa("not a cert")]);
  const result = normalizeJwsX5c(jws, roots);
  assertEquals(result.modified, false);
  // observation.certs[1] should report unparseable
  assertEquals(result.observation.certs[1]?.subject, "(unparseable)");
});

Deno.test("normalizeJwsX5c: observation captures cert subjects for valid certs", async () => {
  const roots = await loadBundledRoots();
  const g3Der = roots[2]!;
  const g3B64 = Buffer.from(g3Der).toString("base64");
  const jws = makeJwsWithX5c([g3B64, g3B64]); // both = G3 (just for inspection)
  const result = normalizeJwsX5c(jws, roots);
  assert(result.observation.certs[0]!.subject.includes("Apple Root CA - G3"));
  assert(result.observation.certs[1]!.subject.includes("Apple Root CA - G3"));
});

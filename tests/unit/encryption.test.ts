import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { createEncryptionService } from "@/services/crypto/encryption.ts";

const TEST_KEY_B64 = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1hYmM=";
const OTHER_KEY_B64 = "YWx0ZXJuYXRlLWVuYy1rZXktMzItYnl0ZXMteHl6eno=";

function enc(): ReturnType<typeof createEncryptionService> {
  return createEncryptionService(TEST_KEY_B64);
}

Deno.test("encryption: round-trip preserves plaintext bytes", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("hello world 🔐");
  const ct = await service.encrypt(plaintext, "apple_credentials.private_key");
  const pt = await service.decrypt(ct, "apple_credentials.private_key");
  assertEquals(pt, plaintext);
});

Deno.test("encryption: round-trip handles empty plaintext", async () => {
  const service = enc();
  const plaintext = new Uint8Array(0);
  const ct = await service.encrypt(plaintext, "webhook_configs.secret");
  const pt = await service.decrypt(ct, "webhook_configs.secret");
  assertEquals(pt.length, 0);
});

Deno.test("encryption: encryptString / decryptString helpers", async () => {
  const service = enc();
  const original = "p8 key content that could be multi-line\nline 2";
  const ct = await service.encryptString(original, "apple_credentials.private_key");
  const back = await service.decryptString(ct, "apple_credentials.private_key");
  assertEquals(back, original);
});

Deno.test("encryption: ciphertext is longer than plaintext (nonce + tag)", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("short");
  const ct = await service.encrypt(plaintext, "ctx");
  // Layout: 12-byte nonce || ciphertext || 16-byte tag.
  assertEquals(ct.length, plaintext.length + 12 + 16);
});

Deno.test("encryption: two encryptions of same plaintext produce different ciphertext (random nonce)", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("same message");
  const a = await service.encrypt(plaintext, "ctx");
  const b = await service.encrypt(plaintext, "ctx");
  assertNotEquals(a, b);
});

function flipBit(input: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(input);
  const byte = copy.at(index);
  if (byte === undefined) throw new Error(`index ${index} out of range (len ${copy.length})`);
  copy.set([byte ^ 0x01], index);
  return copy;
}

Deno.test("encryption: tampered ciphertext body fails to decrypt", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("authentic");
  const ct = await service.encrypt(plaintext, "ctx");
  // Flip a bit in the ciphertext middle (past nonce, before tag).
  const tampered = flipBit(ct, 15);
  await assertRejects(() => service.decrypt(tampered, "ctx"), Error);
});

Deno.test("encryption: tampered tag fails to decrypt", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("authentic");
  const ct = await service.encrypt(plaintext, "ctx");
  const tampered = flipBit(ct, ct.length - 1);
  await assertRejects(() => service.decrypt(tampered, "ctx"), Error);
});

Deno.test("encryption: tampered nonce fails to decrypt", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("authentic");
  const ct = await service.encrypt(plaintext, "ctx");
  const tampered = flipBit(ct, 0);
  await assertRejects(() => service.decrypt(tampered, "ctx"), Error);
});

Deno.test("encryption: wrong context fails to decrypt (HKDF key separation)", async () => {
  const service = enc();
  const plaintext = new TextEncoder().encode("bound to context");
  const ct = await service.encrypt(plaintext, "apple_credentials.private_key");
  await assertRejects(
    () => service.decrypt(ct, "google_credentials.service_account"),
    Error,
  );
});

Deno.test("encryption: wrong master key fails to decrypt", async () => {
  const alice = createEncryptionService(TEST_KEY_B64);
  const bob = createEncryptionService(OTHER_KEY_B64);
  const plaintext = new TextEncoder().encode("alice's secret");
  const ct = await alice.encrypt(plaintext, "ctx");
  await assertRejects(() => bob.decrypt(ct, "ctx"), Error);
});

Deno.test("encryption: too-short ciphertext rejected immediately (not a GCM error)", async () => {
  const service = enc();
  const tooShort = new Uint8Array(5);
  await assertRejects(() => service.decrypt(tooShort, "ctx"), Error, "ciphertext");
});

Deno.test("encryption: constructor rejects invalid master key", () => {
  let threw = false;
  try {
    createEncryptionService("not-valid-base64!!");
  } catch {
    threw = true;
  }
  assert(threw, "should reject non-base64 master key");
});

Deno.test("encryption: constructor rejects base64 key that decodes to wrong length", () => {
  let threw = false;
  try {
    createEncryptionService("dG9vLXNob3J0"); // 9 bytes, not 32
  } catch {
    threw = true;
  }
  assert(threw, "should reject wrong-length master key");
});

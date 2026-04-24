/**
 * AES-256-GCM encryption with HKDF-derived per-context subkeys.
 *
 * Storage layout: `nonce (12 bytes) || ciphertext || tag (16 bytes)`.
 *
 * The master key comes from ATTESTO_ENCRYPTION_KEY (base64, 32 bytes). Each
 * call derives a distinct AES-256 subkey via HKDF-SHA-256 using the `context`
 * string as `info`, so the same master key protects every column but no two
 * columns share an encryption key. Compromising the plaintext of one column
 * does not weaken any other column.
 *
 * `hmacHex` uses the same master key but derives a SEPARATE HMAC key via a
 * distinct info namespace (`hmac/<context>`). It lets callers produce
 * unlinkable content-addressable identifiers (e.g. `validation_audit.identifier_hash`)
 * that can't be offline-brute-forced without the master key.
 */

const MASTER_KEY_BYTES = 32;
const AES_KEY_BITS = 256;
const NONCE_BYTES = 12;
// AES-GCM tag is 16 bytes, appended after ciphertext in Web Crypto output.
const MIN_CIPHERTEXT_BYTES = NONCE_BYTES + 16;

// HKDF salt is a fixed domain-separation constant. It's not secret; its purpose
// is to make key derivation from the same master key deterministic and
// distinguishable from any other HKDF usage that might share the master key.
const HKDF_SALT = new TextEncoder().encode("attesto/v1/encryption-at-rest");

export interface EncryptionService {
  encrypt(plaintext: Uint8Array, context: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, context: string): Promise<Uint8Array>;
  encryptString(plaintext: string, context: string): Promise<Uint8Array>;
  decryptString(ciphertext: Uint8Array, context: string): Promise<string>;
  /**
   * HMAC-SHA256 of `value` keyed by an HKDF-derived subkey scoped to
   * `context`. Returns hex. The HMAC key space is separated from AES
   * subkeys by an `hmac/` prefix in HKDF info, so the same `context`
   * passed to encrypt/decrypt and hmacHex cannot collide.
   */
  hmacHex(value: string, context: string): Promise<string>;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

// Web Crypto API wants BufferSource backed by ArrayBuffer specifically.
// TS 5.7+ distinguishes Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>,
// so we copy into a guaranteed-ArrayBuffer view before passing to crypto.subtle.
function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function deriveSubkey(masterKey: CryptoKey, context: string): Promise<CryptoKey> {
  const info = asArrayBuffer(new TextEncoder().encode(context));
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(HKDF_SALT), info },
    masterKey,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveHmacKey(masterKey: CryptoKey, context: string): Promise<CryptoKey> {
  const info = asArrayBuffer(new TextEncoder().encode(`hmac/${context}`));
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asArrayBuffer(HKDF_SALT), info },
    masterKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export function createEncryptionService(masterKeyBase64: string): EncryptionService {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(masterKeyBase64);
  } catch (err) {
    throw new Error(`encryption: master key is not valid base64: ${String(err)}`);
  }
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `encryption: master key must decode to ${MASTER_KEY_BYTES} bytes, got ${bytes.length}`,
    );
  }

  let masterKeyPromise: Promise<CryptoKey> | null = null;
  function getMasterKey(): Promise<CryptoKey> {
    if (!masterKeyPromise) {
      masterKeyPromise = crypto.subtle.importKey(
        "raw",
        asArrayBuffer(bytes),
        { name: "HKDF" },
        false,
        ["deriveKey"],
      );
    }
    return masterKeyPromise;
  }

  async function encrypt(plaintext: Uint8Array, context: string): Promise<Uint8Array> {
    const subkey = await deriveSubkey(await getMasterKey(), context);
    const nonce = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(nonce);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: asArrayBuffer(nonce) },
        subkey,
        asArrayBuffer(plaintext),
      ),
    );
    // `sealed` already contains ciphertext || tag per Web Crypto's AES-GCM output.
    const out = new Uint8Array(nonce.length + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, nonce.length);
    return out;
  }

  async function decrypt(ciphertext: Uint8Array, context: string): Promise<Uint8Array> {
    if (ciphertext.length < MIN_CIPHERTEXT_BYTES) {
      throw new Error(
        `encryption: ciphertext too short (got ${ciphertext.length} bytes, need at least ${MIN_CIPHERTEXT_BYTES})`,
      );
    }
    const nonce = ciphertext.subarray(0, NONCE_BYTES);
    const body = ciphertext.subarray(NONCE_BYTES);
    const subkey = await deriveSubkey(await getMasterKey(), context);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(nonce) },
      subkey,
      asArrayBuffer(body),
    );
    return new Uint8Array(pt);
  }

  async function encryptString(plaintext: string, context: string): Promise<Uint8Array> {
    return await encrypt(new TextEncoder().encode(plaintext), context);
  }

  async function decryptString(ciphertext: Uint8Array, context: string): Promise<string> {
    return new TextDecoder().decode(await decrypt(ciphertext, context));
  }

  async function hmacHex(value: string, context: string): Promise<string> {
    const key = await deriveHmacKey(await getMasterKey(), context);
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        asArrayBuffer(new TextEncoder().encode(value)),
      ),
    );
    let hex = "";
    for (const b of sig) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  return { encrypt, decrypt, encryptString, decryptString, hmacHex };
}

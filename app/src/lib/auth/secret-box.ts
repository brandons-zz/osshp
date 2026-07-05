// Authenticated symmetric encryption for the TOTP secret at rest
// (auth-security-assessment T1 / NO-GO #6).
//
// A single DB read must NOT yield a full 2FA bypass, so the TOTP secret is stored
// AES-256-GCM-encrypted, never as plaintext. The key comes from operator config
// (config.encryptionKey, OSSHP_ENCRYPTION_KEY): an absent key is a CLEAR config
// error (the getter throws), never a silent fall-through to plaintext.
//
// AES-256-GCM gives confidentiality AND integrity (a tampered ciphertext fails
// the auth-tag check on decrypt). The 32-byte key is derived from the operator
// secret via SHA-256 so any sufficiently strong string is accepted. Boxed form:
//   v1:<ivHex>:<authTagHex>:<ciphertextHex>
//
// Node-only (node:crypto) — imported by route handlers / the recovery lib, never
// by the Edge middleware.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

const VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce length
const ALGORITHM = "aes-256-gcm";

/** Derive a 32-byte AES key from the operator-configured encryption key. */
function deriveKey(): Buffer {
  // config.encryptionKey throws a clear error if OSSHP_ENCRYPTION_KEY is unset —
  // this is the "absent key = config error, never silent plaintext" guarantee.
  return createHash("sha256").update(config.encryptionKey, "utf8").digest();
}

/** Encrypt a plaintext secret to the boxed string form (v1:iv:tag:ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

/**
 * Decrypt a boxed string produced by encryptSecret. Throws on a malformed box, an
 * unknown version, or a failed authentication tag (tamper / wrong key) — the
 * caller treats any failure as "secret unavailable", never as plaintext.
 */
export function decryptSecret(boxed: string): string {
  const parts = boxed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted secret.");
  }
  const [, ivHex, tagHex, ctHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** True iff a stored value is in the boxed (encrypted) form — never plaintext. */
export function isBoxed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

// Base64URL helpers for WebAuthn binary material (server-side only).
//
// SimpleWebAuthn hands back the credential public key as a Uint8Array; we store
// it as a base64url string in the admin_user.passkey_credentials JSONB and decode
// it back to a Uint8Array on authentication. These use Node's Buffer, so this
// module is Node-only — it is imported by webauthn.ts (route handlers), NEVER by
// the Edge-runtime middleware. (Hex/randomness for sessions lives in bytes.ts.)

/** Encode bytes as a base64url (unpadded) string. */
export function bytesToBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decode a base64url string back to bytes. Returns an ArrayBuffer-backed
 * Uint8Array (not a Buffer view) so it satisfies the SimpleWebAuthn
 * `Uint8Array<ArrayBuffer>` credential publicKey type.
 */
export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64url");
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  return bytes;
}

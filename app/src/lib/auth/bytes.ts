// Edge-safe byte helpers for the session layer.
//
// These use ONLY the Web Crypto global (crypto.getRandomValues) and pure string
// ops — no node:crypto, no Buffer — so this module (and everything that imports
// it, including sessions.ts) is safe to pull into the Edge-runtime middleware.
// Base64URL encoding of binary WebAuthn material lives in encoding.ts (Buffer-
// based, Node-only), which is imported only by server-side route handlers.

const HEX = "0123456789abcdef";

/** Lowercase hex encoding of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0x0f];
  return out;
}

/** Decode lowercase/uppercase hex to bytes. Returns null on malformed input. */
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A cryptographically-random hex string of `byteLength` bytes. */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

const encoder = new TextEncoder();

/** UTF-8 encode a string to bytes (TextEncoder is available in all runtimes). */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

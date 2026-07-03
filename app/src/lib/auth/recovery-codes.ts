// One-time recovery codes (auth-security-assessment §6 / B5).
//
// Recovery codes are the last layered lane back into a single-identity account.
// They are:
//  - CSPRNG, high-entropy (R1): 20 Crockford-base32 chars = 100 bits each.
//  - Hashed at rest (R2): a salted SHA-256 per code — high entropy makes a single
//    salted SHA-256 sufficient (no slow KDF needed). Plaintext is NEVER stored.
//  - Single-use (R3): consuming a code removes its hash from the stored set.
//  - Display-once (R4): plaintext is returned ONCE at generation and never again;
//    regeneration replaces (invalidates) the whole prior set.
//
// Node-only (node:crypto) — the recovery lib imports this, the Edge middleware
// never does.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Number of codes minted per generation. */
const CODE_COUNT = 10;

/** Crockford base32 alphabet (no I/L/O/U — unambiguous when transcribed). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Characters per code: 20 × 5 bits = 100 bits of entropy (R1). */
const CODE_LENGTH = 20;

/** Salt bytes per code hash. */
const SALT_BYTES = 16;

/** Mint one CSPRNG code, grouped `xxxxx-xxxxx-xxxxx-xxxxx` for legibility. */
function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return raw.replace(/(.{5})(?=.)/g, "$1-");
}

/** Normalize a submitted code: strip separators/whitespace, uppercase. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** Salted SHA-256 hash of a normalized code, stored as `<saltHex>:<hashHex>`. */
function hashCode(normalized: string, salt: Buffer): string {
  const digest = createHash("sha256")
    .update(salt)
    .update(normalized, "utf8")
    .digest();
  return `${salt.toString("hex")}:${digest.toString("hex")}`;
}

export interface GeneratedRecoveryCodes {
  /** Plaintext codes — show ONCE, then discard (R4). Never persisted. */
  plaintext: string[];
  /** Salted hashes to store in admin_user.recovery_codes (R2). */
  hashed: string[];
}

/** Generate a fresh set of recovery codes (default 10). */
export function generateRecoveryCodes(count: number = CODE_COUNT): GeneratedRecoveryCodes {
  const plaintext: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = mintCode();
    plaintext.push(code);
    hashed.push(hashCode(normalizeCode(code), randomBytes(SALT_BYTES)));
  }
  return { plaintext, hashed };
}

/** Constant-time compare of two equal-length hex strings. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface RecoveryCodeConsumeResult {
  /** True iff the submitted code matched a stored hash. */
  matched: boolean;
  /** The stored hash set with the matched entry removed (single-use, R3). */
  remaining: string[];
}

/**
 * Verify a submitted code against the stored hash set and, on a match, return the
 * set with that code removed (single-use, R3). Every entry is checked (no early
 * return on first mismatch) so the comparison time does not leak which entry, and
 * the per-entry compare is constant-time.
 */
export function verifyAndConsumeRecoveryCode(
  submitted: string,
  hashedSet: readonly string[],
): RecoveryCodeConsumeResult {
  const normalized = normalizeCode(submitted);
  let matchIndex = -1;
  hashedSet.forEach((stored, i) => {
    const sep = stored.indexOf(":");
    if (sep < 0) return;
    const salt = Buffer.from(stored.slice(0, sep), "hex");
    // Compare ONLY the hash hex (after the salt), constant-time. Comparing the
    // whole `salt:hash` string as hex would truncate at the ':' and compare only
    // the salt — every recompute uses the stored salt, so that would match any
    // code. The salts are identical by construction, so the hash compare is exact.
    const expectedHash = hashCode(normalized, salt).slice(sep + 1);
    if (hexEqual(stored.slice(sep + 1), expectedHash) && matchIndex === -1) {
      matchIndex = i;
    }
  });
  if (matchIndex === -1) {
    return { matched: false, remaining: [...hashedSet] };
  }
  const remaining = hashedSet.filter((_, i) => i !== matchIndex);
  return { matched: true, remaining };
}

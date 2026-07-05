// Re-enrollment grant (auth-security-assessment R6 / S4).
//
// A recovery event (recovery-code use, CLI break-glass) must grant the operator a
// way to re-establish a passkey WITHOUT handing out standing access (R6: "a
// recovery code grants a re-enrollment opportunity, not standing access"). This
// module models that grant as a short, time-boxed window on the admin record
// (admin_user.reenroll_until) that is ALSO bound to a single-use possession token
// (admin_user.reenroll_token_hash). While the window is open AND the caller
// presents the matching token, the passkey registration ceremony is permitted
// unauthenticated (the "reenroll" registration lane); it issues a fresh session
// only AFTER a new passkey is verified — so the grant itself confers no access,
// only the chance to re-enroll.
//
// The token is what makes the window possession-bound: the plaintext is returned
// EXACTLY ONCE by the event that opens the window (the recovery-code route's JSON
// response, or the break-glass CLI stdout), stored only as a salted hash, and
// consumed the instant a re-enrollment succeeds. Without it, a time-boxed window
// alone would let any unauthenticated caller who can reach the public register
// ceremony race the operator for the open window (F1).
//
// Node-only (uses node:crypto for token gen/verify) — imported Node-side only
// (bootstrap / webauthn / recovery), never by the Edge middleware.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/db/types";

/** Default re-enrollment window length. */
const DEFAULT_REENROLL_MS = 1000 * 60 * 15; // 15 minutes

/** CSPRNG re-enroll token entropy: 32 bytes = 256 bits (URL-safe base64). */
const TOKEN_BYTES = 32;

/** Salt bytes per token hash. */
const SALT_BYTES = 16;

/** Salted SHA-256 of a token, stored as `<saltHex>:<hashHex>` (R2-style). The
 *  token is high-entropy CSPRNG, so a single salted SHA-256 is sufficient — no
 *  slow KDF is needed (same reasoning as recovery-code hashing). */
function hashToken(token: string, salt: Buffer): string {
  const digest = createHash("sha256").update(salt).update(token, "utf8").digest();
  return `${salt.toString("hex")}:${digest.toString("hex")}`;
}

/** Constant-time verify of a submitted token against a stored `<saltHex>:<hashHex>`. */
function verifyToken(token: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), "hex");
  // Compare ONLY the hash hex (after the salt): comparing the whole `salt:hash`
  // string would truncate at the ':' and compare only the salt (which is stored
  // in the clear), matching any token. Recompute with the stored salt so the
  // hash compare is exact and constant-time.
  const expected = hashToken(token, salt).slice(sep + 1);
  const actual = stored.slice(sep + 1);
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * Open a time-boxed, possession-bound re-enrollment window on the admin record.
 * Called by a recovery event after it has revoked all sessions. Generates a fresh
 * CSPRNG token, stores it HASHED, and returns the plaintext EXACTLY ONCE for the
 * caller to surface (recovery-code route response / break-glass CLI stdout).
 */
export async function grantReenrollment(
  db: Db,
  opts: { ttlMs?: number } = {},
): Promise<string> {
  const until = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_REENROLL_MS)).toISOString();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await db.query(
    `UPDATE admin_user SET reenroll_until = $1, reenroll_token_hash = $2 WHERE lock_col = 'X'`,
    [until, hashToken(token, randomBytes(SALT_BYTES))],
  );
  return token;
}

/**
 * True iff a re-enrollment window is currently open (and an admin exists). This is
 * a WINDOW-STATE check only — it does NOT gate the registration lane by itself (a
 * matching token is also required; see isReenrollmentTokenValid). Retained for
 * status/diagnostic assertions.
 */
export async function isReenrollmentOpen(db: Db): Promise<boolean> {
  const rows = await db.query<{ open: boolean }>(
    `SELECT (reenroll_until IS NOT NULL AND reenroll_until > now()) AS open
       FROM admin_user WHERE lock_col = 'X'`,
  );
  return rows[0]?.open === true;
}

/**
 * True iff a re-enrollment window is open AND `token` matches the stored,
 * single-use re-enroll token hash. This is the possession-bound gate for the
 * unauthenticated reenroll registration lane. A missing/wrong token returns false
 * REGARDLESS of whether a window is open — the caller therefore cannot use the
 * response to learn whether a window exists (no window-state oracle, F1).
 */
export async function isReenrollmentTokenValid(
  db: Db,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const rows = await db.query<{ open: boolean; hash: string | null }>(
    `SELECT (reenroll_until IS NOT NULL AND reenroll_until > now()) AS open,
            reenroll_token_hash AS hash
       FROM admin_user WHERE lock_col = 'X'`,
  );
  const row = rows[0];
  if (!row || row.open !== true || !row.hash) return false;
  return verifyToken(token, row.hash);
}

/**
 * Close the re-enrollment window (called the instant a re-enrollment succeeds).
 * Clears BOTH the window timestamp and the token hash, so the token is single-use:
 * a second attempt with the same token fails (the hash is gone).
 */
export async function clearReenrollment(db: Db): Promise<void> {
  await db.query(
    `UPDATE admin_user SET reenroll_until = NULL, reenroll_token_hash = NULL WHERE lock_col = 'X'`,
  );
}

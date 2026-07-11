// Step-up re-authentication grants.
//
// A step-up grant is a single-use, short-lived, factor-bound authorization to
// perform EXACTLY ONE credential-changing admin action. It is the issue-031 /
// F1 re-enrollment-token pattern (single-use CSPRNG token, salted-hashed at rest,
// surfaced exactly once, consumed atomically, no state oracle) applied to the
// AUTHENTICATED credential-change surface: every credential-mutating route now
// requires, in addition to a valid session and the CSRF guard, a fresh proof of
// presence proven at a step-up endpoint.
//
// The grant confers nothing by itself: it is not a session, grants no read access,
// and dies with the session (FK cascade), with its expiry, or with its single use —
// whichever comes first (D12: grants are subordinate to sessions).
//
// Node-only (node:crypto for randomBytes / timingSafeEqual), imported by route
// handlers ONLY — never by the Edge middleware, mirroring reenroll.ts. The Edge
// bundle therefore cannot pick up node:crypto through this module.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/db/types";
import { readSessionCookie, verifyTokenSignature } from "./sessions";

/**
 * Grant lifetime: 5 minutes, single-use (D3). Module constant — NO env var: an
 * operator must not be able to quietly stretch a security window; changing it is a
 * code change. It matches CHALLENGE_TTL_MS (the codebase's only comparable proven
 * "interactive step the operator completes now" budget) and, because the grant is
 * single-use, this TTL only bounds how long an UNUSED grant may sit — not any
 * standing authority window. `opts.ttlMs` overrides for tests only.
 */
export const STEPUP_GRANT_TTL_MS = 1000 * 60 * 5;

/** CSPRNG grant-token entropy: 32 bytes = 256 bits (URL-safe base64) — the S1 floor. */
const TOKEN_BYTES = 32;

/** Salt bytes per token hash. */
const SALT_BYTES = 16;

/** The factor that earned a grant. Recorded on the row and in the audit event. */
export type StepUpFactor = "passkey" | "password+totp";

/** Request header carrying the plaintext grant on a gated request (D4). Uniform
 *  across every gated route — no per-route body-schema change; a custom header
 *  also forces a CORS preflight cross-origin (incidental hardening on top of the
 *  existing guardMutation CSRF check, never a replacement for it). */
export const STEPUP_GRANT_HEADER = "x-osshp-stepup-grant";

/** The single uniform denial body (D7 / §7). Byte-identical across EVERY
 *  grant-failure class on every gated route — no field names the reason, so a
 *  caller cannot distinguish grant states or probe whether a grant ever existed. */
export const STEPUP_REQUIRED_ERROR = "step-up required";

/** The uniform 403 returned by every gated route when the grant check fails for
 *  ANY reason (absent / expired / consumed / wrong / foreign-session / malformed). */
export function stepUpRequiredResponse(): Response {
  return Response.json({ error: STEPUP_REQUIRED_ERROR }, { status: 403 });
}

/** Salted SHA-256 of a token, stored as `<saltHex>:<hashHex>` — the exact
 *  reenroll.ts F1 shape. The token is high-entropy CSPRNG, so a single salted
 *  SHA-256 is sufficient (no slow KDF needed). */
function hashToken(token: string, salt: Buffer): string {
  const digest = createHash("sha256").update(salt).update(token, "utf8").digest();
  return `${salt.toString("hex")}:${digest.toString("hex")}`;
}

/** Constant-time verify of a submitted token against a stored `<saltHex>:<hashHex>`.
 *  Compares ONLY the hash segment (recomputed with the stored salt) — comparing the
 *  whole string would truncate at ':' and match on the cleartext salt alone. */
function verifyToken(token: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), "hex");
  const expected = hashToken(token, salt).slice(sep + 1);
  const actual = stored.slice(sep + 1);
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export interface IssuedStepUpGrant {
  /** The plaintext grant token — returned EXACTLY ONCE by the step-up mint
   *  response; never persisted, never logged. */
  grant: string;
  expiresAt: Date;
}

/**
 * Mint a step-up grant for `sessionId`, factor-bound, stored salted-hashed. Upserts
 * on session_id so a new step-up REPLACES any unconsumed prior grant — at most one
 * active grant per session, never an accumulation (D5). Returns the plaintext once
 * for the caller (the step-up verify route) to surface in its JSON response.
 */
export async function issueStepUpGrant(
  db: Db,
  sessionId: string,
  factor: StepUpFactor,
  opts: { ttlMs?: number } = {},
): Promise<IssuedStepUpGrant> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? STEPUP_GRANT_TTL_MS));
  await db.query(
    `INSERT INTO stepup_grants (session_id, token_hash, factor, expires_at)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           factor     = EXCLUDED.factor,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
    [sessionId, hashToken(token, randomBytes(SALT_BYTES)), factor, expiresAt.toISOString()],
  );
  return { grant: token, expiresAt };
}

/**
 * Consume the caller's step-up grant for a gated request (D8 order: called AFTER
 * validateSession + guardMutation, BEFORE the mutation). This is the SINGLE shared
 * gate (D11) — every gated route calls exactly this; no route re-implements grant
 * logic.
 *
 * Session binding: the caller's session id is resolved from the SIGNED session
 * cookie (verifyTokenSignature — the same stateless check the middleware uses), and
 * the grant deleted is THAT session's row only. A token minted under session A and
 * presented with session B's cookie finds no row for B → denial. Grants therefore
 * cannot be transplanted between sessions.
 *
 * Consumption is atomic and single-use: `DELETE … RETURNING`. The delete fires
 * whenever a session id resolves, so ANY reach to the gate BURNS the session's grant
 * (fail-closed — a failed presentation destroys the grant; the operator simply steps
 * up again). Then the hash is verified in constant time AND expiry checked; any
 * failure returns null.
 *
 * Returns the earning factor on success (for the route's audit record), or null on
 * EVERY failure class — no grant ever minted, expired, already consumed, wrong
 * token, foreign session, or a malformed/absent header. The caller maps null to the
 * single uniform 403 (stepUpRequiredResponse) — no oracle (§7).
 */
export async function consumeStepUpGrant(
  db: Db,
  request: Request,
  opts: { now?: number } = {},
): Promise<StepUpFactor | null> {
  const sessionToken = readSessionCookie(request);
  const sessionId = sessionToken ? await verifyTokenSignature(sessionToken) : null;
  if (!sessionId) return null;

  const presented = request.headers.get(STEPUP_GRANT_HEADER);

  const rows = await db.query<{
    token_hash: string;
    factor: string;
    expires_at: unknown;
  }>(
    `DELETE FROM stepup_grants WHERE session_id = $1
     RETURNING token_hash, factor, expires_at`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null; // no grant for this session (never minted / already consumed)
  if (!presented) return null; // header absent — grant is now burned
  if (!verifyToken(presented, row.token_hash)) return null; // wrong token — burned
  const now = opts.now ?? Date.now();
  if (new Date(String(row.expires_at)).getTime() <= now) return null; // expired — burned
  return row.factor as StepUpFactor;
}

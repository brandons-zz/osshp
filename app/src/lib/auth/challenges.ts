// Single-use WebAuthn challenge store (auth-security-assessment W1).
//
// A challenge is server-generated (by SimpleWebAuthn), stored here with a short
// TTL, and CONSUMED ONCE on verify — a replayed or expired challenge can never
// authenticate. One row per ceremony type (single admin = one in-flight ceremony
// at a time); store is an upsert, consume is a delete-returning, so consumption
// is atomic and a challenge is removed the instant it is read.
//
// The "one row per type" shape is safe for REGISTRATION (resolveRegistrationMode
// gates every caller before a challenge is ever stored — bootstrap, an
// authenticated step-up, or a possession-bound reenroll token; an anonymous
// caller can never reach storeChallenge(..., "registration", ...)). It is NOT
// safe for LOGIN: POST /api/auth/login/options must be reachable by anyone (that
// is how a legitimate admin starts signing in), so a shared row keyed on the
// literal "authentication" let an unrelated caller's concurrent options request
// silently overwrite the admin's in-flight challenge (issue 075 — an
// availability DoS on the passkey login lane). See storeLoginChallenge /
// consumeLoginChallenge below for the per-attempt-scoped replacement used by
// the login lane only; registration keeps this shared-row store unchanged.

import type { Db } from "@/lib/db/types";
import { randomHex } from "./bytes";
import { config } from "@/lib/config";

export type ChallengeType = "registration" | "authentication";

/** Challenges expire fast — the ceremony is interactive and immediate. */
const CHALLENGE_TTL_MS = 1000 * 60 * 5; // 5 minutes

/** Store (upsert) the in-flight challenge for a ceremony type. */
export async function storeChallenge(
  db: Db,
  type: ChallengeType,
  challenge: string,
  ttlMs: number = CHALLENGE_TTL_MS,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db.query(
    `INSERT INTO auth_challenges (type, challenge, expires_at)
       VALUES ($1, $2, $3)
     ON CONFLICT (type) DO UPDATE
       SET challenge = EXCLUDED.challenge,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
    [type, challenge, expiresAt],
  );
}

/**
 * Atomically consume the in-flight challenge for a type: delete the row and
 * return its challenge IF it exists and has not expired. Returns null when there
 * is no challenge or it has expired. The delete is unconditional on a hit, so a
 * challenge is single-use even if it had already expired.
 */
export async function consumeChallenge(
  db: Db,
  type: ChallengeType,
): Promise<string | null> {
  const rows = await db.query<{ challenge: string; expires_at: unknown }>(
    `DELETE FROM auth_challenges WHERE type = $1
     RETURNING challenge, expires_at`,
    [type],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
  return row.challenge;
}

// ── Login-lane ceremony scoping (issue 075) ──────────────────────────────────
//
// Each POST /api/auth/login/options call gets its OWN row in
// auth_login_challenges, keyed on a fresh, high-entropy, SERVER-generated
// ceremony id (never client-chosen — an attacker cannot pick or predict it).
// The id is round-tripped between options → verify via a short-lived, HttpOnly
// cookie scoped to the login-ceremony endpoints (Path=/api/auth/login): the
// browser attaches it automatically on the same-origin POST
// /api/auth/login/verify that follows startAuthentication(), so no client-side
// code change was needed to carry it. Two concurrent callers now get two
// independent rows and cannot clobber each other's in-flight challenge.

/** Cookie carrying the caller's own login-ceremony id between options → verify. */
export const LOGIN_CHALLENGE_COOKIE_NAME = "osshp_login_ceremony";

// Sweep expired ceremony rows every N stores rather than on every call
// (mirrors the sweep-on-access pattern in sessions.ts / rate-limit.ts).
// Without this, an attacker who calls /login/options repeatedly and never
// completes a ceremony would grow this table unboundedly — the per-attempt
// scoping fix must not trade one availability issue for another.
const SWEEP_INTERVAL = 50;
let callsSinceSweep = 0;

/** Delete login-ceremony rows past their TTL (issue 075 GC). Idempotent. */
export async function sweepExpiredLoginChallenges(db: Db): Promise<void> {
  await db.query(`DELETE FROM auth_login_challenges WHERE expires_at < now()`);
}

/** A fresh, high-entropy (256-bit — matches the session id floor, S1),
 *  server-generated ceremony id. Never derived from client input. */
export function newCeremonyId(): string {
  return randomHex(32);
}

/** Store the challenge for ONE login attempt, keyed on its own ceremony id —
 *  never on a shared literal, so a concurrent caller gets an independent row. */
export async function storeLoginChallenge(
  db: Db,
  ceremonyId: string,
  challenge: string,
  ttlMs: number = CHALLENGE_TTL_MS,
): Promise<void> {
  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_INTERVAL) {
    callsSinceSweep = 0;
    await sweepExpiredLoginChallenges(db);
  }
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await db.query(
    `INSERT INTO auth_login_challenges (ceremony_id, challenge, expires_at)
       VALUES ($1, $2, $3)`,
    [ceremonyId, challenge, expiresAt],
  );
}

/**
 * Atomically consume ONE ceremony's challenge: delete its row and return the
 * challenge IF it exists and has not expired. Returns null for a missing,
 * expired, or already-consumed ceremony id — including when `ceremonyId` is
 * undefined (no login-ceremony cookie on the request at all, e.g. a caller who
 * never called /login/options, or one replaying a stale/foreign cookie).
 */
export async function consumeLoginChallenge(
  db: Db,
  ceremonyId: string | undefined,
): Promise<string | null> {
  if (!ceremonyId) return null;
  const rows = await db.query<{ challenge: string; expires_at: unknown }>(
    `DELETE FROM auth_login_challenges WHERE ceremony_id = $1
     RETURNING challenge, expires_at`,
    [ceremonyId],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
  return row.challenge;
}

/** Build the Set-Cookie header for a fresh login-ceremony id. Scoped to the
 *  login-ceremony endpoints only (Path=/api/auth/login) — never sent on
 *  unrelated requests, mirroring the session cookie's flag policy otherwise. */
export function loginChallengeCookieHeader(
  ceremonyId: string,
  ttlMs: number = CHALLENGE_TTL_MS,
): string {
  const parts = [
    `${LOGIN_CHALLENGE_COOKIE_NAME}=${ceremonyId}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/auth/login",
    `Expires=${new Date(Date.now() + ttlMs).toUTCString()}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Clear the login-ceremony cookie once a ceremony completes (success or
 *  failure both consume the single-use row; this is hygiene, not a security
 *  boundary — a stale cookie value no longer matches any surviving row). */
export function clearedLoginChallengeCookieHeader(): string {
  const parts = [
    `${LOGIN_CHALLENGE_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/auth/login",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Read the caller's own login-ceremony id from the request cookie, if any. */
export function readLoginChallengeCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === LOGIN_CHALLENGE_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

// ── Step-up ceremony scoping (A1) ────────────────────────────────────────────
//
// The step-up passkey-assertion ceremony reuses the per-attempt
// auth_login_challenges store (issue-075 anti-clobbering property carries over —
// rows are ceremony-scoped and lane-agnostic, and the assertion still verifies
// against the pinned origin/rpID regardless of which lane stored the challenge),
// but round-trips its ceremony id via its OWN cookie: a different name and a
// Path scoped to /api/auth/stepup, so a step-up ceremony id and a login ceremony
// id can never cross by cookie scoping.

/** Cookie carrying the caller's own step-up-ceremony id between options → verify. */
export const STEPUP_CHALLENGE_COOKIE_NAME = "osshp_stepup_ceremony";

/** Build the Set-Cookie header for a fresh step-up-ceremony id. Scoped to the
 *  step-up-ceremony endpoints only (Path=/api/auth/stepup). */
export function stepupChallengeCookieHeader(
  ceremonyId: string,
  ttlMs: number = CHALLENGE_TTL_MS,
): string {
  const parts = [
    `${STEPUP_CHALLENGE_COOKIE_NAME}=${ceremonyId}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/auth/stepup",
    `Expires=${new Date(Date.now() + ttlMs).toUTCString()}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Clear the step-up-ceremony cookie once a ceremony completes (hygiene — the
 *  single-use row is already consumed; a stale value matches no surviving row). */
export function clearedStepupChallengeCookieHeader(): string {
  const parts = [
    `${STEPUP_CHALLENGE_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/auth/stepup",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Read the caller's own step-up-ceremony id from the request cookie, if any. */
export function readStepupChallengeCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === STEPUP_CHALLENGE_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

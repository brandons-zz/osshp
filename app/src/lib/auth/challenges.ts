// Single-use WebAuthn challenge store (auth-security-assessment W1).
//
// A challenge is server-generated (by SimpleWebAuthn), stored here with a short
// TTL, and CONSUMED ONCE on verify — a replayed or expired challenge can never
// authenticate. One row per ceremony type (single admin = one in-flight ceremony
// at a time); store is an upsert, consume is a delete-returning, so consumption
// is atomic and a challenge is removed the instant it is read.

import type { Db } from "@/lib/db/types";

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

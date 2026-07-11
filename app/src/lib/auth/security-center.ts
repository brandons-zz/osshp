// Security Center read + revoke-others aggregation (Slice 2).
//
// This module owns the center's READ surfaces (sessions/devices view + at-a-glance
// posture) and the one new MUTATION primitive (revoke every session but the
// caller's). It is route-only (imports getAdminUser + Db) — never imported by the
// Edge middleware, so nothing here enters that bundle.
//
// Exposure minimization (§3.3): the sessions view returns an 8-hex-char idPrefix
// for display correlation plus a server-computed `current` flag — the FULL session
// id never leaves the server, and there is deliberately no per-session identifier a
// client could use as a mutation key (per-session revoke is out of scope).

import type { Db } from "@/lib/db/types";
import { getAdminUser } from "@/lib/content/admin-user";

/** Chars of the session id shown for display correlation (§3.3). */
const ID_PREFIX_LEN = 8;

/** One row of the sessions/devices view. No full id, no token material (§3.3). */
export interface SessionView {
  /** First 8 hex chars of the session id — correlation only, never a mutation key. */
  idPrefix: string;
  /** True for exactly the caller's own session. */
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Trusted-proxy-aware IP captured at issuance; NULL for pre-v0.4.0 rows. */
  createdIp: string | null;
  /** Truncated User-Agent captured at issuance; NULL for pre-v0.4.0 rows. */
  userAgent: string | null;
}

interface SessionMetaRow {
  id: string;
  created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
  created_ip: string | null;
  user_agent: string | null;
}

/**
 * List the operator's live sessions for the devices view. Only non-expired rows
 * are shown (the same `expires_at > now()` truth validateSession uses). The
 * caller's own session is marked `current` and floated to the top; the rest follow
 * newest-first. The full id is mapped to an 8-char prefix here and never leaves.
 */
export async function listSessionsView(
  db: Db,
  currentSessionId: string,
): Promise<SessionView[]> {
  const rows = await db.query<SessionMetaRow>(
    `SELECT id, created_at, last_seen_at, expires_at, created_ip, user_agent
       FROM sessions
      WHERE expires_at > now()
      ORDER BY created_at DESC`,
  );
  return rows
    .map((r) => ({
      idPrefix: r.id.slice(0, ID_PREFIX_LEN),
      current: r.id === currentSessionId,
      createdAt: String(r.created_at),
      lastSeenAt: String(r.last_seen_at),
      expiresAt: String(r.expires_at),
      createdIp: r.created_ip,
      userAgent: r.user_agent,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/** At-a-glance security posture (§3.1) — sessions plus recovery-code / TOTP /
 *  passkey status. Notifications are intentionally omitted from this slice
 *  (owner-blocked channel decision). */
export interface SecurityOverview {
  sessions: SessionView[];
  recoveryCodes: { remaining: number; generatedAt: string | null };
  totp: { enabled: boolean };
  passkeys: { count: number };
}

/** Build the full overview payload for the current session. */
export async function buildSecurityOverview(
  db: Db,
  currentSessionId: string,
): Promise<SecurityOverview> {
  const [sessions, admin] = await Promise.all([
    listSessionsView(db, currentSessionId),
    getAdminUser(db),
  ]);
  return {
    sessions,
    recoveryCodes: {
      remaining: admin?.recoveryCodes.length ?? 0,
      generatedAt: admin?.recoveryCodesGeneratedAt ?? null,
    },
    totp: { enabled: admin?.totpEnabled ?? false },
    passkeys: { count: admin?.passkeyCredentials.length ?? 0 },
  };
}

/**
 * Delete every session EXCEPT the caller's (§4.1 step 1). Returns the count of
 * sessions terminated. Any `stepup_grants` rows bound to the deleted sessions die
 * with them via A1's FK `ON DELETE CASCADE` — no orphaned grant can survive its
 * session. The caller's row is intentionally spared here; the route rotates it
 * immediately after (step 2) so that, post-click, exactly one valid session token
 * exists in the world and it was minted in that response.
 */
export async function revokeOtherSessions(
  db: Db,
  currentSessionId: string,
): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM sessions WHERE id != $1 RETURNING id`,
    [currentSessionId],
  );
  return rows.length;
}

// First-party, server-side, revocable session store (auth-security-assessment §4).
//
// Why first-party (not Auth.js): osshp is single-admin with a bespoke factor
// matrix; Auth.js's provider/account/session model fights that shape and would
// put an experimental passkey provider in the crown-jewel path (§4). We own the
// session: a ≥128-bit CSPRNG id, an HMAC-signed cookie token, server-side record,
// rotation on auth, expiry, and revocation.
//
// Crypto note: signing/verification use the Web Crypto global (crypto.subtle)
// uniformly — the SAME implementation runs in Node route handlers, in bun tests,
// and in the Edge-runtime middleware. crypto.subtle.verify is constant-time, so
// the signature compare needs no separate timing-safe step (S1). This module is
// Edge-safe (no node:crypto, no Buffer): the middleware imports verifyTokenSignature
// and SESSION_COOKIE_NAME from here.
//
// Token shape: `<id>.<hmac-sha256(id)>` — a standard signed-opaque-id session token.

import type { Db } from "@/lib/db/types";
import { config } from "@/lib/config";
import { fromHex, randomHex, toHex, utf8 } from "./bytes";

/** Cookie name carrying the signed session token. */
export const SESSION_COOKIE_NAME = "osshp_session";

/** 256-bit session id (well above the ≥128-bit floor, S1). */
const SESSION_ID_BYTES = 32;

/** Absolute session lifetime. */
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface SessionRecord {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
}

// ── HMAC token signing / verification (Web Crypto, runtime-agnostic) ─────────

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(config.sessionSecret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Produce the signed cookie token `<id>.<hmac>` for a raw session id. */
export async function signToken(id: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    utf8(id) as BufferSource,
  );
  return `${id}.${toHex(new Uint8Array(sig))}`;
}

/**
 * Verify a cookie token's signature WITHOUT a DB lookup. Returns the session id
 * if the HMAC is valid, else null. This is the stateless, Edge-safe layer-1
 * choke-point check used by the middleware; the authoritative revocable check is
 * validateSession() (DB-backed) used by route handlers.
 */
export async function verifyTokenSignature(token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sigBytes = fromHex(token.slice(dot + 1));
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(),
    sigBytes as BufferSource,
    utf8(id) as BufferSource,
  );
  return ok ? id : null;
}

// ── Session lifecycle (DB-backed, revocable) ─────────────────────────────────

// Sweep expired session rows every N validateSession() calls rather than on
// every call, amortizing GC cost (NB-4 — rows otherwise accumulate forever;
// only revokeAllSessions cleared any). Expired rows are already excluded by
// validateSession's own `expires_at > now()` clause, so deleting them is a
// pure storage-hygiene no-op on behavior — it never changes which sessions
// validate. Mirrors the sweep-on-access pattern in rate-limit.ts (issue 023).
const SWEEP_INTERVAL = 50;
let callsSinceSweep = 0;

/** Delete session rows past their absolute expiry (NB-4 GC). Idempotent. */
export async function sweepExpiredSessions(db: Db): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
}

function mapRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
  };
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Create a fresh session row and return its signed cookie token. */
export async function createSession(
  db: Db,
  opts: { ttlMs?: number } = {},
): Promise<IssuedSession> {
  const id = randomHex(SESSION_ID_BYTES);
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS));
  await db.query(
    `INSERT INTO sessions (id, expires_at) VALUES ($1, $2)`,
    [id, expiresAt.toISOString()],
  );
  return { token: await signToken(id), expiresAt };
}

/**
 * Authoritatively validate a cookie token: signature MUST verify AND a non-
 * expired, non-idle row MUST exist. Returns the session record or null. Touches
 * last_seen_at on success (sliding the idle window). Returns null for a revoked
 * (deleted) session (S4), one past its absolute expiry (S5), OR one whose
 * last_seen_at is older than the idle window (A07 — idle-timeout). The idle check
 * compares the PRIOR last_seen_at against the cutoff in the same statement, so an
 * idle session is rejected even though it has not hit absolute expiry.
 */
export async function validateSession(
  db: Db,
  token: string | undefined | null,
  opts: { idleMs?: number } = {},
): Promise<SessionRecord | null> {
  if (!token) return null;
  const id = await verifyTokenSignature(token);
  if (!id) return null;
  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_INTERVAL) {
    callsSinceSweep = 0;
    await sweepExpiredSessions(db);
  }
  const idleMs = opts.idleMs ?? config.sessionIdleMs;
  const idleCutoff = new Date(Date.now() - idleMs).toISOString();
  const rows = await db.query<SessionRow>(
    `UPDATE sessions SET last_seen_at = now()
       WHERE id = $1 AND expires_at > now() AND last_seen_at > $2
     RETURNING id, created_at, last_seen_at, expires_at`,
    [id, idleCutoff],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Revoke a single session (delete its row). Idempotent. */
export async function revokeSession(
  db: Db,
  token: string | undefined | null,
): Promise<void> {
  if (!token) return;
  const id = await verifyTokenSignature(token);
  if (!id) return;
  await db.query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

/**
 * Revoke ALL sessions. Every recovery / privilege event (passkey add/remove,
 * password change, recovery-code use, CLI break-glass) MUST call this (S4).
 */
export async function revokeAllSessions(db: Db): Promise<void> {
  await db.query(`DELETE FROM sessions`);
}

/**
 * Rotate the session on a privilege change (S3 — session fixation defense).
 * Revokes the prior session (if any) and issues a brand-new one. Always call
 * this immediately after a successful authentication; never re-bless a pre-auth
 * session id.
 */
export async function rotateSession(
  db: Db,
  oldToken: string | undefined | null,
  opts: { ttlMs?: number } = {},
): Promise<IssuedSession> {
  await revokeSession(db, oldToken);
  return createSession(db, opts);
}

// ── Cookie header helpers ────────────────────────────────────────────────────

/** Set-Cookie value for an issued session. Secure-by-default (S2). */
export function sessionCookieHeader(session: IssuedSession): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${session.token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Expires=${session.expiresAt.toUTCString()}`,
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Read the raw session token from a request's Cookie header (if present). */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Set-Cookie value that clears the session cookie (logout/revoke). */
export function clearedSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

// Visitor-hash + UTC-day helpers (issue 029).
//
// hashVisitor never sees a persisted salt (salt.ts) and never returns anything
// that carries the raw IP/UA back out — a one-way SHA-256 digest is the only
// thing that reaches the database (visitor_hash column). No raw IP or User-Agent
// is ever stored (privacy posture — see docs/modules.md § Analytics).

import { createHash } from "node:crypto";
import { currentDaySalt } from "./salt";

/** The current UTC calendar day as YYYY-MM-DD (matches the `day` DATE column). */
export function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Salted SHA-256 of (ip, ua, day). The salt rotates once per UTC day and is
 * never persisted (salt.ts), so this hash dedupes exactly WITHIN a day and is
 * cryptographically unlinkable ACROSS days — the same visitor on two different
 * days always produces two unrelated hashes.
 */
export function hashVisitor(ip: string, ua: string, day: string): string {
  const salt = currentDaySalt(day);
  // "\0" is a NUL domain separator between fields, so (ip, ua) pairs can never
  // collide by concatenation (e.g. "1.2.3.41"+"UA" vs "1.2.3.4"+"1UA") — NUL
  // cannot appear inside a header-derived string.
  return createHash("sha256")
    .update(salt)
    .update(ip, "utf8")
    .update("\0")
    .update(ua, "utf8")
    .update("\0")
    .update(day, "utf8")
    .digest("hex");
}

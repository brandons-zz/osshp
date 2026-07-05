// Daily-rotating, never-persisted salt (issue 029 privacy posture).
//
// The unique-visitor hash (hash.ts) is salted per UTC calendar day so a stored
// hash can never be reversed to an IP/User-Agent AND so hashes are unlinkable
// across day boundaries by construction (same visitor, different day → different
// hash — no cross-day re-identification is even possible, let alone performed).
//
// The salt lives ONLY in this module's in-process memory, for the CURRENT day
// only. It is never written to the database, a file, or a log — "persisted
// beyond its day" would mean surviving in any durable store past the day it was
// used, and this cache is neither durable nor multi-day: the moment a caller asks
// for a different day's salt, the old one is discarded (dereferenced) and a fresh
// CSPRNG salt is generated. A process restart mid-day also yields a fresh salt —
// an accepted trade-off (documented in the privacy doc) for a single-process
// self-host with no shared cache to keep in sync.

import { randomBytes } from "node:crypto";

let cache: { day: string; salt: Buffer } | null = null;

/** The current day's salt, generating (and replacing any prior day's) on demand. */
export function currentDaySalt(day: string): Buffer {
  if (!cache || cache.day !== day) {
    cache = { day, salt: randomBytes(32) };
  }
  return cache.salt;
}

/** Test-only seam to force a fresh salt between assertions. */
export function _resetDaySaltCacheForTests(): void {
  cache = null;
}

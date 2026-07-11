// Per-lane rate limiting for the auth surface (auth-security-assessment H4, NO-GO #7).
//
// The single-identity model means an attacker attacks the WEAKEST lane, so every
// auth lane must be throttled. This is a fixed-window limiter persisted in the
// app's own Postgres database (migration 0013, table rate_limit_windows) — every
// recorded attempt survives a process restart or deploy, and the brute-force
// resistance it represents is never silently reset. Reads/writes go through the
// same `Db` executor seam every other store in this app uses (@/lib/db/types),
// so the exact same SQL runs in production (postgres.js) and in the pre-push
// gate (PGlite, no external service). It is per-database, not per-process —
// horizontal scaling would still share this one store, which osshp's
// single-admin shape does not call for (spec principle 2).
//
// Pure and clock-injectable (check(db, key, now)) so the throttle behavior is
// unit-tested deterministically: `now` and the persisted `reset_at` are both
// plain epoch-ms numbers, so a "restart" is simply constructing a fresh
// createRateLimiter() (no in-memory state survives that) against the SAME db —
// exactly what a real process restart looks like from the limiter's perspective.
//
// Two layers (NO-GO #7 fix, 2026-06-29):
//  1. Per-key window — keyed on a TRUSTED-proxy-aware client IP (see clientKey).
//     A leftmost-XFF key is attacker-rotatable and was bypassable; the key now
//     comes from the entry a trusted proxy appended, which the client cannot move.
//  2. IP-independent global per-lane cap (`globalMax`) — a ceiling on the whole
//     lane per window, independent of any client-derivable key. Even if per-IP
//     attribution is defeated or spoofed (e.g. direct exposure with no trusted
//     proxy), the lane still hits a hard bound. Defense in depth.

import { config } from "@/lib/config";
import type { Db } from "@/lib/db/types";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window resets (0 when allowed and fresh). */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(db: Db, key: string, now?: number): Promise<RateLimitResult>;
  reset(db: Db, key?: string): Promise<void>;
  /** Number of per-key windows currently held (for tests/ops — not a public contract). */
  size(db: Db): Promise<number>;
}

interface Window {
  count: number;
  resetAt: number;
}

interface WindowRow {
  count: unknown;
  reset_at: unknown;
}

function toWindow(row: WindowRow | undefined): Window | undefined {
  if (!row) return undefined;
  return { count: Number(row.count), resetAt: Number(row.reset_at) };
}

/**
 * Atomically advance a window by one hit and return its post-increment state.
 *
 * This is a SINGLE statement — an `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * — so the read-modify-write is indivisible under concurrency: no separate
 * SELECT to race, and the increment is a server-side arithmetic expression on
 * the row's OWN locked value (`r.count`), not a client-computed blind SET.
 * `ON CONFLICT DO UPDATE` takes a row lock, so N truly-concurrent callers on
 * one key serialize on the row and observe counts 1, 2, 3, … in turn — the
 * caller decides allow/block from the returned count (count <= cap ⇒ allowed).
 * Correct on real Postgres (row lock across pooled connections) AND on the
 * PGlite test adapter (single WASM instance runs statements one at a time).
 *
 * Semantics per the two CASE arms, keyed off the row's own reset_at vs `now`:
 *   - window expired (or no row yet): start a FRESH window — count 1, reset_at
 *     now+windowMs. Always allowed (1 <= any cap >= 1).
 *   - window still live: count = count + 1, reset_at unchanged. The caller
 *     blocks when the returned count exceeds the cap. A blocked request DOES
 *     still increment (count climbs past the cap within the window); that is
 *     intentional and harmless — it self-heals when the window expires and the
 *     sweep prunes the row — and it is what makes "reached the cap (allowed)"
 *     vs "already over the cap (blocked)" distinguishable from the count alone.
 */
async function bumpWindow(
  db: Db,
  key: string,
  now: number,
  windowMs: number,
): Promise<Window> {
  const freshResetAt = now + windowMs;
  const rows = await db.query<WindowRow>(
    `INSERT INTO rate_limit_windows AS r (key, count, reset_at)
       VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE
       SET count    = CASE WHEN r.reset_at <= $3 THEN 1 ELSE r.count + 1 END,
           reset_at = CASE WHEN r.reset_at <= $3 THEN $2 ELSE r.reset_at END
     RETURNING count, reset_at`,
    [key, freshResetAt, now],
  );
  // The statement always inserts or updates exactly one row, so RETURNING
  // always yields it.
  return toWindow(rows[0])!;
}

/**
 * Delete every window row whose reset_at has already elapsed. Exported so a
 * caller (or a test) can prune on demand in addition to the periodic sweep
 * `check()` already performs — mirrors the sweep-on-access pattern used by
 * auth_login_challenges (lib/auth/challenges.ts).
 */
export async function sweepExpiredRateLimitWindows(
  db: Db,
  now: number = Date.now(),
): Promise<void> {
  await db.query(`DELETE FROM rate_limit_windows WHERE reset_at <= $1`, [now]);
}

// Sweep expired windows every N `check()` calls rather than on every call, so
// pruning cost is amortized instead of making every call issue an extra
// DELETE. This bounds the table to roughly (SWEEP_INTERVAL fresh rows since
// the last sweep) + (currently-live distinct keys across every lane) —
// independent of total historical distinct-key traffic — without changing any
// allow/block decision: `bumpWindow` treats an expired window exactly like an
// absent one (both start a fresh count=1 window), so deleting expired rows is
// a pure storage-hygiene no-op on behavior (issue 023's guarantee, now against
// the table instead of the in-memory Map).
const SWEEP_INTERVAL = 50;

/**
 * Create a fixed-window limiter allowing `max` hits per `windowMs` per key,
 * persisted under Postgres row keys namespaced by `name` (the lane identifier —
 * pass the same string used as the `lane` argument to clientKey() everywhere
 * this limiter is used, e.g. "login", "recovery-code"). Each call to check()
 * that is allowed consumes one unit.
 *
 * When `globalMax` is set, the lane also enforces an IP-independent ceiling of
 * `globalMax` hits per window across ALL keys combined — a hard bound that holds
 * even if the per-key client IP is spoofed or unattributable (NO-GO #7).
 */
export function createRateLimiter(opts: {
  name: string;
  windowMs: number;
  max: number;
  globalMax?: number;
}): RateLimiter {
  const globalKey = `__global__:${opts.name}`;
  const keyPrefix = `${opts.name}:`;
  let callsSinceSweep = 0;

  return {
    async check(
      db: Db,
      key: string,
      now: number = Date.now(),
    ): Promise<RateLimitResult> {
      callsSinceSweep += 1;
      if (callsSinceSweep >= SWEEP_INTERVAL) {
        callsSinceSweep = 0;
        await sweepExpiredRateLimitWindows(db, now);
      }
      // 1. Global lane cap (IP-independent) — advanced and checked first so a
      //    flood across rotating keys cannot slip past the per-key layer. The
      //    bump is atomic (bumpWindow), so concurrent callers cannot each read
      //    an under-cap snapshot and all admit — they serialize on the row and
      //    observe strictly increasing counts. A request the global cap blocks
      //    does not advance the per-key window (early return).
      if (opts.globalMax !== undefined) {
        const g = await bumpWindow(db, globalKey, now, opts.windowMs);
        if (g.count > opts.globalMax) {
          return { allowed: false, remaining: 0, retryAfterMs: g.resetAt - now };
        }
      }
      // 2. Per-key cap — same atomic bump-then-compare. `count > max` means this
      //    request pushed the window past its cap, so it is blocked; `count <=
      //    max` means it landed within the cap and is allowed.
      const w = await bumpWindow(db, key, now, opts.windowMs);
      if (w.count > opts.max) {
        return { allowed: false, remaining: 0, retryAfterMs: w.resetAt - now };
      }
      return {
        allowed: true,
        remaining: Math.max(0, opts.max - w.count),
        retryAfterMs: 0,
      };
    },
    async reset(db: Db, key?: string): Promise<void> {
      if (key === undefined) {
        await db.query(
          `DELETE FROM rate_limit_windows WHERE key = $1 OR key LIKE $2`,
          [globalKey, `${keyPrefix}%`],
        );
      } else {
        await db.query(`DELETE FROM rate_limit_windows WHERE key = $1`, [key]);
      }
    },
    async size(db: Db): Promise<number> {
      const rows = await db.query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM rate_limit_windows WHERE key LIKE $1`,
        [`${keyPrefix}%`],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// ── Per-lane limiters ─────────────────────────────────────────────────────────
// Every auth lane that exists in M1.6 gets its own limiter. M2 lanes (password,
// TOTP, recovery codes) add their own limiters here when those lanes land.

const MINUTE = 60_000;

// `globalMax` is the IP-independent per-lane ceiling per window — the bound that
// holds when a client rotates forwarded headers behind/without a proxy. It is set
// well above the per-key `max` so legitimate single-admin traffic never trips it,
// while still capping a header-rotating attacker (single-identity self-host: real
// concurrent load is one operator, so even these are generous).

/** Passkey login (assertion) attempts. `name` matches the "login" lane passed
 *  to clientKey() at every login/* call site — required so this limiter's
 *  global window and size()/reset() scoping resolve to the right rows. */
export const loginLimiter = createRateLimiter({
  name: "login",
  windowMs: MINUTE,
  max: 10,
  globalMax: 50,
});
/** Passkey registration / step-up enrollment attempts. `name` matches the
 *  "register" lane passed to clientKey() at the register/* call sites. */
export const registrationLimiter = createRateLimiter({
  name: "register",
  windowMs: MINUTE,
  max: 10,
  globalMax: 50,
});
/** First-run bootstrap attempts (tighter — provisions the admin). `name`
 *  matches the "bootstrap" lane passed to clientKey() at the register/*
 *  call sites when no admin is yet provisioned. */
export const bootstrapLimiter = createRateLimiter({
  name: "bootstrap",
  windowMs: MINUTE,
  max: 5,
  globalMax: 20,
});

// ── Recovery lanes (M2.2) — these ARE the account-lockout control (B4). ─────────
// The single-identity model means an attacker brute-forces the weakest lane, so
// the fallback (password+TOTP) and recovery-code lanes are throttled HARDER than
// passkey login: after N attempts per window per trusted-proxy-aware key the lane
// locks (429), and the IP-independent globalMax bounds a header-rotating attacker.
// Callers reset(key) on a successful auth, so the bound is effectively "N
// CONSECUTIVE failures lock the account" — the B4 semantics — while legitimate
// single-admin use never trips it. The key is the trusted-proxy-aware clientKey,
// NOT an attacker-rotatable client header (NO-GO #7).

/** Password+TOTP fallback-login attempts. `name` matches the
 *  "recovery-password-totp" lane passed to clientKey() at its call site. */
export const passwordTotpLimiter = createRateLimiter({
  name: "recovery-password-totp",
  windowMs: 5 * MINUTE,
  max: 5,
  globalMax: 20,
});
/** Recovery-code attempts. `name` matches the "recovery-code" lane passed to
 *  clientKey() at its call site. */
export const recoveryCodeLimiter = createRateLimiter({
  name: "recovery-code",
  windowMs: 5 * MINUTE,
  max: 5,
  globalMax: 20,
});

// ── Step-up re-authentication lanes (A1) ────────────────────────────────────────
// Two independent lanes, matching the two adjacent proven shapes:
//  - stepupLimiter is the PRIMARY passkey-assertion lane, login-class (10/min) —
//    the assertion is a possession proof, not a guessable secret, so it is not
//    lockout-throttled harder than login.
//  - stepupFallbackLimiter is the password+TOTP FALLBACK lane, lockout-class
//    (5/5min, B4 semantics: N consecutive failures lock the key, reset on success)
//    on its OWN key lane ("stepup-password-totp"), so step-up lockout state and the
//    recovery-login lockout state stay independent — a locked step-up fallback
//    never blocks the recovery-login lane and vice versa.

/** Step-up passkey-assertion attempts (login-class). `name` matches the "stepup"
 *  lane passed to clientKey() at the step-up options/verify routes, so the durable
 *  rows (migration 0013) are namespaced under that lane and stay independent of the
 *  login/recovery lanes. */
export const stepupLimiter = createRateLimiter({
  name: "stepup",
  windowMs: MINUTE,
  max: 10,
  globalMax: 50,
});
/** Step-up password+TOTP fallback attempts (lockout-class, own key lane). `name`
 *  matches the "stepup-password-totp" lane passed to clientKey() at the fallback
 *  route, so its durable lockout rows are namespaced separately from the recovery-
 *  login lockout lane — a locked step-up fallback never affects recovery login. */
export const stepupFallbackLimiter = createRateLimiter({
  name: "stepup-password-totp",
  windowMs: 5 * MINUTE,
  max: 5,
  globalMax: 20,
});

/**
 * Resolve the client IP in a trusted-proxy-aware way for rate-limit keying.
 *
 * `X-Forwarded-For` is `client, proxy1, …, proxyN`: each proxy APPENDS the peer
 * IP it observed to the RIGHT. With `config.trustedProxyHops` (N) trusted proxies
 * in front (the default Caddy-in-stack deployment is N=1), the entry the OUTERMOST
 * trusted proxy appended — the real client as that proxy saw it — is the Nth from
 * the right. Everything to its LEFT is client-supplied and ignored, so an attacker
 * rotating their forwarded header only churns the discarded left portion; the key
 * stays stable.
 *
 * With N=0 (direct exposure, no trusted proxy) the header is fully untrusted and
 * ignored entirely — every request collapses to the "unknown" key, and the global
 * per-lane cap is the operative bound. If the header has fewer than N entries the
 * chain is shorter than declared (suspicious), so no entry is trusted.
 */
function forwardedClientIp(request: Request): string | null {
  const hops = config.trustedProxyHops;
  if (hops <= 0) return null;
  const fwd = request.headers.get("x-forwarded-for");
  if (!fwd) return null;
  const entries = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = entries.length - hops;
  if (idx < 0) return null;
  return entries[idx] || null;
}

/**
 * Resolve the trusted-proxy-aware client IP for a request, or null when it is
 * unattributable (direct exposure with no trusted proxy, or a chain shorter than
 * declared). This is the single source of "who is the client" — the rate-limit
 * keying AND the audit log (audit.ts) both use it, so throttling and logging agree
 * on the source IP and neither can be fooled by a rotated leftmost XFF token.
 */
export function clientIp(request: Request): string | null {
  return forwardedClientIp(request);
}

/**
 * Resolve the session metadata to capture at issuance (Security Center §3.2) from
 * a request in hand: the trusted-proxy-aware client IP (same attribution the
 * limiter and audit log use) and the raw User-Agent (truncation is enforced in
 * createSession). Co-located with clientIp because both answer "who/what is this
 * request from"; route-only (never imported by the Edge middleware).
 */
export function sessionMetadataFromRequest(
  request: Request,
): { ip: string | null; userAgent: string | null } {
  return { ip: clientIp(request), userAgent: request.headers.get("user-agent") };
}

/**
 * Derive a throttle key from a request: `<lane>:<trusted-client-ip|unknown>`.
 * The IP comes from `clientIp` (trusted-proxy-aware), NOT the leftmost
 * client-supplied XFF token — that token is attacker-rotatable and was the
 * NO-GO #7 bypass. The lane prefix keeps lanes independent.
 */
export function clientKey(lane: string, request: Request): string {
  const ip = clientIp(request) ?? "unknown";
  return `${lane}:${ip}`;
}

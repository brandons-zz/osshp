// Per-lane rate limiting for the auth surface (auth-security-assessment H4, NO-GO #7).
//
// The single-identity model means an attacker attacks the WEAKEST lane, so every
// auth lane must be throttled. This is a fixed-window, in-memory limiter: simple,
// dependency-free, and correct for a single-instance self-host (the default
// deployment). It is per-process — horizontal scaling would need a shared store,
// which osshp's single-admin shape does not call for (spec principle 2).
//
// Pure and clock-injectable (check(key, now)) so the throttle behavior is unit-
// tested deterministically.
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

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window resets (0 when allowed and fresh). */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
  reset(key?: string): void;
  /** Number of per-key windows currently held (for tests/ops — not a public contract). */
  size(): number;
}

interface Window {
  count: number;
  resetAt: number;
}

// Sweep expired per-key windows every N `check()` calls rather than on every
// call, so pruning cost is amortized instead of making every call O(map
// size). This bounds `windows` to roughly (SWEEP_INTERVAL fresh entries since
// the last sweep) + (currently-live distinct keys) — independent of total
// historical distinct-key traffic — without changing any allow/block
// decision: `isBlocked`/`bump` already treat an expired window exactly like
// an absent one, so deleting expired entries is a pure memory-hygiene no-op
// on behavior.
const SWEEP_INTERVAL = 50;

/**
 * Create a fixed-window limiter allowing `max` hits per `windowMs` per key.
 * Each call to check() that is allowed consumes one unit.
 *
 * When `globalMax` is set, the lane also enforces an IP-independent ceiling of
 * `globalMax` hits per window across ALL keys combined — a hard bound that holds
 * even if the per-key client IP is spoofed or unattributable (NO-GO #7).
 */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  globalMax?: number;
}): RateLimiter {
  const windows = new Map<string, Window>();
  let globalWindow: Window | undefined;
  let callsSinceSweep = 0;

  /** True if the window is live (not expired) and at/over its cap. */
  function isBlocked(w: Window | undefined, now: number, cap: number): boolean {
    return w !== undefined && now < w.resetAt && w.count >= cap;
  }

  /** Consume one unit, starting a fresh window if the prior one expired. */
  function bump(w: Window | undefined, now: number, resetAt: number): Window {
    if (!w || now >= w.resetAt) return { count: 1, resetAt };
    w.count += 1;
    return w;
  }

  /** Remove all per-key windows whose window has already expired. */
  function sweepExpired(now: number): void {
    for (const [key, w] of windows) {
      if (now >= w.resetAt) windows.delete(key);
    }
  }

  return {
    check(key: string, now: number = Date.now()): RateLimitResult {
      callsSinceSweep += 1;
      if (callsSinceSweep >= SWEEP_INTERVAL) {
        sweepExpired(now);
        callsSinceSweep = 0;
      }
      // 1. Global lane cap (IP-independent) — checked first so a flood across
      //    rotating keys cannot slip past the per-key layer.
      if (
        opts.globalMax !== undefined &&
        isBlocked(globalWindow, now, opts.globalMax)
      ) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: globalWindow!.resetAt - now,
        };
      }
      // 2. Per-key cap.
      const existing = windows.get(key);
      if (isBlocked(existing, now, opts.max)) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: existing!.resetAt - now,
        };
      }
      // Allowed — consume one unit from the per-key window and (if configured)
      // the global window.
      const resetAt = now + opts.windowMs;
      const updated = bump(existing, now, resetAt);
      windows.set(key, updated);
      if (opts.globalMax !== undefined) {
        globalWindow = bump(globalWindow, now, resetAt);
      }
      return {
        allowed: true,
        remaining: Math.max(0, opts.max - updated.count),
        retryAfterMs: 0,
      };
    },
    reset(key?: string) {
      if (key === undefined) {
        windows.clear();
        globalWindow = undefined;
      } else {
        windows.delete(key);
      }
    },
    size(): number {
      return windows.size;
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

/** Passkey login (assertion) attempts. */
export const loginLimiter = createRateLimiter({
  windowMs: MINUTE,
  max: 10,
  globalMax: 50,
});
/** Passkey registration / step-up enrollment attempts. */
export const registrationLimiter = createRateLimiter({
  windowMs: MINUTE,
  max: 10,
  globalMax: 50,
});
/** First-run bootstrap attempts (tighter — provisions the admin). */
export const bootstrapLimiter = createRateLimiter({
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

/** Password+TOTP fallback-login attempts. */
export const passwordTotpLimiter = createRateLimiter({
  windowMs: 5 * MINUTE,
  max: 5,
  globalMax: 20,
});
/** Recovery-code attempts. */
export const recoveryCodeLimiter = createRateLimiter({
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
 * Derive a throttle key from a request: `<lane>:<trusted-client-ip|unknown>`.
 * The IP comes from `clientIp` (trusted-proxy-aware), NOT the leftmost
 * client-supplied XFF token — that token is attacker-rotatable and was the
 * NO-GO #7 bypass. The lane prefix keeps lanes independent.
 */
export function clientKey(lane: string, request: Request): string {
  const ip = clientIp(request) ?? "unknown";
  return `${lane}:${ip}`;
}

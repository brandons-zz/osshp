// Per-lane rate limiting (auth-security-assessment H4, NO-GO #7).

import { expect, test } from "bun:test";
import { clientKey, createRateLimiter } from "../rate-limit";

test("a lane is throttled after its max within the window", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  const now = 1_000_000;
  expect(limiter.check("k", now).allowed).toBe(true);
  expect(limiter.check("k", now).allowed).toBe(true);
  expect(limiter.check("k", now).allowed).toBe(true);
  const blocked = limiter.check("k", now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

test("the window resets after windowMs", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const now = 1_000_000;
  expect(limiter.check("k", now).allowed).toBe(true);
  expect(limiter.check("k", now).allowed).toBe(false);
  // Once the window elapses, attempts are allowed again.
  expect(limiter.check("k", now + 60_001).allowed).toBe(true);
});

test("keys are throttled independently (per-lane isolation)", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  const now = 1_000_000;
  expect(limiter.check("login:1.2.3.4", now).allowed).toBe(true);
  expect(limiter.check("login:1.2.3.4", now).allowed).toBe(false);
  // A different lane/key is unaffected.
  expect(limiter.check("register:1.2.3.4", now).allowed).toBe(true);
});

// ── NO-GO #7 fix: trusted-proxy-aware keying + IP-independent global cap ────────
// Helper: run a body with OSSHP_TRUSTED_PROXY_HOPS set, restoring it after.
function withTrustedHops(value: string | undefined, body: () => void): void {
  const prev = process.env.OSSHP_TRUSTED_PROXY_HOPS;
  if (value === undefined) delete process.env.OSSHP_TRUSTED_PROXY_HOPS;
  else process.env.OSSHP_TRUSTED_PROXY_HOPS = value;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env.OSSHP_TRUSTED_PROXY_HOPS;
    else process.env.OSSHP_TRUSTED_PROXY_HOPS = prev;
  }
}

test("clientKey keys on the trusted (proxy-appended) XFF entry, not the leftmost", () => {
  withTrustedHops(undefined, () => {
    // Default = 1 trusted hop (Caddy in-stack). The rightmost entry is the IP the
    // trusted proxy appended; the leftmost is client-supplied and discarded.
    const req = new Request("https://x/", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(clientKey("login", req)).toBe("login:10.0.0.1");
    const noIp = new Request("https://x/");
    expect(clientKey("bootstrap", noIp)).toBe("bootstrap:unknown");
  });
});

test("rotating the leftmost X-Forwarded-For does NOT bypass the throttle behind a trusted proxy (NO-GO #7 regression — fails on the pre-fix leftmost key)", () => {
  withTrustedHops("1", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    const now = 1_000_000;
    // Attacker rotates the client-supplied leftmost token each request; Caddy
    // appends the real (stable) client IP on the right.
    const attempt = (spoof: string) => {
      const req = new Request("https://x/login", {
        headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` },
      });
      return limiter.check(clientKey("login", req), now);
    };
    expect(attempt("10.0.0.1").allowed).toBe(true);
    expect(attempt("10.0.0.2").allowed).toBe(true);
    expect(attempt("10.0.0.3").allowed).toBe(true);
    // The 4th rotated attempt is still blocked: the key is the stable rightmost
    // (real) IP, not the rotating leftmost token. Pre-fix this returned `true`
    // because every rotated leftmost token minted a fresh bucket.
    expect(attempt("10.0.0.4").allowed).toBe(false);
  });
});

test("with no trusted proxy (hops=0) a rotating X-Forwarded-For collapses to one key", () => {
  withTrustedHops("0", () => {
    // Direct exposure: the whole header is untrusted and ignored. A rotating
    // attacker cannot mint fresh per-IP buckets — every request is "unknown".
    const a = new Request("https://x/", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const b = new Request("https://x/", {
      headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" },
    });
    expect(clientKey("login", a)).toBe("login:unknown");
    expect(clientKey("login", b)).toBe("login:unknown");
  });
});

test("the IP-independent global per-lane cap bounds a flood across distinct keys (NO-GO #7 defense-in-depth — fails on the pre-fix no-global-cap limiter)", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, globalMax: 3 });
  const now = 1_000_000;
  // Each request presents a brand-new key — per-IP attribution fully defeated.
  expect(limiter.check("login:a", now).allowed).toBe(true);
  expect(limiter.check("login:b", now).allowed).toBe(true);
  expect(limiter.check("login:c", now).allowed).toBe(true);
  // 4th distinct key: the per-key cap would allow it, but the global lane cap (3)
  // trips. Pre-fix (no globalMax) this returned `true` for every distinct key.
  const blocked = limiter.check("login:d", now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

// ── Issue 023: expired per-key windows must not grow the Map unbounded ──────────
// `size()` is test/ops-only surface added alongside the fix; pre-fix
// `createRateLimiter` has no `size()` method at all, so this test fails to
// even run (TypeError: limiter.size is not a function) against the old code —
// it is a genuine regression test, not just a new assertion on old behavior.

test("expired per-key windows are pruned so the Map does not grow unbounded under rotating-key traffic (issue 023)", () => {
  const limiter = createRateLimiter({ windowMs: 100, max: 1000 });
  const totalKeys = 500;
  let now = 0;
  for (let i = 0; i < totalKeys; i++) {
    limiter.check(`k${i}`, now);
    now += 1;
  }
  // Advance well past every key's expiry (max resetAt was 499 + 100 = 599)
  // and issue enough further checks to guarantee at least one periodic sweep
  // fires.
  now += 1000;
  for (let i = 0; i < 60; i++) {
    limiter.check(`sweep-trigger-${i}`, now);
  }
  // Pre-fix, all 500 distinct rotating keys plus the 60 trigger keys would
  // remain in the Map forever (560 entries). Post-fix, the periodic sweep
  // prunes the expired 500 during the trigger loop, leaving only the live
  // trigger keys.
  expect(limiter.size()).toBeLessThan(totalKeys);
  expect(limiter.size()).toBeLessThanOrEqual(60);
});

test("a still-active window survives a sweep cycle triggered by unrelated expired keys (issue 023)", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  // Stale keys created first; their window (resetAt=1000) will have expired
  // by the time we sweep below.
  for (let i = 0; i < 40; i++) limiter.check(`stale-${i}`, 0);
  // "active" is created later so its window (resetAt=1900) outlives the
  // stale keys' window. Consume 2 of its 3 allowed hits.
  expect(limiter.check("active", 900).allowed).toBe(true);
  expect(limiter.check("active", 900).allowed).toBe(true);
  // Advance past the stale keys' expiry (1000) but still inside "active"'s
  // window (1900). Fire enough additional checks to force a sweep cycle
  // (SWEEP_INTERVAL=50; 40 + 2 + 15 = 57 calls crosses it).
  for (let i = 0; i < 15; i++) limiter.check(`trigger-${i}`, 1500);
  // If the sweep had evicted "active"'s window (instead of pruning only
  // genuinely-expired ones), this 3rd check would incorrectly start a fresh
  // window and the 4th call below would also be allowed.
  const third = limiter.check("active", 1500);
  expect(third.allowed).toBe(true);
  expect(third.remaining).toBe(0);
  expect(limiter.check("active", 1500).allowed).toBe(false);
});

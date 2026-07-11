// Per-lane rate limiting (auth-security-assessment H4, NO-GO #7).
//
// The limiter persists its windows in Postgres (migration 0013,
// rate_limit_windows) via the same Db executor seam every other store in this
// app uses, so these tests run against PGlite — real PostgreSQL compiled to
// WASM, in-process, no external service — exactly like the pre-push gate.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { clientKey, createRateLimiter } from "../rate-limit";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";

let _h: TestDb;
let _db: Db;

beforeEach(async () => {
  _h = await createTestDb();
  _db = _h.db;
});

afterEach(async () => {
  await _h.close();
});

test("a lane is throttled after its max within the window", async () => {
  const limiter = createRateLimiter({ name: "t1", windowMs: 60_000, max: 3 });
  const now = 1_000_000;
  expect((await limiter.check(_db, "k", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "k", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "k", now)).allowed).toBe(true);
  const blocked = await limiter.check(_db, "k", now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

test("the window resets after windowMs", async () => {
  const limiter = createRateLimiter({ name: "t2", windowMs: 60_000, max: 1 });
  const now = 1_000_000;
  expect((await limiter.check(_db, "k", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "k", now)).allowed).toBe(false);
  // Once the window elapses, attempts are allowed again.
  expect((await limiter.check(_db, "k", now + 60_001)).allowed).toBe(true);
});

test("keys are throttled independently (per-lane isolation)", async () => {
  const limiter = createRateLimiter({ name: "t3", windowMs: 60_000, max: 1 });
  const now = 1_000_000;
  expect((await limiter.check(_db, "login:1.2.3.4", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "login:1.2.3.4", now)).allowed).toBe(false);
  // A different lane/key is unaffected.
  expect((await limiter.check(_db, "register:1.2.3.4", now)).allowed).toBe(true);
});

// ── NO-GO #7 fix: trusted-proxy-aware keying + IP-independent global cap ────────
// Helper: run a body with OSSHP_TRUSTED_PROXY_HOPS set, restoring it after.
async function withTrustedHops(
  value: string | undefined,
  body: () => Promise<void> | void,
): Promise<void> {
  const prev = process.env.OSSHP_TRUSTED_PROXY_HOPS;
  if (value === undefined) delete process.env.OSSHP_TRUSTED_PROXY_HOPS;
  else process.env.OSSHP_TRUSTED_PROXY_HOPS = value;
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.OSSHP_TRUSTED_PROXY_HOPS;
    else process.env.OSSHP_TRUSTED_PROXY_HOPS = prev;
  }
}

test("clientKey keys on the trusted (proxy-appended) XFF entry, not the leftmost", async () => {
  await withTrustedHops(undefined, () => {
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

test("rotating the leftmost X-Forwarded-For does NOT bypass the throttle behind a trusted proxy (NO-GO #7 regression — fails on the pre-fix leftmost key)", async () => {
  await withTrustedHops("1", async () => {
    const limiter = createRateLimiter({ name: "t4", windowMs: 60_000, max: 3 });
    const now = 1_000_000;
    // Attacker rotates the client-supplied leftmost token each request; Caddy
    // appends the real (stable) client IP on the right.
    const attempt = (spoof: string) => {
      const req = new Request("https://x/login", {
        headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` },
      });
      return limiter.check(_db, clientKey("login", req), now);
    };
    expect((await attempt("10.0.0.1")).allowed).toBe(true);
    expect((await attempt("10.0.0.2")).allowed).toBe(true);
    expect((await attempt("10.0.0.3")).allowed).toBe(true);
    // The 4th rotated attempt is still blocked: the key is the stable rightmost
    // (real) IP, not the rotating leftmost token. Pre-fix this returned `true`
    // because every rotated leftmost token minted a fresh bucket.
    expect((await attempt("10.0.0.4")).allowed).toBe(false);
  });
});

test("with no trusted proxy (hops=0) a rotating X-Forwarded-For collapses to one key", async () => {
  await withTrustedHops("0", () => {
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

test("the IP-independent global per-lane cap bounds a flood across distinct keys (NO-GO #7 defense-in-depth — fails on the pre-fix no-global-cap limiter)", async () => {
  const limiter = createRateLimiter({
    name: "t5",
    windowMs: 60_000,
    max: 2,
    globalMax: 3,
  });
  const now = 1_000_000;
  // Each request presents a brand-new key — per-IP attribution fully defeated.
  expect((await limiter.check(_db, "login:a", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "login:b", now)).allowed).toBe(true);
  expect((await limiter.check(_db, "login:c", now)).allowed).toBe(true);
  // 4th distinct key: the per-key cap would allow it, but the global lane cap (3)
  // trips. Pre-fix (no globalMax) this returned `true` for every distinct key.
  const blocked = await limiter.check(_db, "login:d", now);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
});

// ── Issue 023: expired per-key windows must not grow the store unbounded ────────
// `size()` is test/ops-only surface added alongside the fix; pre-fix
// `createRateLimiter` has no `size()` method at all, so this test fails to
// even run (TypeError: limiter.size is not a function) against the old code —
// it is a genuine regression test, not just a new assertion on old behavior.

test("expired per-key windows are pruned so the store does not grow unbounded under rotating-key traffic (issue 023)", async () => {
  const limiter = createRateLimiter({ name: "t6", windowMs: 100, max: 1000 });
  const totalKeys = 500;
  let now = 0;
  // Keys are namespaced under this limiter's own lane ("t6:") — size() scopes
  // its count to `${name}:%` (see rate-limit.ts), matching how clientKey()
  // shapes real per-key windows as `<lane>:<ip>` in production.
  for (let i = 0; i < totalKeys; i++) {
    await limiter.check(_db, `t6:k${i}`, now);
    now += 1;
  }
  // Advance well past every key's expiry (max resetAt was 499 + 100 = 599)
  // and issue enough further checks to guarantee at least one periodic sweep
  // fires.
  now += 1000;
  for (let i = 0; i < 60; i++) {
    await limiter.check(_db, `t6:sweep-trigger-${i}`, now);
  }
  // Pre-fix, all 500 distinct rotating keys plus the 60 trigger keys would
  // remain in the store forever (560 rows). Post-fix, the periodic sweep
  // prunes the expired 500 during the trigger loop, leaving only the live
  // trigger keys.
  expect(await limiter.size(_db)).toBeLessThan(totalKeys);
  expect(await limiter.size(_db)).toBeLessThanOrEqual(60);
});

// ── Issue 070: tunnel-mode hop miscount collapses every visitor to one key ──
// Tunnel topology is Cloudflare edge → cloudflared → Caddy (proxy) → app: TWO
// hops touch X-Forwarded-For. Cloudflare's edge sets the first entry to the
// real client IP; cloudflared passes it through unmodified; Caddy's
// reverse_proxy then appends the peer IT observed — cloudflared's internal
// container IP, not the client. A tunnel-mode request therefore arrives as
// `X-Forwarded-For: <real client>, <cloudflared IP>` — 2 entries, with the
// fixed cloudflared IP always rightmost.

test("reproduction: with hops=1 (today's default) a simulated 2-hop tunnel chain collapses two different real clients to the same key", async () => {
  await withTrustedHops("1", () => {
    const cloudflaredIp = "172.20.0.5"; // fixed, same for every visitor
    const reqA = new Request("https://x/login", {
      headers: { "x-forwarded-for": `1.1.1.1, ${cloudflaredIp}` },
    });
    const reqB = new Request("https://x/login", {
      headers: { "x-forwarded-for": `2.2.2.2, ${cloudflaredIp}` },
    });
    // Bug: hops=1 picks the LAST entry — cloudflared's fixed IP — for both,
    // even though the real clients (leftmost) are different.
    expect(clientKey("login", reqA)).toBe(clientKey("login", reqB));
    expect(clientKey("login", reqA)).toBe(`login:${cloudflaredIp}`);
  });
});

test("fix: with hops=2 (tunnel mode) two different real clients behind the same cloudflared IP resolve to distinct keys", async () => {
  await withTrustedHops("2", () => {
    const cloudflaredIp = "172.20.0.5";
    const reqA = new Request("https://x/login", {
      headers: { "x-forwarded-for": `1.1.1.1, ${cloudflaredIp}` },
    });
    const reqB = new Request("https://x/login", {
      headers: { "x-forwarded-for": `2.2.2.2, ${cloudflaredIp}` },
    });
    expect(clientKey("login", reqA)).toBe("login:1.1.1.1");
    expect(clientKey("login", reqB)).toBe("login:2.2.2.2");
    expect(clientKey("login", reqA)).not.toBe(clientKey("login", reqB));
  });
});

test("with hops=2, an attacker prepending extra spoofed entries still cannot control the selected entry", async () => {
  await withTrustedHops("2", () => {
    const cloudflaredIp = "172.20.0.5";
    // Attacker-supplied request already carried its own X-Forwarded-For.
    // Cloudflare's edge appends the real client IP after it (does not
    // overwrite), then Caddy appends cloudflared's IP after that — 3 entries.
    // The 2nd-from-right (Cloudflare's own entry) must still be selected,
    // regardless of how many attacker-controlled entries sit further left.
    const req = new Request("https://x/login", {
      headers: {
        "x-forwarded-for": `6.6.6.6, 9.9.9.9, 5.5.5.5, real-client-ip, ${cloudflaredIp}`,
      },
    });
    expect(clientKey("login", req)).toBe("login:real-client-ip");
  });
});

test("loginLimiter isolates two distinct simulated tunnel-mode clients from each other (issue 070 fix, hops=2)", async () => {
  await withTrustedHops("2", async () => {
    const cloudflaredIp = "172.20.0.5";
    const limiter = createRateLimiter({ name: "t7", windowMs: 60_000, max: 2 });
    const now = 1_000_000;
    const attempt = (realClientIp: string) => {
      const req = new Request("https://x/login", {
        headers: { "x-forwarded-for": `${realClientIp}, ${cloudflaredIp}` },
      });
      return limiter.check(_db, clientKey("login", req), now);
    };
    // Client A exhausts its own per-key window (max=2).
    expect((await attempt("1.1.1.1")).allowed).toBe(true);
    expect((await attempt("1.1.1.1")).allowed).toBe(true);
    expect((await attempt("1.1.1.1")).allowed).toBe(false);
    // Client B — a different real visitor behind the SAME cloudflared IP —
    // is unaffected by A's lockout. Pre-fix (hops=1) both would share one
    // key and B would already be locked out here.
    expect((await attempt("2.2.2.2")).allowed).toBe(true);
    expect((await attempt("2.2.2.2")).allowed).toBe(true);
    expect((await attempt("2.2.2.2")).allowed).toBe(false);
  });
});

test("a still-active window survives a sweep cycle triggered by unrelated expired keys (issue 023)", async () => {
  const limiter = createRateLimiter({ name: "t8", windowMs: 1000, max: 3 });
  // Stale keys created first; their window (resetAt=1000) will have expired
  // by the time we sweep below.
  for (let i = 0; i < 40; i++) await limiter.check(_db, `stale-${i}`, 0);
  // "active" is created later so its window (resetAt=1900) outlives the
  // stale keys' window. Consume 2 of its 3 allowed hits.
  expect((await limiter.check(_db, "active", 900)).allowed).toBe(true);
  expect((await limiter.check(_db, "active", 900)).allowed).toBe(true);
  // Advance past the stale keys' expiry (1000) but still inside "active"'s
  // window (1900). Fire enough additional checks to force a sweep cycle
  // (SWEEP_INTERVAL=50; 40 + 2 + 15 = 57 calls crosses it).
  for (let i = 0; i < 15; i++) await limiter.check(_db, `trigger-${i}`, 1500);
  // If the sweep had evicted "active"'s window (instead of pruning only
  // genuinely-expired ones), this 3rd check would incorrectly start a fresh
  // window and the 4th call below would also be allowed.
  const third = await limiter.check(_db, "active", 1500);
  expect(third.allowed).toBe(true);
  expect(third.remaining).toBe(0);
  expect((await limiter.check(_db, "active", 1500)).allowed).toBe(false);
});

// ── Restart durability — the fix this file's brief is about ────────────────────
// A process restart (deploy, crash, container recreate) throws away every
// in-memory JS object, including a rate limiter's closures. A brand-new
// `createRateLimiter()` call — a fresh closure with no in-memory state carried
// over — attached to the SAME durable store is exactly what the app looks
// like immediately after a restart, since the module is simply re-imported
// into a new process and the limiter singletons (loginLimiter, etc.) are
// recreated from scratch. This test fails against the pre-fix in-memory
// limiter: a fresh instance there starts with an empty Map, so it has no
// memory of the attempts recorded by the "old" instance and allows a request
// that should still be locked out.

test("a recorded attempt survives a simulated process restart (fresh limiter instance, same durable store) and still expires on schedule", async () => {
  const opts = { name: "restart", windowMs: 60_000, max: 2 } as const;
  const now = 1_000_000;

  // "Process A" — records attempts up to the cap.
  const beforeRestart = createRateLimiter(opts);
  expect((await beforeRestart.check(_db, "k", now)).allowed).toBe(true);
  expect((await beforeRestart.check(_db, "k", now)).allowed).toBe(true);

  // "Process B" — a brand-new limiter instance (no in-memory state carried
  // over) attached to the SAME database, simulating a restart/redeploy.
  const afterRestart = createRateLimiter(opts);
  const stillBlocked = await afterRestart.check(_db, "k", now);
  expect(stillBlocked.allowed).toBe(false);
  expect(stillBlocked.retryAfterMs).toBeGreaterThan(0);

  // The recorded attempt still expires on schedule: once the original window
  // has elapsed, yet another fresh instance (another simulated restart) sees
  // the count reset rather than staying blocked forever.
  const afterWindowElapsed = createRateLimiter(opts);
  const allowedAgain = await afterWindowElapsed.check(_db, "k", now + 60_001);
  expect(allowedAgain.allowed).toBe(true);
});

test("sweepExpiredRateLimitWindows prunes rows past their reset_at without touching still-live ones", async () => {
  const limiter = createRateLimiter({ name: "t9", windowMs: 100, max: 5 });
  await limiter.check(_db, "t9:expired", 0); // resetAt = 100
  await limiter.check(_db, "t9:live", 1000); // resetAt = 1100
  expect(await limiter.size(_db)).toBe(2);

  const { sweepExpiredRateLimitWindows } = await import("../rate-limit");
  await sweepExpiredRateLimitWindows(_db, 1050); // past "expired", before "live"

  expect(await limiter.size(_db)).toBe(1);
  // "live" is still tracked at its original count — the sweep did not reset it.
  const stillLive = await limiter.check(_db, "t9:live", 1050);
  expect(stillLive.remaining).toBe(3); // 5 - 2 (the check above consumed one)
});

// ── F1 concurrency regression (security gate NO-GO, 2026-07-10) ─────────────────
// The Postgres-backed check() must be ATOMIC: N truly-concurrent requests for
// one key must NEVER admit more than the cap. The pre-fix implementation did a
// separate SELECT then a blind-overwrite UPSERT across two round trips, so
// concurrent callers all read the same stale pre-increment count and each
// admitted — a concurrent-load repro showed 20/20 admitted against `max: 5`. These two tests
// drive that exact concurrent path with `Promise.all` and assert the cap holds
// with zero slack; they FAIL against the non-atomic code (admits all N) and
// PASS against the single-statement atomic bumpWindow().

test("F1: N concurrent check() calls on one key admit EXACTLY the per-key cap, never more (atomic bump)", async () => {
  const limiter = createRateLimiter({ name: "race", windowMs: 60_000, max: 5 });
  const now = 1_000_000;
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () => limiter.check(_db, "race:attacker", now)),
  );
  const admitted = results.filter((r) => r.allowed).length;
  // Exactly the cap — not N, and not "cap ± slack": the atomic increment gives
  // each concurrent caller a distinct, strictly-increasing count.
  expect(admitted).toBe(5);
  // The remaining N-cap are all rejected with a positive retry hint.
  expect(results.filter((r) => !r.allowed).length).toBe(N - 5);
  for (const r of results.filter((x) => !x.allowed)) {
    expect(r.retryAfterMs).toBeGreaterThan(0);
  }
});

test("F1: the IP-independent global per-lane cap also holds under concurrent requests spread across distinct keys", async () => {
  const limiter = createRateLimiter({
    name: "grace",
    windowMs: 60_000,
    max: 100, // per-key cap set high so the GLOBAL cap is the binding limit
    globalMax: 5,
  });
  const now = 1_000_000;
  const N = 20;
  // Every request presents a brand-new distinct key — per-IP attribution fully
  // defeated, so only the global lane cap can bound the flood.
  const results = await Promise.all(
    Array.from({ length: N }, (_v, i) =>
      limiter.check(_db, `grace:k${i}`, now),
    ),
  );
  const admitted = results.filter((r) => r.allowed).length;
  expect(admitted).toBe(5); // exactly globalMax, never more
  expect(results.filter((r) => !r.allowed).length).toBe(N - 5);
});

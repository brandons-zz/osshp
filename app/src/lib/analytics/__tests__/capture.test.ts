// recordPageview capture-path unit tests (issue 029 acceptance evidence): DNT/GPC and
// bot exclusion, correct referrer-host handling, and fail-open behavior. Uses a
// real (PGlite) Postgres via createTestDb — the same pattern as every other
// content-store test in this repo.

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.DATABASE_URL = "postgres://localhost/osshp_test_placeholder";
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  MAX_PATH_CHARS,
  MAX_REFERRER_HOST_CHARS,
  recordPageview,
  shouldCaptureForEnabledModules,
  shouldCapturePageview,
} from "../capture";
import { _resetDaySaltCacheForTests } from "../salt";
import { ANALYTICS_MODULE_ID } from "@/modules/analytics/manifest";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
  _resetDaySaltCacheForTests();
});
afterEach(() => h.close());

interface EventRow {
  day: string;
  path: string;
  referrer_host: string | null;
  visitor_hash: string;
}

async function allEvents(): Promise<EventRow[]> {
  return db.query<EventRow>(
    `SELECT day::text as day, path, referrer_host, visitor_hash FROM analytics_events ORDER BY path`,
  );
}

function req(
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://osshp.example.com${path}`, {
    headers: { "user-agent": "Mozilla/5.0 Real Browser", ...headers },
  });
}

test("DNT: 1 → the request is not recorded at all", async () => {
  await recordPageview(db, req("/blog", { dnt: "1" }), "/blog");
  expect(await allEvents()).toEqual([]);
});

test("Sec-GPC: 1 → the request is not recorded at all", async () => {
  await recordPageview(db, req("/blog", { "sec-gpc": "1" }), "/blog");
  expect(await allEvents()).toEqual([]);
});

test("a recognized bot User-Agent is not recorded", async () => {
  await recordPageview(
    db,
    req("/blog", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }),
    "/blog",
  );
  expect(await allEvents()).toEqual([]);
});

test("an ordinary request is recorded with day/path/visitor_hash and no referrer", async () => {
  await recordPageview(db, req("/blog/hello"), "/blog/hello");
  const events = await allEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.path).toBe("/blog/hello");
  expect(events[0]!.referrer_host).toBeNull();
  expect(events[0]!.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(events[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("a same-origin referrer is NOT recorded as a referrer host (internal navigation)", async () => {
  await recordPageview(
    db,
    req("/blog/hello", { referer: "https://osshp.example.com/blog" }),
    "/blog/hello",
  );
  const events = await allEvents();
  expect(events[0]!.referrer_host).toBeNull();
});

test("an external referrer's host is recorded (no path/query kept)", async () => {
  await recordPageview(
    db,
    req("/blog/hello", {
      referer: "https://www.google.com/search?q=osshp+blog&extra=1",
    }),
    "/blog/hello",
  );
  const events = await allEvents();
  expect(events[0]!.referrer_host).toBe("www.google.com");
});

test("a malformed Referer header is ignored, not fatal", async () => {
  await recordPageview(db, req("/blog/hello", { referer: "not a url" }), "/blog/hello");
  const events = await allEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.referrer_host).toBeNull();
});

// QA-gate finding (2026-07-05): these referrer values PARSE via new URL() but
// carry an empty `.host` — a different class from "not a url" above, which
// fails parsing outright. Pre-fix, the empty string was stored, passed the
// top-referrers IS NOT NULL filter, and rendered a permanent blank dashboard row.
test("scheme-only referrers (parse OK, empty host) store NULL, never an empty-string host", async () => {
  const schemeOnlyReferrers = [
    "javascript:alert(1)",
    "data:text/plain,hi",
    "mailto:x@example.com",
    "about:blank",
    "file:///etc/passwd",
  ];
  for (const [i, referer] of schemeOnlyReferrers.entries()) {
    await recordPageview(db, req(`/blog/p${i}`, { referer }), `/blog/p${i}`);
  }
  const events = await allEvents();
  // The pageviews themselves still record (only the referrer is meaningless)…
  expect(events).toHaveLength(schemeOnlyReferrers.length);
  // …but every referrer_host is NULL — never '' (the blank-row defect).
  for (const e of events) {
    expect(e.referrer_host).toBeNull();
  }
});

test("fails open: a DB error never throws out of recordPageview", async () => {
  const brokenDb: Db = {
    query: async () => {
      throw new Error("simulated DB outage");
    },
  };
  await expect(recordPageview(brokenDb, req("/blog"), "/blog")).resolves.toBeUndefined();
});

// ── Module-disabled gate (issue 029) ───────────────────────────────────
// render.ts calls recordPageview ONLY when shouldCaptureForEnabledModules(enabled)
// is true — this is that exact decision, unit-tested directly against the real
// enabled-module id list shape (getEnabledModuleIds/getActiveCapabilities already
// prove elsewhere that a disabled module's adminNav/routes vanish; this proves
// the capture side of "disabled = no capture AND no dashboard").

test("shouldCaptureForEnabledModules is true only when analytics is in the enabled set", () => {
  expect(shouldCaptureForEnabledModules([ANALYTICS_MODULE_ID])).toBe(true);
  expect(shouldCaptureForEnabledModules([BLOG_MODULE_ID, ANALYTICS_MODULE_ID])).toBe(true);
  expect(shouldCaptureForEnabledModules([BLOG_MODULE_ID])).toBe(false);
  expect(shouldCaptureForEnabledModules([])).toBe(false);
});

// ── 404s are not pageviews + string bounds (issue 067 — security gate) ───────

test("a 404 render records nothing: shouldCapturePageview is false for any non-200 status", () => {
  // This is the exact decision render.ts applies before calling recordPageview
  // (render.ts itself pulls request-scoped Next imports and cannot be imported
  // by bun tests — the same constraint slice.test.ts documents), so the rule
  // "GET /blog/<random-junk> renders the 404 page and records NOTHING" is
  // proven here: status 404 → false regardless of the enabled set.
  expect(shouldCapturePageview(404, [ANALYTICS_MODULE_ID])).toBe(false);
  expect(shouldCapturePageview(500, [ANALYTICS_MODULE_ID])).toBe(false);
  // And a 200 only captures when the module is enabled (unchanged behavior).
  expect(shouldCapturePageview(200, [ANALYTICS_MODULE_ID])).toBe(true);
  expect(shouldCapturePageview(200, [])).toBe(false);
});

test("an over-long path records nothing (dropped, not truncated)", async () => {
  const longPath = "/blog/" + "a".repeat(MAX_PATH_CHARS); // > 512 chars total
  await recordPageview(db, req(longPath), longPath);
  expect(await allEvents()).toEqual([]);
});

test("a path exactly at the bound is still recorded", async () => {
  const boundaryPath = "/" + "a".repeat(MAX_PATH_CHARS - 1); // exactly 512
  await recordPageview(db, req(boundaryPath), boundaryPath);
  const events = await allEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.path).toBe(boundaryPath);
});

test("an over-long referrer host records nothing — the whole event is dropped", async () => {
  const junkHost = "x".repeat(MAX_REFERRER_HOST_CHARS + 10) + ".example"; // > 253
  await recordPageview(
    db,
    req("/blog/hello", { referer: `https://${junkHost}/spam` }),
    "/blog/hello",
  );
  expect(await allEvents()).toEqual([]);
});

test("normal 200 capture is unchanged by the 067 bounds (in-bounds path + referrer record fine)", async () => {
  await recordPageview(
    db,
    req("/blog/hello", { referer: "https://news.ycombinator.com/item?id=1" }),
    "/blog/hello",
  );
  const events = await allEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.path).toBe("/blog/hello");
  expect(events[0]!.referrer_host).toBe("news.ycombinator.com");
});

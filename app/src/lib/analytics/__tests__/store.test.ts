// Analytics store unit tests (issue 029): aggregation correctness (pageviews by
// day incl. zero-fill, top content, top referrers, unique-visitor estimate) and
// 90-day pruning. Real (PGlite) Postgres via createTestDb.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  getAnalyticsSummary,
  insertPageview,
  pruneEventsOlderThan,
} from "../store";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

const NOW = new Date("2026-07-04T12:00:00.000Z");

function dayOffset(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

test("totalPageviews and byDay reflect exactly what was inserted, zero-filled for gap days", async () => {
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: null, visitorHash: "h1" });
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: null, visitorHash: "h2" });
  // dayOffset(1) has no events — must appear as count: 0, not be skipped.
  await insertPageview(db, { day: dayOffset(2), path: "/photos", referrerHost: null, visitorHash: "h3" });

  const summary = await getAnalyticsSummary(db, 7, NOW);
  expect(summary.totalPageviews).toBe(3);

  const byDayMap = Object.fromEntries(summary.byDay.map((p) => [p.day, p.count]));
  expect(byDayMap[dayOffset(0)]).toBe(2);
  expect(byDayMap[dayOffset(1)]).toBe(0); // zero-filled gap day
  expect(byDayMap[dayOffset(2)]).toBe(1);
  // Oldest first.
  expect(summary.byDay[0]!.day).toBe(dayOffset(6));
  expect(summary.byDay[summary.byDay.length - 1]!.day).toBe(dayOffset(0));
});

test("uniqueVisitorsEstimate counts distinct visitor hashes in the window (an estimate, not exact people)", async () => {
  // Same real visitor, two pageviews on the SAME day → same hash (dedupes to 1).
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: null, visitorHash: "visitorA-day0" });
  await insertPageview(db, { day: dayOffset(0), path: "/blog/2", referrerHost: null, visitorHash: "visitorA-day0" });
  // The SAME real visitor back the next day gets a DIFFERENT hash (hash.ts's
  // daily salt rotation — simulated here with a distinct literal) — this is
  // the documented "estimate" property: it counts as a second unique visitor,
  // not a dedup of visitor A.
  await insertPageview(db, { day: dayOffset(1), path: "/blog", referrerHost: null, visitorHash: "visitorA-day1" });
  // A genuinely different visitor.
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: null, visitorHash: "visitorB-day0" });

  const summary = await getAnalyticsSummary(db, 7, NOW);
  expect(summary.totalPageviews).toBe(4);
  expect(summary.uniqueVisitorsEstimate).toBe(3);
});

test("topPaths ranks by count desc, tie-broken alphabetically, limited to 10", async () => {
  for (let i = 0; i < 3; i++) {
    await insertPageview(db, { day: dayOffset(0), path: "/popular", referrerHost: null, visitorHash: `p${i}` });
  }
  await insertPageview(db, { day: dayOffset(0), path: "/rare", referrerHost: null, visitorHash: "r1" });

  const summary = await getAnalyticsSummary(db, 7, NOW);
  expect(summary.topPaths[0]).toEqual({ path: "/popular", count: 3 });
  expect(summary.topPaths[1]).toEqual({ path: "/rare", count: 1 });
});

test("topReferrers only includes rows with a non-null referrer_host", async () => {
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: "www.google.com", visitorHash: "g1" });
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: "www.google.com", visitorHash: "g2" });
  await insertPageview(db, { day: dayOffset(0), path: "/blog", referrerHost: null, visitorHash: "n1" });

  const summary = await getAnalyticsSummary(db, 7, NOW);
  expect(summary.topReferrers).toEqual([{ referrerHost: "www.google.com", count: 2 }]);
});

test("events outside the window are excluded from the summary", async () => {
  await insertPageview(db, { day: dayOffset(0), path: "/in-window", referrerHost: null, visitorHash: "a" });
  await insertPageview(db, { day: dayOffset(10), path: "/out-of-window", referrerHost: null, visitorHash: "b" });

  const summary = await getAnalyticsSummary(db, 7, NOW);
  expect(summary.totalPageviews).toBe(1);
  expect(summary.topPaths.map((p) => p.path)).toEqual(["/in-window"]);
});

// ── Pruning ───────────────────────────────────────────────────────────────────

test("pruneEventsOlderThan(90) removes only events older than the retention window", async () => {
  await insertPageview(db, { day: dayOffset(0), path: "/recent", referrerHost: null, visitorHash: "a" });
  await insertPageview(db, { day: dayOffset(89), path: "/edge-in", referrerHost: null, visitorHash: "b" });
  await insertPageview(db, { day: dayOffset(91), path: "/old", referrerHost: null, visitorHash: "c" });

  const removed = await pruneEventsOlderThan(db, 90, NOW);
  expect(removed).toBe(1);

  const remainingPaths = (
    await db.query<{ path: string }>(`SELECT path FROM analytics_events ORDER BY path`)
  ).map((r) => r.path);
  expect(remainingPaths.sort()).toEqual(["/edge-in", "/recent"]);
});

test("pruneEventsOlderThan is a no-op when nothing is old enough", async () => {
  await insertPageview(db, { day: dayOffset(0), path: "/recent", referrerHost: null, visitorHash: "a" });
  expect(await pruneEventsOlderThan(db, 90, NOW)).toBe(0);
});

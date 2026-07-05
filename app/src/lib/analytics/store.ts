// Analytics event store (issue 029) — the only module that touches the
// `analytics_events` table. Every row inserted here is already PII-free (no raw
// IP, no User-Agent, no query string) by the time it reaches this module; see
// capture.ts for what is filtered/hashed before insert.

import type { Db } from "@/lib/db/types";
import type {
  AnalyticsSummary,
  AnalyticsWindowDays,
  PageviewDayPoint,
  TopPathRow,
  TopReferrerRow,
} from "./types";
import { utcDayString } from "./hash";

export interface PageviewInput {
  day: string; // YYYY-MM-DD (UTC)
  path: string;
  referrerHost: string | null;
  visitorHash: string;
}

/** Insert one pageview event. The caller (capture.ts) has already applied every
 *  exclusion (admin/API, bot, DNT/GPC, module-disabled) — this is a pure write. */
export async function insertPageview(db: Db, input: PageviewInput): Promise<void> {
  await db.query(
    `INSERT INTO analytics_events (day, path, referrer_host, visitor_hash)
     VALUES ($1, $2, $3, $4)`,
    [input.day, input.path, input.referrerHost, input.visitorHash],
  );
}

/** Delete every event whose day is older than `retentionDays` before `now`.
 *  Returns the number of rows removed (used only for test assertions/logging —
 *  callers never branch on it). `now` is injectable so tests are deterministic. */
export async function pruneEventsOlderThan(
  db: Db,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDay = utcDayString(cutoff);
  const rows = await db.query<{ id: string }>(
    `DELETE FROM analytics_events WHERE day < $1 RETURNING id`,
    [cutoffDay],
  );
  return rows.length;
}

function windowStartDay(windowDays: AnalyticsWindowDays, now: Date): string {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1)); // inclusive of "now"
  return utcDayString(start);
}

/** Every UTC day from `sinceDay` through `now` (inclusive), oldest first —
 *  the zero-fill scaffold so a day with no traffic still appears as count: 0. */
function dayRange(sinceDay: string, now: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(`${sinceDay}T00:00:00.000Z`);
  const end = new Date(utcDayString(now) + "T00:00:00.000Z");
  while (cursor.getTime() <= end.getTime()) {
    days.push(utcDayString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The full dashboard summary for one window (7/30/90 days), ending "now". */
export async function getAnalyticsSummary(
  db: Db,
  windowDays: AnalyticsWindowDays,
  now: Date = new Date(),
): Promise<AnalyticsSummary> {
  const sinceDay = windowStartDay(windowDays, now);

  const [byDayRows, totalRows, uniqueRows, topPathRows, topReferrerRows] =
    await Promise.all([
      db.query<{ day: string; count: string | number }>(
        `SELECT day::text AS day, COUNT(*)::int AS count
           FROM analytics_events
          WHERE day >= $1
          GROUP BY day
          ORDER BY day ASC`,
        [sinceDay],
      ),
      db.query<{ total: string | number }>(
        `SELECT COUNT(*)::int AS total FROM analytics_events WHERE day >= $1`,
        [sinceDay],
      ),
      // COUNT(DISTINCT visitor_hash) over the window is the documented estimate:
      // the daily-rotating salt means the SAME visitor on two different days
      // already produces two distinct hashes, so a plain distinct-count over the
      // whole window is mathematically identical to summing each day's exact
      // same-day-dedup count — no extra per-day loop needed.
      db.query<{ uniq: string | number }>(
        `SELECT COUNT(DISTINCT visitor_hash)::int AS uniq
           FROM analytics_events WHERE day >= $1`,
        [sinceDay],
      ),
      db.query<{ path: string; count: string | number }>(
        `SELECT path, COUNT(*)::int AS count
           FROM analytics_events
          WHERE day >= $1
          GROUP BY path
          ORDER BY count DESC, path ASC
          LIMIT 10`,
        [sinceDay],
      ),
      db.query<{ referrer_host: string; count: string | number }>(
        `SELECT referrer_host, COUNT(*)::int AS count
           FROM analytics_events
          WHERE day >= $1 AND referrer_host IS NOT NULL
          GROUP BY referrer_host
          ORDER BY count DESC, referrer_host ASC
          LIMIT 10`,
        [sinceDay],
      ),
    ]);

  const countByDay = new Map<string, number>(
    byDayRows.map((r) => [r.day, Number(r.count)]),
  );
  const byDay: PageviewDayPoint[] = dayRange(sinceDay, now).map((day) => ({
    day,
    count: countByDay.get(day) ?? 0,
  }));

  const topPaths: TopPathRow[] = topPathRows.map((r) => ({
    path: r.path,
    count: Number(r.count),
  }));
  const topReferrers: TopReferrerRow[] = topReferrerRows.map((r) => ({
    referrerHost: r.referrer_host,
    count: Number(r.count),
  }));

  return {
    windowDays,
    totalPageviews: Number(totalRows[0]?.total ?? 0),
    uniqueVisitorsEstimate: Number(uniqueRows[0]?.uniq ?? 0),
    byDay,
    topPaths,
    topReferrers,
  };
}

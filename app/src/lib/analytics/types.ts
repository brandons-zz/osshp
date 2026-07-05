// Analytics types (issue 029) — the shapes the store returns and the dashboard
// renders. Kept separate from the DB row shapes (store.ts) so callers never see
// snake_case columns.

/** The only three windows the dashboard offers (design direction, issue 029). */
export type AnalyticsWindowDays = 7 | 30 | 90;

export const ANALYTICS_WINDOWS: readonly AnalyticsWindowDays[] = [7, 30, 90];

/** One point in the pageviews-over-time series — a UTC calendar day + count.
 *  Days with zero recorded pageviews are present (count: 0), never skipped, so
 *  the series has no gaps for the chart or the table to misrepresent. */
export interface PageviewDayPoint {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface TopPathRow {
  path: string;
  count: number;
}

export interface TopReferrerRow {
  referrerHost: string;
  count: number;
}

export interface AnalyticsSummary {
  windowDays: AnalyticsWindowDays;
  /** Total recorded pageviews in the window. */
  totalPageviews: number;
  /**
   * Unique-visitor ESTIMATE for the window (design direction, issue 029): a
   * salted daily-rotating hash makes same-day dedup exact but cross-day dedup
   * impossible by construction (privacy property, not a bug) — a visitor
   * active on 3 different days in the window counts 3 times. Always labeled
   * "estimate" wherever it is displayed.
   */
  uniqueVisitorsEstimate: number;
  /** Pageviews per UTC day, oldest first, zero-filled for gap days. */
  byDay: PageviewDayPoint[];
  /** Most-visited paths in the window, highest first. */
  topPaths: TopPathRow[];
  /** Most common external referrer hosts in the window, highest first. */
  topReferrers: TopReferrerRow[];
}

// /admin/analytics — pageviews/referrers/top-content dashboard (issue 029). This
// is the Analytics module's ONLY route; it is admin-only (default-deny fail-safe:
// the manifest omits `access`). Inert when the module is disabled, matching every
// other module's admin-list convention (see admin/blog/page.tsx).

import { getDb } from "@/lib/db/client";
import { isModuleEnabled } from "@/lib/platform";
import { ANALYTICS_MODULE_ID } from "@/modules/analytics/manifest";
import { getAnalyticsSummary } from "@/lib/analytics/store";
import {
  ANALYTICS_WINDOWS,
  type AnalyticsWindowDays,
} from "@/lib/analytics/types";
import { AnalyticsBarChart } from "./AnalyticsBarChart";

function parseWindowDays(raw: string | undefined): AnalyticsWindowDays {
  const n = Number(raw);
  return (ANALYTICS_WINDOWS as readonly number[]).includes(n)
    ? (n as AnalyticsWindowDays)
    : 30;
}

export default async function AnalyticsDashboard({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const db = getDb();
  if (!(await isModuleEnabled(db, ANALYTICS_MODULE_ID))) {
    return (
      <div className="stack">
        <h1>Analytics</h1>
        <p className="muted">
          The Analytics module is disabled. Enable it in{" "}
          <a href="/admin/settings">Settings</a>.
        </p>
      </div>
    );
  }

  const { window: windowParam } = await searchParams;
  const windowDays = parseWindowDays(windowParam);
  const summary = await getAnalyticsSummary(db, windowDays);
  const hasReferrers = summary.topReferrers.length > 0;
  const hasPageviews = summary.totalPageviews > 0;

  return (
    <div className="stack">
      <div className="row row-between">
        <h1>Analytics</h1>
        <nav className="analytics-window-nav" aria-label="Time window">
          {ANALYTICS_WINDOWS.map((w) => (
            <a
              key={w}
              href={`/admin/analytics?window=${w}`}
              aria-current={w === windowDays ? "page" : undefined}
            >
              {w} days
            </a>
          ))}
        </nav>
      </div>

      <p className="muted">
        First-party and self-hosted: no third-party script, no cookies, no
        personal data stored. Recorded events older than 90 days are pruned
        automatically. See the operator docs for the full privacy posture.
      </p>

      <div className="analytics-stats">
        <div className="analytics-stat">
          <p className="analytics-stat-value">
            {summary.totalPageviews.toLocaleString()}
          </p>
          <p className="analytics-stat-label">Pageviews</p>
        </div>
        <div className="analytics-stat">
          <p className="analytics-stat-value">
            {summary.uniqueVisitorsEstimate.toLocaleString()}
          </p>
          <p className="analytics-stat-label">Unique visitors (estimate)</p>
        </div>
      </div>

      <section className="stack" aria-labelledby="analytics-pageviews-heading">
        <h2 id="analytics-pageviews-heading">Pageviews over time</h2>
        {hasPageviews ? (
          <>
            <AnalyticsBarChart byDay={summary.byDay} />
            <table className="admin-table">
              <caption className="sr-only">
                Pageviews per day, last {windowDays} days
              </caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Pageviews</th>
                </tr>
              </thead>
              <tbody>
                {summary.byDay.map((point) => (
                  <tr key={point.day}>
                    <td>{point.day}</td>
                    <td>{point.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">
            No pageviews recorded yet in this window.
          </p>
        )}
      </section>

      <section className="stack" aria-labelledby="analytics-top-content-heading">
        <h2 id="analytics-top-content-heading">Top content</h2>
        {summary.topPaths.length > 0 ? (
          <table className="admin-table">
            <caption className="sr-only">
              Most-visited paths, last {windowDays} days
            </caption>
            <thead>
              <tr>
                <th scope="col">Path</th>
                <th scope="col">Pageviews</th>
              </tr>
            </thead>
            <tbody>
              {summary.topPaths.map((row) => (
                <tr key={row.path}>
                  <td>
                    <code>{row.path}</code>
                  </td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No pageviews recorded yet in this window.</p>
        )}
      </section>

      <section className="stack" aria-labelledby="analytics-referrers-heading">
        <h2 id="analytics-referrers-heading">Top referrers</h2>
        {hasReferrers ? (
          <table className="admin-table">
            <caption className="sr-only">
              Most common external referrer hosts, last {windowDays} days
            </caption>
            <thead>
              <tr>
                <th scope="col">Referrer</th>
                <th scope="col">Pageviews</th>
              </tr>
            </thead>
            <tbody>
              {summary.topReferrers.map((row) => (
                <tr key={row.referrerHost}>
                  <td>{row.referrerHost}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            No external referrers recorded yet in this window.
          </p>
        )}
      </section>
    </div>
  );
}

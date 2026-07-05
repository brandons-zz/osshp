"use client";

// Pageviews-over-time bar chart (issue 029).
//
// Bar heights are set via the CSSOM (`style.setProperty`) in an effect, never a
// JSX `style` prop — the app's CSP has no `unsafe-inline` on `style-src` (only a
// per-request nonce, headers.ts), so a literal `style="height:…"` ATTRIBUTE
// serialized into SSR HTML would be silently dropped by the browser. This is the
// same fix/pattern as AccentSwatch.tsx (issue 042): a CSSOM write in a client
// effect runs after the nonce-gated inline-style restriction has already done its
// job on the initial parse, and is unaffected by it.
//
// The chart is a decorative summary (role="img" with a text alternative); the
// exact per-day figures are the accessible <table> AnalyticsDashboard renders
// immediately below this component, so nothing here is the ONLY way to get the
// data (WCAG 1.4.1 — not conveyed by visual/color alone).

import { useEffect, useRef } from "react";
import type { PageviewDayPoint } from "@/lib/analytics/types";

/** Pure DOM step, isolated so it's unit-testable without a real element (bun
 *  test has no DOM/jsdom in this repo — see AccentSwatch's applyAccentSwatchColor
 *  for the same fake-object pattern). */
export function applyBarHeight(
  el: { style: { setProperty(prop: string, value: string): void } },
  percent: number,
): void {
  const clamped = Math.max(0, Math.min(100, percent));
  el.style.setProperty("height", `${clamped}%`);
}

export function AnalyticsBarChart({ byDay }: { byDay: PageviewDayPoint[] }) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);
  const max = Math.max(1, ...byDay.map((d) => d.count));

  useEffect(() => {
    byDay.forEach((point, i) => {
      const el = barRefs.current[i];
      if (el) applyBarHeight(el, (point.count / max) * 100);
    });
  }, [byDay, max]);

  return (
    <div
      className="analytics-chart"
      role="img"
      aria-label={`Pageviews per day over the last ${byDay.length} days. Exact daily figures are in the table below.`}
    >
      {byDay.map((point, i) => (
        <div
          key={point.day}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="analytics-bar"
          title={`${point.day}: ${point.count}`}
        />
      ))}
    </div>
  );
}

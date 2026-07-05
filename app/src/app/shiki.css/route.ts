// GET /shiki.css — serve the Shiki syntax-highlight CSS class stylesheet.
//
// This is the companion to the CSP-strict Shiki output (V-013 / A1). Shiki
// highlights code to CSS class names (no inline `style` attributes), and this
// route serves the generated CSS that maps those classes to their token colors
// for both the light (github-light) and dark (github-dark) schemes.
//
// The CSS is deterministic given the loaded themes and the code that has been
// highlighted in this server process. The warm-up in highlight.ts ensures the
// map is populated at module init, so the first browser fetch sees a complete
// stylesheet rather than an empty one.
//
// Cache-Control: the stylesheet grows over time as new token color combinations
// are encountered, so we use a short private TTL (60 s) with a stale-while-
// revalidate window that keeps most requests fast. The page's own HTML is
// rendered first (populating the color map), so the CSS is ready by the time
// the browser requests it.

import { getShikiCss } from "@/lib/theme/highlight";

export function GET(): Response {
  const css = getShikiCss();
  return new Response(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

// The public-site render path. Isolated from ./index because it imports
// react-dom/server (renderToStaticMarkup) — Next forbids that import in any module
// reachable from the component graph, and ./index is imported by the admin server
// components. Only the public route handlers import this module.
//
// The render flow: build a public-only ThemeRenderContext for the route, collect
// the ENABLED modules' theme-hook slot output (sanitized by the app pipeline), and
// render the whole document through the active theme — the module→theme seam.

import { getDb } from "@/lib/db/client";
import { renderRequest, type RouteRequest } from "@/lib/theme";
import { sanitizeHtmlFragment, sanitizeHeadFragment } from "@/lib/theme/sanitize";
import { SCHEME_STORAGE_KEY } from "@/lib/theme/scheme";
import { NONCE_HEADER } from "@/lib/security/headers";
import {
  getEnabledModuleIds,
  collectModuleSlotContributions,
  getDisabledModuleNavBases,
} from "@/lib/module";
import { getActiveTheme, getModuleRegistry } from "./index";
import { recordPageview, shouldCapturePageview } from "@/lib/analytics/capture";

export interface RenderPublicOptions {
  /** HTTP status for the response (e.g. 404 for a not-found route). */
  status?: number;
}

/** Render a public route through the active theme and return an HTML Response. */
export async function renderPublicRoute(
  req: RouteRequest,
  request: Request,
  opts: RenderPublicOptions = {},
): Promise<Response> {
  const db = getDb();
  const enabled = await getEnabledModuleIds(db);
  // issue 053 defect — public-route bases of disabled modules, so the masthead
  // nav drops any saved item that now points at a 404'd route.
  const disabledModuleNavBases = getDisabledModuleNavBases(
    getModuleRegistry(),
    enabled,
  );
  const allSlots = collectModuleSlotContributions(getModuleRegistry(), enabled, {
    sanitize: sanitizeHtmlFragment,
    sanitizeHead: sanitizeHeadFragment,
  });

  // Separate head.meta contributions from body-slot contributions. head.meta
  // is injected directly into the HTML string (before </head>) rather than
  // rendered through the theme's JSX document template. JSX cannot render
  // dangerouslySetInnerHTML without a host element, and any wrapper element
  // (<span>, <div>) is invalid in <head> — the browser exits head-parsing
  // mode on the first unknown element, pushing subsequent nodes into <body>.
  // String injection is the only way to place <link>/<meta> directly as
  // children of <head> with no wrapping element (Defect-2 fix).
  const headMetaHtml = allSlots
    .filter((s) => s.slot === "head.meta")
    .sort((a, b) => a.order - b.order)
    .map((s) => s.html)
    .join("");
  const bodySlots = allSlots.filter((s) => s.slot !== "head.meta");

  const theme = await getActiveTheme(db);
  // The per-request CSP nonce is set on the forwarded request headers by the
  // middleware (A1). Stamp it onto the theme's inline brand <style> + no-flash /
  // toggle scripts so they run under the nonce-based CSP.
  const nonce = request.headers.get(NONCE_HEADER) ?? undefined;
  const node = await renderRequest(db, theme, req, {
    slots: bodySlots, // head.meta excluded here; injected below as bare HTML
    persistedScheme: readSchemeCookie(request),
    nonce,
    // issue 028: filter the home showcase/ledger to enabled modules only.
    enabledModuleIds: enabled,
    // issue 053 defect: drop masthead nav links into disabled modules' routes.
    disabledModuleNavBases,
  });
  // Dynamic import: Next forbids a STATIC `react-dom/server` import anywhere in the
  // app graph (webpack plugin). A route handler legitimately renders the theme's
  // full document to a string; the dynamic import sidesteps the static check.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const rawHtml = "<!doctype html>" + renderToStaticMarkup(node);
  // Inject head.meta contributions directly before </head> with no wrapper
  // element — they become direct children of <head> in the final HTML.
  const html = headMetaHtml
    ? rawHtml.replace("</head>", headMetaHtml + "</head>")
    : rawHtml;

  // issue 029 — server-side pageview capture. This is THE single choke point
  // for every public HTML page-serve (every public route.ts calls
  // renderPublicRoute; admin pages, API routes, and static assets never do), so
  // it is the one place capture needs to be wired. Gated on the Analytics
  // module's enabled state — disabled means zero capture, not just a hidden
  // dashboard. Deliberately NOT awaited: recording a pageview must never add
  // latency to (or, if the DB write fails, ever break) the actual page-serve —
  // recordPageview is fail-open internally and this fire-and-forget call keeps
  // that failure mode from ever reaching the response.
  //
  // issue 067 (security gate): only a 200 serve is a pageview. A 404 render
  // (unknown slug, disabled module's route) records NOTHING — otherwise any
  // unauthenticated visitor spraying random slugs would mint unbounded unique
  // `path` rows and poison the top-content report with pages that never existed.
  const status = opts.status ?? 200;
  if (shouldCapturePageview(status, enabled)) {
    void recordPageview(db, request, new URL(request.url).pathname);
  }

  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** The visitor's persisted scheme override (cookie), if any. Exported for direct
 *  unit testing (issue 076) — the malformed-cookie regression must not depend
 *  on constructing a full renderPublicRoute() call. */
export function readSchemeCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SCHEME_STORAGE_KEY) {
      // The cookie is an ordinary, unsigned, client-writable value — a malformed
      // percent-encoding (e.g. a lone "%") must fall back to "no override"
      // rather than throw a URIError that 500s every themed public route
      // (issue 076). Mirrors normalizePath()'s "leave as-is" guard in
      // lib/auth/access.ts for the same decodeURIComponent failure mode.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

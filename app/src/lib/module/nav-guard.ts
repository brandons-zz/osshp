// Nav dead-link guard (issue 053 defect) — pure, dependency-free string logic so
// it is safe to import from both the server render path (theme/context) and the
// client Settings nav editor without dragging in the registry or server code.
//
// The problem: a nav item saved in `site.nav` that points at a module's public
// route (e.g. "/photos") becomes a dead public link the moment that module is
// disabled — its route 404s, but the stored nav config still lists it. The public
// masthead must reflect CURRENT module state, not the stored config, so we filter
// such items at render time. The admin nav editor reuses the same match to FLAG
// (not silently delete) the operator's affected item.

/**
 * Reduce a module route path to its static "nav base" — the concrete prefix a
 * nav href would target. A dynamic route like `/blog/[slug]` collapses to
 * `/blog`; a static route like `/photos` stays `/photos`. Trailing slash stripped.
 */
export function routeNavBase(routePath: string): string {
  const segments = routePath.split("/");
  const staticSegs: string[] = [];
  for (const seg of segments) {
    if (seg.includes("[")) break; // stop at the first dynamic segment
    staticSegs.push(seg);
  }
  const base = staticSegs.join("/");
  return base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * True when `href` targets the given nav base — an exact match or a path beneath
 * it (so `/blog` and `/blog/hello` both match base `/blog`, but `/blogroll` does
 * not).
 */
export function hrefUnderBase(href: string, base: string): boolean {
  if (!base || base === "/") return false; // never treat the site root as owned
  const h = href.trim();
  return h === base || h.startsWith(base + "/");
}

/** True when `href` falls under ANY of the supplied disabled-module nav bases. */
export function hrefTargetsDisabledModule(
  href: string,
  disabledBases: readonly string[],
): boolean {
  return disabledBases.some((base) => hrefUnderBase(href, base));
}

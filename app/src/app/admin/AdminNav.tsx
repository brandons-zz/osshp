"use client";

// AdminNav — the admin shell's navigation (issue 041: mobile-friendly nav).
//
// Previously the full link stack (Dashboard, module-projected links, the core
// surfaces, Sign out) rendered unconditionally — on a phone that consumed the
// entire first screen before any page content appeared. This splits the shell
// nav into a brand+toggle bar (always visible) and a link list that collapses
// behind a disclosure below the .shell breakpoint (48rem, shell.css) and stays
// exactly as it was — an always-visible column — at and above it, so the
// desktop layout is unchanged.
//
// Pattern: WAI-ARIA "disclosure (show/hide)" — a native <button> toggling
// aria-expanded + aria-controls over an inline sibling, NOT a modal overlay.
// That's a deliberate choice over a drawer/scrim: the content merely reflows
// (nothing is stacked on top of the page), so there is no focus trap to build
// and no return-focus edge case beyond the ordinary "Esc while inside returns
// you to the toggle" affordance added below. Keyboard operability (2.1.1),
// visible focus (2.4.7 — the global :focus-visible ring, structural.css), and
// name/role/value (4.1.2 — aria-expanded/aria-controls) all come from the
// native button + attributes; no ARIA widget role is needed for a disclosure.
//
// Active-item marking (v0.5.0 admin design refresh follow-up): the design
// specified an accent on the current page's nav entry but it shipped without
// one — neither aria-current nor a visual accent existed. shell.css already
// carried the finished visual rule (`.shell-nav-links a[aria-current="page"]`,
// added with the refresh but never applied by any component) reusing the
// same aria-current="page" pattern as .analytics-window-nav and
// .wizard-steps elsewhere in the shell; this file supplies the missing piece:
// deciding, and stamping, which entry is current.

import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

export interface AdminNavEntry {
  moduleId: string;
  href: string;
  label: string;
}

/**
 * Pure decision, isolated so it's unit-testable without a DOM (see
 * clickHitsNavLink above / use-dialog-focus-trap.test.ts for the same
 * pattern). Picks which of `hrefs` is "current" for `pathname`.
 *
 * Rule: a href matches when pathname === href OR pathname starts with
 * `href + "/"` (so a nested route like /admin/blog/42/edit still marks the
 * /admin/blog section entry as current). Where more than one href matches —
 * always true for /admin, since it's a prefix of every other admin path —
 * the LONGEST (most specific) matching href wins. That's what keeps
 * "Dashboard" (/admin) from lighting up on every other page while still
 * winning on the dashboard itself, with no special-casing of any one entry.
 * Returns null if nothing matches.
 */
export function decideActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/**
 * Pure decision, isolated so it's unit-testable without a DOM (bun test has no
 * jsdom in this repo — see use-dialog-focus-trap.test.ts for the same
 * fake-object pattern). True when a click landed on (or inside) a link, which
 * means the mobile disclosure should close so the next screen starts
 * collapsed instead of staying pinned open after navigation.
 */
export function clickHitsNavLink(target: { closest(selector: string): unknown }): boolean {
  return target.closest("a") !== null;
}

export function AdminNav({
  nav,
  children,
}: {
  /** Module-projected nav entries, pre-sorted by the layout (module-contract). */
  nav: AdminNavEntry[];
  /** Rendered into .shell-nav-footer (LogoutButton) — kept as children so the
      caller (layout.tsx) stays a plain server component. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  const staticHrefs = [
    "/admin",
    "/admin/media",
    "/admin/tags",
    "/admin/account/security",
    "/admin/security",
    "/admin/settings",
    "/admin/export",
    "/admin/import",
    "/",
  ];
  const activeHref = decideActiveHref(pathname ?? "", [
    ...staticHrefs,
    ...nav.map((entry) => entry.href),
  ]);
  function currentIfActive(href: string): "page" | undefined {
    return href === activeHref ? "page" : undefined;
  }

  function handleLinksClick(e: React.MouseEvent<HTMLDivElement>) {
    if (clickHitsNavLink(e.target as HTMLElement)) setOpen(false);
  }

  function handleLinksKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && open) {
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  return (
    <nav className="shell-nav" aria-label="Admin" data-nav-open={open}>
      <div className="shell-nav-bar">
        <p className="shell-brand">osshp admin</p>
        <button
          ref={toggleRef}
          type="button"
          className="shell-nav-toggle"
          aria-expanded={open}
          aria-controls="admin-nav-links"
          aria-label={open ? "Close admin menu" : "Open admin menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="shell-nav-toggle-bars" aria-hidden="true" />
        </button>
      </div>
      <div
        id="admin-nav-links"
        className="shell-nav-links"
        onClick={handleLinksClick}
        onKeyDown={handleLinksKeyDown}
      >
        <a href="/admin" aria-current={currentIfActive("/admin")}>Dashboard</a>
        {nav.map((entry) => (
          <a
            key={`${entry.moduleId}-${entry.href}`}
            href={entry.href}
            aria-current={currentIfActive(entry.href)}
          >
            {entry.label}
          </a>
        ))}
        {/* Media is a CORE surface (the media table is shared by Blog/Photos/
            Pages), so it is a static link like Settings/Export/Import — never
            projected from a module's adminNav (issue 037 §2.1). */}
        <a href="/admin/media" aria-current={currentIfActive("/admin/media")}>Media</a>
        {/* Tags are likewise CORE — shared by Blog and Photos posts — so this
            is a static link rather than projected from a single module's
            adminNav (tag-management feature). */}
        <a href="/admin/tags" aria-current={currentIfActive("/admin/tags")}>Tags</a>
        <a href="/admin/account/security" aria-current={currentIfActive("/admin/account/security")}>Account security</a>
        <a href="/admin/security" aria-current={currentIfActive("/admin/security")}>Security Center</a>
        <a href="/admin/settings" aria-current={currentIfActive("/admin/settings")}>Settings</a>
        <a href="/admin/export" aria-current={currentIfActive("/admin/export")}>Export / Backup</a>
        <a href="/admin/import" aria-current={currentIfActive("/admin/import")}>Import</a>
        <a href="/" aria-current={currentIfActive("/")}>View site</a>
        <div className="shell-nav-footer">{children}</div>
      </div>
    </nav>
  );
}

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

import { useRef, useState } from "react";
import type { ReactNode } from "react";

export interface AdminNavEntry {
  moduleId: string;
  href: string;
  label: string;
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
        <a href="/admin">Dashboard</a>
        {nav.map((entry) => (
          <a key={`${entry.moduleId}-${entry.href}`} href={entry.href}>
            {entry.label}
          </a>
        ))}
        {/* Media is a CORE surface (the media table is shared by Blog/Photos/
            Pages), so it is a static link like Settings/Export/Import — never
            projected from a module's adminNav (issue 037 §2.1). */}
        <a href="/admin/media">Media</a>
        <a href="/admin/account/security">Account security</a>
        <a href="/admin/security">Security Center</a>
        <a href="/admin/settings">Settings</a>
        <a href="/admin/export">Export / Backup</a>
        <a href="/admin/import">Import</a>
        <a href="/">View site</a>
        <div className="shell-nav-footer">{children}</div>
      </div>
    </nav>
  );
}

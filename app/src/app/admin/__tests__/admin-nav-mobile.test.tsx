// Issue 041 — the admin nav collapses behind a disclosure on small screens
// instead of rendering as a full-height stacked list.
//
// bun test has no DOM/jsdom in this repo (see use-dialog-focus-trap.test.ts),
// so interactive state transitions aren't exercisable here; that pure logic is
// isolated into clickHitsNavLink and unit-tested directly (same fake-object
// pattern as nextTrapTarget). What IS verified via renderToStaticMarkup is the
// wiring a screen reader / keyboard user depends on: the toggle button's
// accessible name/role/value (4.1.2) and correct aria-expanded/aria-controls
// pairing (2.1.1/2.4.7 rely on this being right), present from the very first
// paint (SSR, before hydration).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminNav, clickHitsNavLink } from "../AdminNav";

const NAV = [
  { moduleId: "blog", href: "/admin/blog", label: "Blog" },
  { moduleId: "photos", href: "/admin/photos", label: "Photos" },
];

describe("AdminNav — mobile disclosure (issue 041)", () => {
  test("initial (closed) render exposes a keyboard/AT-correct toggle", () => {
    const html = renderToStaticMarkup(
      <AdminNav nav={NAV}>
        <button type="button">Sign out</button>
      </AdminNav>,
    );
    // A real <button>, not a div/span with a click handler — native keyboard
    // operability (2.1.1) and role (4.1.2) for free.
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Open admin menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="admin-nav-links"');
    // The controlled element actually exists and carries the matching id.
    expect(html).toContain('id="admin-nav-links"');
  });

  test("core surfaces + module-projected links + Dashboard all render inside the (collapsible) link list", () => {
    const html = renderToStaticMarkup(
      <AdminNav nav={NAV}>
        <button type="button">Sign out</button>
      </AdminNav>,
    );
    for (const href of [
      "/admin",
      "/admin/blog",
      "/admin/photos",
      "/admin/media",
      "/admin/account/security",
      "/admin/settings",
      "/admin/export",
      "/admin/import",
      "/",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("Sign out");
  });

  test("desktop structure is unchanged: same shell-nav / shell-brand / shell-nav-footer classes as before", () => {
    const html = renderToStaticMarkup(
      <AdminNav nav={NAV}>
        <button type="button">Sign out</button>
      </AdminNav>,
    );
    expect(html).toContain('class="shell-nav"');
    expect(html).toContain('class="shell-brand"');
    expect(html).toContain('class="shell-nav-footer"');
    expect(html).toContain("osshp admin");
  });
});

describe("clickHitsNavLink — pure decision for auto-closing the mobile menu", () => {
  test("true when the click lands inside an <a>", () => {
    const target = { closest: (sel: string) => (sel === "a" ? {} : null) };
    expect(clickHitsNavLink(target)).toBe(true);
  });

  test("false when the click lands outside any <a> (e.g. empty space in the panel)", () => {
    const target = { closest: () => null };
    expect(clickHitsNavLink(target)).toBe(false);
  });
});

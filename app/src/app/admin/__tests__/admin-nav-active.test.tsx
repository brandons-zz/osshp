// v0.5.0 admin design refresh follow-up — the nav shipped with no indication
// of which page is current, neither programmatic (aria-current) nor visual
// (shell.css's `.shell-nav-links a[aria-current="page"]` accent, which was
// already defined but never applied). This closes that gap.
//
// bun test has no DOM/jsdom in this repo (see use-dialog-focus-trap.test.ts),
// and next/navigation's usePathname can't be pointed at an arbitrary path
// without `mock.module` — which recovery-login-routes.test.ts and
// type-guard.test.ts both document avoiding, because bun:test shares one
// module registry across the whole run and a mock would leak into unrelated
// test files. So, same as clickHitsNavLink above, the matching rule is
// isolated into a pure function and unit-tested directly.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminNav, decideActiveHref } from "../AdminNav";

const NAV = [
  { moduleId: "blog", href: "/admin/blog", label: "Blog" },
  { moduleId: "photos", href: "/admin/photos", label: "Photos" },
];

const ALL_HREFS = [
  "/admin",
  "/admin/media",
  "/admin/tags",
  "/admin/account/security",
  "/admin/security",
  "/admin/settings",
  "/admin/export",
  "/admin/import",
  "/",
  "/admin/blog",
  "/admin/photos",
];

describe("decideActiveHref — matching rule for the current nav entry", () => {
  test("exact match on the dashboard root", () => {
    expect(decideActiveHref("/admin", ALL_HREFS)).toBe("/admin");
  });

  test("exact match on a static core surface", () => {
    expect(decideActiveHref("/admin/settings", ALL_HREFS)).toBe("/admin/settings");
  });

  test("a page nested under a section marks that section's entry current, not Dashboard", () => {
    expect(decideActiveHref("/admin/blog/42/edit", ALL_HREFS)).toBe("/admin/blog");
  });

  test("Dashboard does NOT light up for any other admin page (no accidental prefix match)", () => {
    expect(decideActiveHref("/admin/photos", ALL_HREFS)).not.toBe("/admin");
    expect(decideActiveHref("/admin/security", ALL_HREFS)).not.toBe("/admin");
  });

  test("longest match wins when multiple hrefs are prefixes of the pathname", () => {
    // /admin, /admin/account/security are both prefixes of the nested path;
    // the most specific (longest) one must win.
    expect(decideActiveHref("/admin/account/security/sessions", [
      "/admin",
      "/admin/account/security",
    ])).toBe("/admin/account/security");
  });

  test("distinct sibling sections never cross-match each other", () => {
    expect(decideActiveHref("/admin/security", ALL_HREFS)).toBe("/admin/security");
    expect(decideActiveHref("/admin/account/security", ALL_HREFS)).toBe("/admin/account/security");
  });

  test("no match returns null (e.g. an unmapped path)", () => {
    expect(decideActiveHref("/login", ALL_HREFS)).toBeNull();
  });

  test("an exact match wins even though a shorter prefix also matches", () => {
    expect(decideActiveHref("/admin", ["/admin", "/"])).toBe("/admin");
  });
});

describe("AdminNav — renders without a resolvable pathname (no Next router context in bun test)", () => {
  test("does not crash, and stamps no aria-current when the pathname can't be matched", () => {
    const html = renderToStaticMarkup(
      <AdminNav nav={NAV}>
        <button type="button">Sign out</button>
      </AdminNav>,
    );
    expect(html).not.toContain('aria-current="page"');
  });
});

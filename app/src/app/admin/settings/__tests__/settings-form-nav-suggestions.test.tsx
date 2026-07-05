// issue 053 — the Settings nav editor offers enabled-module public sections
// (Blog, Photos) as one-click "Add" chips so a published photo at /photos is
// reachable from the public nav. Owner keeps control: nothing is auto-added.
// Structural SSR test — click behavior is browser-native, verified at runtime.

import { expect, test, describe } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsForm } from "../SettingsForm";

const base = {
  title: "S",
  description: "",
  homeIntro: "",
  locale: "en",
  accent: "#2563eb",
  fontHeading: "",
  fontBody: "",
  defaultScheme: "auto" as const,
  socialJson: "[]",
  logoSrc: "",
  logoAlt: "",
};

describe("SettingsForm module public-nav suggestion chips (issue 053)", () => {
  test("shows an Add chip for a module section not already in the nav", () => {
    const html = renderToStaticMarkup(
      <SettingsForm
        {...base}
        navJson="[]"
        moduleNavSuggestions={[
          { label: "Photos", href: "/photos" },
          { label: "Blog", href: "/blog" },
        ]}
      />,
    );
    expect(html).toContain("nav-suggestion-chip");
    expect(html).toContain("Photos");
    expect(html).toContain("Blog");
  });

  test("hides the chip once that href is already in the nav (no double-listing)", () => {
    const html = renderToStaticMarkup(
      <SettingsForm
        {...base}
        navJson={JSON.stringify([{ label: "Photos", href: "/photos" }])}
        moduleNavSuggestions={[
          { label: "Photos", href: "/photos" },
          { label: "Blog", href: "/blog" },
        ]}
      />,
    );
    // Blog chip still offered; Photos chip suppressed (present in nav already).
    const chipCount = (html.match(/nav-suggestion-chip/g) ?? []).length;
    expect(chipCount).toBe(1);
    expect(html).toContain("+ Blog");
  });

  test("renders no suggestion group when there are no suggestions", () => {
    const html = renderToStaticMarkup(
      <SettingsForm {...base} navJson="[]" moduleNavSuggestions={[]} />,
    );
    expect(html).not.toContain("nav-suggestions");
  });
});

describe("SettingsForm disabled-module nav flag (issue 053 defect)", () => {
  test("flags a nav row whose href targets a disabled module", () => {
    const html = renderToStaticMarkup(
      <SettingsForm
        {...base}
        navJson={JSON.stringify([{ label: "Photos", href: "/photos" }])}
        disabledModuleNavBases={["/photos"]}
      />,
    );
    expect(html).toContain("Points to a disabled module");
  });

  test("does not flag a normal nav row when no module is disabled", () => {
    const html = renderToStaticMarkup(
      <SettingsForm
        {...base}
        navJson={JSON.stringify([{ label: "Photos", href: "/photos" }])}
        disabledModuleNavBases={[]}
      />,
    );
    expect(html).not.toContain("Points to a disabled module");
  });
});

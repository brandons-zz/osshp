import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Link, Prose } from "../index";

const stylesDir = path.join(import.meta.dir, "../../../styles");
// Layer-1 structural tokens are served as a static asset (public/structural.css)
// so the public theme route handlers and the app shell load one canonical sheet.
const structural = readFileSync(
  path.join(import.meta.dir, "../../../../public/structural.css"),
  "utf8",
);
const kernel = readFileSync(path.join(stylesDir, "kernel.css"), "utf8");

// Strip CSS comments before token assertions so commented px references
// (e.g. "/* 18px */") can't satisfy or falsely trip a check.
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Layer-1 structural token sheet (theme-immutable contract)", () => {
  const body = stripComments(structural);

  // Every Layer-1 token the theme-rendering-contract §5.1 fixes as app-owned.
  // A dropped token would let a theme reintroduce structural drift, so the
  // completeness of this set is the load-bearing property.
  const REQUIRED: string[] = [
    // type scale
    "--text-2xs", "--text-xs", "--text-sm", "--text-base", "--text-prose",
    "--text-lg", "--text-xl", "--text-2xl", "--text-3xl", "--text-4xl",
    // line-heights
    "--leading-tight", "--leading-snug", "--leading-normal",
    // weight map
    "--weight-regular", "--weight-medium", "--weight-semibold", "--weight-bold",
    // tracking
    "--tracking-tight", "--tracking-normal",
    // spacing
    "--space-3xs", "--space-2xs", "--space-xs", "--space-s", "--space-m",
    "--space-l", "--space-xl", "--space-2xl", "--space-3xl",
    // radii
    "--radius-sm", "--radius-md", "--radius-lg", "--radius-full",
    // border widths
    "--border-hairline", "--border-thick",
    // layout measures
    "--measure-prose", "--measure-content", "--measure-wide",
    // focus geometry
    "--focus-width", "--focus-offset",
    // motion
    "--dur", "--ease",
    // font roles
    "--font-body", "--font-heading", "--font-mono",
  ];

  for (const token of REQUIRED) {
    test(`defines ${token} on :root`, () => {
      // Must appear as a declaration (token followed by a colon), not just text.
      expect(body).toMatch(new RegExp(`\\${token}\\s*:`));
    });
  }

  test("emits the structural tokens on :root", () => {
    expect(body).toMatch(/:root\s*{/);
  });

  test("focus geometry is structural; focus color stays a theme token", () => {
    // The geometry values are fixed here; the COLOR must come from --focus
    // (a Layer-2/3 theme token), never a hardcoded color in the structural sheet.
    expect(body).toMatch(/--focus-width\s*:\s*3px/);
    expect(body).toMatch(/--focus-offset\s*:\s*2px/);
    expect(body).toMatch(/outline:[^;]*var\(--focus/);
  });
});

describe("kernel reads semantic tokens only — no raw hex", () => {
  test("kernel.css contains no hex color literals", () => {
    // Components must read semantic/structural token names, never raw hex
    // (ui-component-contract §5.1). A baked #rrggbb would break theming.
    const body = stripComments(kernel);
    const hexMatches = body.match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(hexMatches).toBeNull();
  });

  test("kernel color properties resolve through var() tokens", () => {
    const body = stripComments(kernel);
    expect(body).toMatch(/background-color:\s*var\(--accent-solid/);
    expect(body).toMatch(/color:\s*var\(--on-accent/);
    expect(body).toMatch(/color:\s*var\(--accent-text/);
  });

  test("prose container pins the Layer-1 reading measure", () => {
    const body = stripComments(kernel);
    expect(body).toMatch(/max-width:\s*var\(--measure-prose\)/);
  });
});

describe("owned-component kernel render contract", () => {
  test("Button renders a native <button> with type=button by default", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('class="osshp-button"');
    expect(html).toContain("Save");
  });

  test("Button asChild composes Radix Slot onto the child element", () => {
    // Proves the vendored-primitive composition: Slot merges the kernel class
    // onto the child <a> rather than wrapping it in a <button>.
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/blog">Read the blog</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).toContain('href="/blog"');
    expect(html).toContain('class="osshp-button"');
  });

  test("Button merges caller className without dropping the kernel class", () => {
    const html = renderToStaticMarkup(<Button className="cta">Go</Button>);
    expect(html).toContain('class="osshp-button cta"');
  });

  test("Link is a native anchor and forwards href (keyboard/role native)", () => {
    const html = renderToStaticMarkup(<Link href="/about">About</Link>);
    expect(html).toContain("<a");
    expect(html).toContain('href="/about"');
    expect(html).toContain('class="osshp-link"');
  });

  test("Prose renders a constrained reading container", () => {
    const html = renderToStaticMarkup(<Prose>Body copy.</Prose>);
    expect(html).toContain('class="osshp-prose"');
    expect(html).toContain("Body copy.");
  });
});

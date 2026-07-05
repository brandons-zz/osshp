import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../sanitize";

// Shiki code highlighting EXTENDS the §9 sanitize pipeline (it is not a parallel
// sanitizer). These tests verify intent: a fenced block in a known language comes
// out Shiki-highlighted, an unknown language degrades to a plain (still-sanitized)
// block rather than throwing, and the sanitization boundary is unchanged by the
// Shiki step.

describe("renderMarkdown — Shiki code highlighting (§7)", () => {
  test("highlights a fenced code block in a known language", () => {
    const out = renderMarkdown("```ts\nconst x: number = 1;\n```\n");
    // Shiki wraps the block in a .shiki <pre> with CSS class names (not inline
    // styles — V-013 CSP fix). The class names start with "shkt" (token) or
    // "shkb" (background).
    expect(out).toContain("shiki");
    // CSS classes are present (CSP-safe output)
    expect(out).toMatch(/class="[^"]*shkt/);
    // NO inline color style attributes — this would violate style-src CSP (V-013).
    expect(out).not.toMatch(/style="[^"]*color:/);
    expect(out).not.toMatch(/style="[^"]*--shiki/);
    // The code text survives.
    expect(out).toContain("const");
  });

  test("falls back to a plain code block for an unknown language (no throw)", () => {
    const out = renderMarkdown("```nosuchlang\nplain text body\n```\n");
    expect(out).toContain("plain text body");
    expect(out).toContain("<code");
    // Not highlighted — no Shiki wrapper for an unloaded language.
    expect(out).not.toContain("shiki");
  });

  test("still strips dangerous HTML — the sanitize boundary is intact", () => {
    const out = renderMarkdown(
      "# Title\n\n<script>alert('xss')</script>\n\n```js\nconsole.log(1)\n```\n",
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(");
    expect(out).toContain("<h1>");
    // and the code block is highlighted.
    expect(out).toContain("shiki");
  });
});

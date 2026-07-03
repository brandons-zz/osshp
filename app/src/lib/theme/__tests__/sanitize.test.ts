import { describe, expect, test } from "bun:test";
import { renderMarkdown, sanitizeHtmlFragment, sanitizeHeadFragment } from "../sanitize";

// The sanitization boundary (§9) must STRIP dangerous HTML — these tests fail if
// the pipeline ever lets script/event-handler/javascript: through, which is the
// whole point of the branded SanitizedHtml type.

describe("renderMarkdown — markdown bodies → sanitized HTML", () => {
  test("strips a raw <script> embedded in markdown", () => {
    const out = renderMarkdown("# Title\n\n<script>alert('xss')</script>\n");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(");
    // Safe markdown still renders.
    expect(out).toContain("<h1>");
    expect(out).toContain("Title");
  });

  test("drops a javascript: link href but keeps the link text", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  test("preserves safe formatting and http(s) links", () => {
    const out = renderMarkdown(
      "**bold** and [site](https://example.com) and `code`",
    );
    expect(out).toContain("<strong>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("<code>");
  });
});

describe("sanitizeHtmlFragment — module slot HTML", () => {
  test("strips an onerror event handler attribute", () => {
    const out = sanitizeHtmlFragment('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(");
  });

  test("strips a <script> in a fragment but keeps benign markup", () => {
    const out = sanitizeHtmlFragment(
      "<p>related</p><script>steal()</script>",
    );
    expect(out).toContain("<p>related</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("steal(");
  });
});

describe("sanitizeHeadFragment — module head.meta slot HTML", () => {
  test("preserves <link rel='alternate'> with safe attributes (RSS autodiscovery)", () => {
    const out = sanitizeHeadFragment(
      '<link rel="alternate" type="application/rss+xml" title="RSS feed" href="/rss.xml">',
    );
    expect(out).toContain('rel="alternate"');
    expect(out).toContain("application/rss+xml");
    expect(out).toContain("/rss.xml");
  });

  test("preserves <meta name> elements", () => {
    const out = sanitizeHeadFragment('<meta name="robots" content="index,follow">');
    expect(out).toContain('name="robots"');
    expect(out).toContain('content="index,follow"');
  });

  test("strips <script> from head fragments", () => {
    const out = sanitizeHeadFragment(
      '<script>alert(1)</script><meta name="safe" content="yes">',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(");
    expect(out).toContain("safe");
  });

  test("strips javascript: href on <link> elements", () => {
    const out = sanitizeHeadFragment(
      '<link rel="stylesheet" href="javascript:alert(1)">',
    );
    expect(out).not.toContain("javascript:");
  });

  test("strips event-handler attributes on <link> elements", () => {
    const out = sanitizeHeadFragment('<link rel="preload" onerror="steal()">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("steal(");
  });

  test("strips <style> entirely — text content does not leak as a bare text node", () => {
    // Without "style" in HEAD_SCHEMA.strip, rehype-sanitize would unwrap the
    // <style> tag (element removed, text content survives as a bare text node).
    // That bare text node would be injected into <head> as invisible but
    // DOM-polluting content — potentially leaking CSS injection strings.
    const out = sanitizeHeadFragment(
      '<style>body{color:red;}@import url(//evil)</style><meta name="safe" content="yes">',
    );
    expect(out).not.toContain("<style");
    expect(out).not.toContain("@import");
    expect(out).not.toContain("body{color");
    expect(out).not.toContain("url(//evil)");
    // Safe sibling element still passes through.
    expect(out).toContain('name="safe"');
  });
});

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

describe("renderMarkdown — captioned images render as <figure>/<figcaption> (issue 077)", () => {
  test("a titled image renders as a figure with a figcaption carrying the caption text", () => {
    const out = renderMarkdown('![a red barn](https://example.com/barn.jpg "Photo by Jane Doe")');
    expect(out).toContain("<figure>");
    expect(out).toContain("<figcaption>");
    expect(out).toContain("Photo by Jane Doe");
    // Alt stays the accessibility description on the <img> itself.
    expect(out).toContain('alt="a red barn"');
    // The credit is never smuggled into alt.
    expect(out).not.toContain('alt="Photo by Jane Doe"');
  });

  test("the title attribute is removed once it becomes the visible figcaption (never a hover-only tooltip)", () => {
    const out = renderMarkdown('![alt](https://example.com/x.jpg "credit text")');
    expect(out).not.toContain('title="credit text"');
  });

  test("a plain, untitled image renders as a bare <img> — no figure/figcaption added", () => {
    const out = renderMarkdown("![just an image](https://example.com/plain.jpg)");
    expect(out).not.toContain("<figure>");
    expect(out).not.toContain("<figcaption>");
    expect(out).toContain("<img");
    expect(out).toContain('alt="just an image"');
  });

  test("a bare http(s) URL inside the caption becomes a real, safe anchor (the 'linked source credit')", () => {
    const out = renderMarkdown(
      '![a cat](https://example.com/cat.jpg "Photo by Jane Doe — Source: https://original-host.example/cat.jpg")',
    );
    expect(out).toContain("<figcaption>");
    expect(out).toContain('href="https://original-host.example/cat.jpg"');
    expect(out).toContain("Photo by Jane Doe");
    // The link is safe by construction: nofollow + noopener, and it is a real
    // <a> the sanitizer schema validated, not raw injected markup.
    expect(out).toContain("rel=\"nofollow noopener\"");
  });

  test("a standalone image paragraph becomes the <figure> directly — never <figure> nested inside <p>", () => {
    const out = renderMarkdown('![alt](https://example.com/solo.jpg "caption")');
    // Regression guard for the "block element inside <p>" HTML-validity class
    // this theme has hit before with module slot output.
    expect(out).not.toMatch(/<p>\s*<figure>/);
  });

  test("the figcaption credit text is visible content, not an attribute — screen readers announce it separately from alt", () => {
    const out = renderMarkdown('![a cat](https://example.com/cat.jpg "Photo: Jane Doe")');
    // figcaption text is genuine element content (between tags), not an
    // attribute value — this is what makes it visible/readable, unlike title.
    expect(out).toMatch(/<figcaption>[^<]*Photo: Jane Doe/);
  });

  test("multiple captioned images in one body each get their own figure", () => {
    const out = renderMarkdown(
      '![first](https://example.com/a.jpg "A")\n\n![second](https://example.com/b.jpg "B")',
    );
    expect(out.split("<figure>").length - 1).toBe(2);
    expect(out).toContain("A");
    expect(out).toContain("B");
  });

  test("script content injected as a caption is still sanitized (defense in depth on constructed nodes)", () => {
    const out = renderMarkdown(
      '![alt](https://example.com/x.jpg "<script>alert(1)</script> caption")',
    );
    // Markdown titles are plain-text attribute values (never HTML), so the
    // literal text is expected to survive — the security property is that it
    // is ESCAPED text content (inert), never a live, executable <script> tag.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
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

// Intent: MarkdownHelp renders the "?" trigger button and a native <dialog>
// containing the Markdown syntax reference (V-009). Structural contract tests —
// interactive behavior (open/close, focus management) is browser-native and
// verified separately at runtime.

import { expect, test, describe } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownHelp } from "../markdown-help";

describe("MarkdownHelp (V-009 — Markdown editor inline reference)", () => {
  test("renders a visible trigger button with aria-label", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("<button");
    expect(html).toContain("osshp-md-help-btn");
    expect(html).toContain('aria-label="Open Markdown syntax reference"');
  });

  test("trigger button shows the '?' character", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("?");
  });

  test("renders a <dialog> element for the reference panel", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("<dialog");
  });

  test("dialog has osshp-dialog kernel class", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("osshp-dialog");
  });

  test("dialog has the help-specific class for sizing/scroll", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("osshp-md-help-dialog");
  });

  test("dialog has accessible name via aria-label", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain('aria-label="Markdown syntax reference"');
  });

  test("reference includes heading syntax", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("# Heading 1");
  });

  test("reference includes bold/italic emphasis", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("**bold**");
    expect(html).toContain("_italic_");
  });

  test("reference includes link syntax", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("[link text]");
  });

  test("reference includes inline code syntax", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("`code`");
  });

  test("reference includes blockquote syntax", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("&gt; quoted text");
  });

  test("Close button is present inside the dialog", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    expect(html).toContain("Close");
    // Must be a native <button> (keyboard-operable).
    expect(html).toContain('type="button"');
  });

  test("no inline script or inline event handler attributes (CSP-safe)", () => {
    const html = renderToStaticMarkup(<MarkdownHelp />);
    // CSP strict-dynamic + nonce — no onclick="" or other inline event attrs.
    expect(html).not.toMatch(/\bonclick=/);
    expect(html).not.toMatch(/\bonkeydown=/);
  });
});

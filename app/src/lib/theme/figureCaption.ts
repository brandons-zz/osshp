// Captioned-image rendering (issue 077): an `<img title="…">` produced by
// remark-rehype from `![alt](url "caption")` is wrapped into
// `<figure><img><figcaption>…</figcaption></figure>` — a plain, untitled
// image is left completely untouched.
//
// This EXTENDS the §9 sanitizing pipeline in sanitize.ts — it does NOT
// introduce a parallel sanitizer, exactly like rehypeShikiSync (highlight.ts).
// Unlike Shiki (which runs AFTER rehype-sanitize on already-sanitized output),
// this plugin runs BEFORE rehype-sanitize: it only restructures nodes that
// remark-rehype already produced from trusted markdown syntax, and every node
// it constructs (figure/figcaption/a) is still validated by the sanitizer
// schema immediately afterward — defense in depth, not a bypass.
//
// Alt stays exactly where it was (the accessibility description, WCAG 1.1.1) —
// this plugin never touches it. The `title` attribute is removed once its text
// becomes the visible figcaption, so the credit is never a hover-only tooltip.
//
// "A linked source credit": auto-import (media/autoImport.ts) writes a title
// of the form `<author caption> — Source: <url>` (or just `Source: <url>` when
// the author left no caption). This plugin auto-links any bare http(s) URL
// substring inside the caption text — a pure, render-time transform of
// markdown text, so the credit round-trips through content export/import for
// free (the body markdown, title included, passes through export/import
// verbatim except for the media link itself) with zero database access at
// render time.

import type { Element, ElementContent, Root, RootContent } from "hast";

const URL_IN_TEXT_RE = /(https?:\/\/[^\s)"<]+)/g;

/** Split caption text on bare http(s) URLs, turning each into a real,
 *  protocol-checked anchor (rel=nofollow noopener, opens in a new tab). */
function linkifyCaption(text: string): ElementContent[] {
  const parts = text.split(URL_IN_TEXT_RE);
  const nodes: ElementContent[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") continue;
    if (i % 2 === 1) {
      // Odd indices are the captured URL groups — String.split keeps captures.
      nodes.push({
        type: "element",
        tagName: "a",
        properties: { href: part, rel: "nofollow noopener", target: "_blank" },
        children: [{ type: "text", value: part }],
      });
    } else {
      nodes.push({ type: "text", value: part });
    }
  }
  return nodes;
}

/** Build the `<figure>` for a titled `<img>`, or null if it has no title
 *  (nothing to caption — leave the plain image untouched). */
function captionedFigure(img: Element): Element | null {
  const rawTitle = img.properties?.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (title === "") return null;
  const cleanedImg: Element = { ...img, properties: { ...img.properties } };
  delete cleanedImg.properties.title;
  return {
    type: "element",
    tagName: "figure",
    properties: {},
    children: [
      cleanedImg,
      {
        type: "element",
        tagName: "figcaption",
        properties: {},
        children: linkifyCaption(title),
      },
    ],
  };
}

function isImg(node: RootContent | ElementContent): node is Element {
  return node.type === "element" && node.tagName === "img";
}

/** Recursively replace titled `<img>` elements with captioned `<figure>`s. A
 *  `<p>` whose ONLY meaningful child is a single titled image is replaced by
 *  the `<figure>` itself (the common "standalone image paragraph" case) so a
 *  block-level `<figure>` never ends up nested inside a `<p>` — the same
 *  "block element inside <p>" HTML-validity class the theme has hit before
 *  with module slot output. An inline image with siblings is wrapped in
 *  place — a rarer authoring pattern, and non-fatal even if a `<figure>`
 *  lands inside a `<p>` there (the browser closes the `<p>` early). */
function walk(children: Array<RootContent | ElementContent>): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== "element") continue;

    if (child.tagName === "p") {
      const meaningful = child.children.filter(
        (c) => !(c.type === "text" && c.value.trim() === ""),
      );
      if (meaningful.length === 1 && isImg(meaningful[0])) {
        const figure = captionedFigure(meaningful[0]);
        if (figure) {
          children[i] = figure;
          continue;
        }
      }
      walk(child.children);
      continue;
    }

    if (isImg(child)) {
      const figure = captionedFigure(child);
      if (figure) {
        children[i] = figure;
        continue;
      }
    }

    if (child.children) walk(child.children);
  }
}

/**
 * Rehype plugin: wrap captioned images into `<figure>/<figcaption>`. Placed
 * BEFORE rehype-sanitize in the markdown processor (sanitize.ts) so every
 * node it produces is still validated by the (figure/figcaption-extended)
 * sanitizer schema afterward.
 */
export function rehypeFigureCaption() {
  return (tree: Root): void => {
    walk(tree.children);
  };
}

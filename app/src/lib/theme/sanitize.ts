// The app-owned untrusted-output / sanitization boundary
// (theme-rendering-contract §9, spec §7).
//
// ALL HTML that reaches a theme — post/page bodies (from markdown) and module
// slot output (HTML fragments) — passes through this pipeline FIRST. A theme
// renders the result and MUST NOT author dangerouslySetInnerHTML from any other
// source. `SanitizedHtml` is a branded type that can only be produced here, so a
// theme (or a module) cannot mint one from unsanitized input.
//
// This is the same unified/remark/rehype-sanitize pipeline the spec names as the
// app-owned sanitizer (library audit #4). The richer markdown features and code
// highlighting (M2.3) extend these processors but INHERIT this boundary.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { SanitizedHtml } from "./types";
import { rehypeShikiSync } from "./highlight";

// Markdown source (post/page bodies) → sanitized HTML.
// rehypeShikiSync runs AFTER rehypeSanitize: it highlights already-sanitized code
// blocks (Shiki for code highlighting, §7) and is an extension of this single
// boundary, not a parallel sanitizer.
const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeShikiSync)
  .use(rehypeStringify);

// HTML fragments (module slot output) → sanitized HTML.
const htmlFragmentProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize)
  .use(rehypeStringify);

// Head HTML fragments (module head.meta slot contributions). Allows <link> and
// <meta> elements with head-appropriate attributes; strips everything else.
// Protocol filter on href restricts to http/https — no javascript: or data: URLs.
// This is a phase-1 gap fix: the body sanitizer schema strips <link>/<meta> which
// are the correct elements for the head.meta slot (theme-contract §8 / module-
// contract §3.5). This schema is intentionally narrow — only the two element types
// the head.meta slot needs, with only safe attributes.
//
// strip list hardening: elements NOT in tagNames are "unwrapped" by default
// (the element is removed but its text content survives). For <head>-destined
// output that is unacceptable — bare text nodes in <head> are invisible but
// pollute the DOM. Elements with meaningful text content are added to strip so
// their text is dropped along with the element. <script>/<style> are already
// in defaultSchema.strip; <title> and <noscript> are the other head elements
// likely to carry text from an injection attempt.
const HEAD_SCHEMA = {
  tagNames: ["link", "meta"] as string[],
  attributes: {
    link: ["rel", "type", "href", "title", "hreflang"] as string[],
    meta: ["name", "content", "property", "charset"] as string[],
  },
  protocols: { href: ["http", "https"] },
  strip: [...(defaultSchema.strip ?? []), "title", "noscript", "style"] as string[],
  clobber: [] as string[],
};

const headFragmentProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, HEAD_SCHEMA)
  .use(rehypeStringify);

/**
 * Convert content markdown to sanitized HTML. The ONLY way to produce the
 * `SanitizedHtml` a theme may render for a post/page body.
 */
export function renderMarkdown(markdown: string): SanitizedHtml {
  return String(markdownProcessor.processSync(markdown)) as SanitizedHtml;
}

/**
 * Sanitize an HTML fragment (e.g. a module's slot contribution). The ONLY way to
 * produce the `SanitizedHtml` a slot may carry into the render context (§8.2.4).
 */
export function sanitizeHtmlFragment(html: string): SanitizedHtml {
  return String(htmlFragmentProcessor.processSync(html)) as SanitizedHtml;
}

/**
 * Sanitize an HTML fragment intended for the document <head> (e.g. a module's
 * head.meta slot contribution — <link> / <meta> elements). Uses the narrow
 * HEAD_SCHEMA that allows only these two element types with safe attributes.
 * The ONLY way to produce SanitizedHtml for head.meta slot contributions.
 */
export function sanitizeHeadFragment(html: string): SanitizedHtml {
  return String(headFragmentProcessor.processSync(html)) as SanitizedHtml;
}

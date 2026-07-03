import { expect, test } from "bun:test";
import { serializeMarkdownFile } from "@/lib/export/frontmatter";
import {
  MAX_BODY_BYTES,
  MAX_FIELD_VALUE_BYTES,
  MAX_FRONTMATTER_BYTES,
  isFrontmatterParseError,
  parseMarkdownFile,
} from "../frontmatter";

test("parses a file written by the export serializer back into fields + body, byte-exact body", () => {
  const fields: Array<readonly [string, unknown]> = [
    ["title", "Hello World"],
    ["slug", "hello-world"],
    ["type", "article"],
    ["status", "published"],
    ["tags", [{ name: "Foo", slug: "foo" }]],
    ["publishDate", "2026-01-01T00:00:00.000Z"],
    ["createdAt", "2025-12-01T00:00:00.000Z"],
    ["updatedAt", "2025-12-02T00:00:00.000Z"],
    ["excerpt", "An excerpt."],
    ["coverImage", { src: "media/abc/800.jpg", alt: "cover" }],
    ["panoramic", false],
    ["showInBlog", true],
  ];
  const body = "# Hello\n\nSome body text with a colon: like this.\n";
  const text = serializeMarkdownFile(fields, body);

  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(false);
  if (isFrontmatterParseError(result)) throw new Error("unreachable");

  expect(result.fields.title).toBe("Hello World");
  expect(result.fields.slug).toBe("hello-world");
  expect(result.fields.type).toBe("article");
  expect(result.fields.status).toBe("published");
  expect(result.fields.tags).toEqual([{ name: "Foo", slug: "foo" }]);
  expect(result.fields.publishDate).toBe("2026-01-01T00:00:00.000Z");
  expect(result.fields.createdAt).toBe("2025-12-01T00:00:00.000Z");
  expect(result.fields.coverImage).toEqual({ src: "media/abc/800.jpg", alt: "cover" });
  expect(result.fields.panoramic).toBe(false);
  expect(result.fields.showInBlog).toBe(true);
  // Body round-trips byte-exact (the lossless-round-trip AC). The serializer
  // appends exactly one structural trailing newline on top of whatever the
  // body itself already ends with; the parser strips exactly that one back off.
  expect(result.body).toBe(body);
});

test("null and false values round-trip as null/false, not absent (lossless — field-present vs field-absent stays distinct)", () => {
  const text = serializeMarkdownFile(
    [
      ["coverImage", null],
      ["panoramic", false],
    ],
    "body",
  );
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(false);
  if (isFrontmatterParseError(result)) throw new Error("unreachable");
  expect(result.fields.coverImage).toBeNull();
  expect(result.fields.panoramic).toBe(false);
});

test("colons inside a JSON-quoted value are not treated as field delimiters", () => {
  const text = serializeMarkdownFile([["title", "Time: 10:30 AM"]], "body");
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(false);
  if (isFrontmatterParseError(result)) throw new Error("unreachable");
  expect(result.fields.title).toBe("Time: 10:30 AM");
});

test("lenient bulk-import fallback: an unquoted bare scalar becomes a plain string", () => {
  const text = "---\ntitle: Hello World\nslug: hello-world\n---\n\nbody\n";
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(false);
  if (isFrontmatterParseError(result)) throw new Error("unreachable");
  expect(result.fields.title).toBe("Hello World");
  expect(result.fields.slug).toBe("hello-world");
});

test("missing opening fence is a parse error, not a crash", () => {
  const result = parseMarkdownFile("# Just markdown, no frontmatter\n");
  expect(isFrontmatterParseError(result)).toBe(true);
  expect(isFrontmatterParseError(result) && result.error).toContain("opening frontmatter fence");
});

test("missing closing fence is a parse error", () => {
  const result = parseMarkdownFile("---\ntitle: \"Hi\"\n\nbody without a closing fence\n");
  expect(isFrontmatterParseError(result)).toBe(true);
  expect(isFrontmatterParseError(result) && result.error).toContain("closing frontmatter fence");
});

test("a frontmatter line with no colon at all is a parse error (malformed file)", () => {
  const result = parseMarkdownFile("---\ntitle: \"Hi\"\njust some text with no colon\n---\n\nbody\n");
  expect(isFrontmatterParseError(result)).toBe(true);
  expect(isFrontmatterParseError(result) && result.error).toContain("unparseable frontmatter line");
});

test("oversized frontmatter block is rejected (defense against hostile field bloat)", () => {
  const huge = "x".repeat(MAX_FRONTMATTER_BYTES + 100);
  const text = `---\ntitle: "${huge}"\n---\n\nbody\n`;
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(true);
});

test("a single field value exceeding the per-field cap is rejected even though the block itself is small", () => {
  const huge = JSON.stringify("x".repeat(MAX_FIELD_VALUE_BYTES + 100));
  const text = `---\ntitle: ${huge}\n---\n\nbody\n`;
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(true);
  expect(isFrontmatterParseError(result) && result.error).toContain("exceeds");
});

test("oversized body is rejected (defense against a decompression-bomb-shaped single file)", () => {
  // A single "x" repeated body just over the cap — cheap to construct, exercises
  // the same guard a truly hostile file would trip.
  const bigBody = "x".repeat(MAX_BODY_BYTES + 10);
  const text = `---\ntitle: "Hi"\n---\n\n${bigBody}\n`;
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(true);
  expect(isFrontmatterParseError(result) && result.error).toContain("body exceeds");
});

test("CRLF line endings are tolerated", () => {
  const text = '---\r\ntitle: "Hi"\r\n---\r\n\r\nbody\r\n';
  const result = parseMarkdownFile(text);
  expect(isFrontmatterParseError(result)).toBe(false);
  if (isFrontmatterParseError(result)) throw new Error("unreachable");
  expect(result.fields.title).toBe("Hi");
});

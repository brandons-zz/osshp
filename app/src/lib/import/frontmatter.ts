// Markdown + YAML-frontmatter parsing for content import (issue 002).
//
// THIS IS THE IMPORT SIDE OF THE EXPORT CONTRACT: it must parse, byte-for-byte,
// what lib/export/frontmatter.ts writes — see
// docs/decisions/0003-content-export-format.md. The export writer emits exactly
// one frontmatter field per line as `key: JSON.stringify(value)`; this parser
// mirrors that shape (single-line JSON-flow-scalar frontmatter), which is a
// deliberately narrow subset of real-world YAML. Multi-line block frontmatter
// (`tags:\n  - foo`) is out of scope — that class of file reports as malformed
// with a clear reason rather than being silently misparsed.
//
// Hardening (issue 002 — the sharpest new trust boundary this feature adds):
// this module is the first thing that touches bytes from an UNTRUSTED archive.
// Every size a caller does not explicitly bound is bounded here so one hostile
// or oversized file cannot exhaust memory or hang the batch.

/** Hard caps on a single source file — defense against oversized/malicious entries. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024; // 64 KB of frontmatter lines
export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB Markdown body
export const MAX_FIELD_VALUE_BYTES = 20 * 1024; // any single field's raw JSON text

export interface ParsedMarkdownFile {
  /** Raw parsed frontmatter values, keyed by field name, before schema validation. */
  fields: Record<string, unknown>;
  /** The Markdown body, exactly as written after the closing fence + blank line. */
  body: string;
}

export interface FrontmatterParseError {
  error: string;
}

function isParseError(v: unknown): v is FrontmatterParseError {
  return typeof v === "object" && v !== null && "error" in v;
}

export { isParseError as isFrontmatterParseError };

const OPEN_FENCE = "---\n";
const CLOSE_FENCE = "\n---\n";

/**
 * Parse one `key: <value>` frontmatter line into [key, rawValueText]. Splits on
 * the FIRST colon only (values are JSON-encoded on export, so colons inside a
 * quoted string, e.g. an ISO timestamp, must not be treated as delimiters).
 * Returns null for a line with no colon at all (not a field line).
 */
function splitFieldLine(line: string): [string, string] | null {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const rawValue = line.slice(idx + 1).trim();
  if (key === "") return null;
  return [key, rawValue];
}

/**
 * Decode one field's raw text into a value. JSON is a valid subset of YAML flow
 * scalars/collections, so any value written by serializeMarkdownFile
 * (JSON.stringify'd) round-trips exactly via JSON.parse. For lenient bulk
 * import of hand-authored Markdown (arbitrary blogs, not our own export), an
 * unquoted bare scalar (`title: Hello World`) falls back to a plain string.
 */
function decodeFieldValue(rawValue: string): unknown {
  if (rawValue === "") return "";
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

/**
 * Parse a full exported/hand-authored Markdown file's text into frontmatter
 * fields + body. Returns a FrontmatterParseError (never throws) for any
 * structural problem — missing fences, oversized content, or a field whose raw
 * text exceeds the per-field cap.
 */
export function parseMarkdownFile(
  text: string,
): ParsedMarkdownFile | FrontmatterParseError {
  const normalized = text.replace(/\r\n/g, "\n");

  if (!normalized.startsWith(OPEN_FENCE)) {
    return { error: "missing opening frontmatter fence (---)" };
  }
  const afterOpen = normalized.slice(OPEN_FENCE.length);
  const closeIdx = afterOpen.indexOf(CLOSE_FENCE);
  if (closeIdx === -1) {
    return { error: "missing closing frontmatter fence (---)" };
  }

  const fmBlock = afterOpen.slice(0, closeIdx);
  if (Buffer.byteLength(fmBlock, "utf8") > MAX_FRONTMATTER_BYTES) {
    return {
      error: `frontmatter block exceeds ${MAX_FRONTMATTER_BYTES} bytes`,
    };
  }

  let rest = afterOpen.slice(closeIdx + CLOSE_FENCE.length);
  // The serializer always inserts exactly one blank line between the closing
  // fence and the body; tolerate its absence for hand-authored files.
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const body = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return { error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  }

  const fields: Record<string, unknown> = {};
  for (const rawLine of fmBlock.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue; // tolerate stray blank lines inside the block
    const split = splitFieldLine(line);
    if (!split) {
      return { error: `unparseable frontmatter line: ${JSON.stringify(line)}` };
    }
    const [key, rawValue] = split;
    if (Buffer.byteLength(rawValue, "utf8") > MAX_FIELD_VALUE_BYTES) {
      return {
        error: `field "${key}" value exceeds ${MAX_FIELD_VALUE_BYTES} bytes`,
      };
    }
    fields[key] = decodeFieldValue(rawValue);
  }

  return { fields, body };
}

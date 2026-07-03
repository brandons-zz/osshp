// Frontmatter -> validated content payload (issue 002).
//
// Second half of the trust boundary: parseMarkdownFile (frontmatter.ts) turns
// raw bytes into structurally-sound {fields, body}; this module is what stands
// between those parsed-but-unvalidated field VALUES and the DB. Every field
// that determines identity, routing, or storage kind (slug, type, status,
// coverImage shape) is a hard requirement — a bad value here fails the whole
// item with a clear reason rather than being guessed at ("injection via
// frontmatter... into stored content" from the security brief means never
// trusting an enum/shape value without checking it against a whitelist).
// Supplementary, purely-cosmetic fields (excerpt, tags, createdAt/updatedAt,
// panoramic/showInBlog/showInNav) degrade gracefully to a safe default instead
// of failing the whole file — this is what lets the importer also serve as the
// general "bring your own Markdown" tool the issue asks for, not just a strict
// round-trip of our own export shape.

import { CONTENT_STATUSES, type ContentStatus, type ImageRef } from "@/lib/content/types";
import { isValidSlug, slugify } from "./slug";
import type { ValidationResult } from "./types";

export interface ClassifyHint {
  /** Structured-archive directory context; undefined for a loose single file. */
  directoryKind?: "posts" | "pages";
  /** Original filename (no directory prefix) — slug/title fallback source. */
  filename: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

/** Lenient: an unparseable/absent timestamp becomes null (falls back to now()
 *  at write time) rather than failing the item — see module doc. */
function parseIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return value; // preserve the original string verbatim (byte-exact round-trip)
}

function isValidStatus(value: unknown): value is ContentStatus {
  return typeof value === "string" && (CONTENT_STATUSES as readonly string[]).includes(value);
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const spaced = base.replace(/[-_]+/g, " ").trim();
  if (spaced === "") return "";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Derive a slug: prefer an explicit valid frontmatter slug, then the title, then the filename. */
function deriveSlug(rawSlug: unknown, title: string, filename: string): string | null {
  if (typeof rawSlug === "string" && isValidSlug(rawSlug)) return rawSlug;
  if (typeof rawSlug === "string" && rawSlug.trim() !== "") {
    const s = slugify(rawSlug);
    if (s !== "") return s;
  }
  const fromTitle = slugify(title);
  if (fromTitle !== "") return fromTitle;
  const fromFile = slugify(filename.replace(/\.md$/i, ""));
  return fromFile !== "" ? fromFile : null;
}

/** Normalize a tags value into {name,slug}[], tolerating plain-string entries
 *  (common in hand-authored frontmatter). Invalid individual entries are
 *  dropped, not fatal — tags are cosmetic metadata, not identity. */
function normalizeTags(value: unknown): Array<{ name: string; slug: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; slug: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = entry.trim();
      const slug = slugify(name);
      if (name !== "" && slug !== "") out.push({ name, slug });
      continue;
    }
    if (isRecord(entry)) {
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      let slug = typeof entry.slug === "string" && isValidSlug(entry.slug) ? entry.slug : "";
      if (slug === "" && name !== "") slug = slugify(name);
      if (name !== "" && slug !== "") out.push({ name, slug });
    }
  }
  return out;
}

/** Validate a raw coverImage field into ImageRef|null. Malformed shapes are a
 *  hard error — an object here becomes a stored URL, so its shape matters. */
function validateCoverImage(value: unknown): { ok: true; value: ImageRef | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!isRecord(value) || typeof value.src !== "string" || value.src.trim() === "") {
    return { ok: false };
  }
  const alt = typeof value.alt === "string" ? value.alt : "";
  return { ok: true, value: { src: value.src, alt } };
}

/**
 * Classify parsed frontmatter as a post or page and validate every field.
 * Returns a {kind:"error"} result (never throws) for any hard-requirement
 * failure — see module doc for the strict/lenient split.
 */
export function classifyAndValidate(
  fields: Record<string, unknown>,
  body: string,
  hint: ClassifyHint,
): ValidationResult {
  const rawType = fields.type;

  let targetKind: "post" | "page";
  if (hint.directoryKind === "pages") {
    if (rawType !== undefined && rawType !== "page") {
      return {
        kind: "error",
        reason: `pages/ entry has type=${JSON.stringify(rawType)}, expected "page"`,
      };
    }
    targetKind = "page";
  } else if (hint.directoryKind === "posts") {
    if (rawType !== undefined && rawType !== "article" && rawType !== "photo-post") {
      return {
        kind: "error",
        reason: `posts/ entry has invalid type ${JSON.stringify(rawType)} (expected "article" or "photo-post")`,
      };
    }
    targetKind = "post";
  } else if (rawType === "page") {
    targetKind = "page";
  } else if (rawType === "article" || rawType === "photo-post" || rawType === undefined) {
    targetKind = "post";
  } else {
    return {
      kind: "error",
      reason: `unrecognized "type" field: ${JSON.stringify(rawType)}`,
    };
  }

  const rawTitle = fields.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim() !== ""
      ? rawTitle
      : titleFromFilename(hint.filename);
  if (title === "") {
    return { kind: "error", reason: "missing title and could not derive one from the filename" };
  }

  const slug = deriveSlug(fields.slug, title, hint.filename);
  if (slug === null) {
    return { kind: "error", reason: "missing slug and could not derive one from the title/filename" };
  }

  const rawStatus = fields.status;
  if (rawStatus !== undefined && !isValidStatus(rawStatus)) {
    return {
      kind: "error",
      reason: `invalid "status" field: ${JSON.stringify(rawStatus)} (expected one of ${CONTENT_STATUSES.join(", ")})`,
    };
  }
  const status: ContentStatus = rawStatus === undefined ? "draft" : rawStatus;

  const createdAt = parseIsoOrNull(fields.createdAt);
  const updatedAt = parseIsoOrNull(fields.updatedAt);

  if (targetKind === "page") {
    return {
      kind: "page",
      title,
      slug,
      status,
      showInNav: coerceBoolean(fields.showInNav, false),
      createdAt,
      updatedAt,
      body,
    };
  }

  const type: "article" | "photo-post" = rawType === "photo-post" ? "photo-post" : "article";
  const coverImageResult = validateCoverImage(fields.coverImage);
  if (!coverImageResult.ok) {
    return {
      kind: "error",
      reason: `invalid "coverImage" field: expected {src, alt} or null, got ${JSON.stringify(fields.coverImage)}`,
    };
  }
  const publishDate = parseIsoOrNull(fields.publishDate);
  const excerpt = typeof fields.excerpt === "string" ? fields.excerpt : "";

  return {
    kind: "post",
    title,
    slug,
    type,
    status,
    tags: normalizeTags(fields.tags),
    publishDate,
    createdAt,
    updatedAt,
    excerpt,
    coverImage: coverImageResult.value,
    panoramic: coerceBoolean(fields.panoramic, false),
    showInBlog: coerceBoolean(fields.showInBlog, false),
    featured: coerceBoolean(fields.featured, false),
    body,
  };
}

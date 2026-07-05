// Slug helpers shared by the import pipeline (issue 002).
//
// Used for two distinct purposes:
//  1. Deriving a slug when a source file has none (bulk arbitrary-Markdown
//     import — filenames or plain-string tag lists rarely carry a pre-slugified
//     form).
//  2. Disambiguating a collision in "create new" mode without ever silently
//     dropping or clobbering an existing entry (issue 002 AC).

/** A conservative, URL-safe slug shape: lowercase, digits, single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True if `value` already matches the supported slug shape. */
export function isValidSlug(value: string): boolean {
  return typeof value === "string" && SLUG_RE.test(value);
}

// Combining diacritical marks (U+0300-U+036F) — stripped after NFKD
// normalization so accented input slugifies to its base letters (e.g. "café" ->
// "cafe") instead of being dropped by the alnum filter below.
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/**
 * Best-effort slugify: lowercase, strip anything that is not alnum/space/hyphen,
 * collapse runs of separators to a single hyphen, trim leading/trailing hyphens.
 * Never throws; an all-symbol input slugifies to "" (callers must treat that as
 * "could not derive a slug").
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Append `-2`, `-3`, ... to `base` until `taken` no longer contains the
 * candidate. `taken` is checked case-sensitively — callers pass the exact slug
 * set already in use (DB slugs are compared as-is).
 */
export function nextAvailableSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

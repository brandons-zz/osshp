// Shared slugify — the single definition of "how a title/name becomes a URL
// slug" across the app. Previously duplicated inline in PostEditor.tsx (post
// slugs) and about to be needed again for tag names (typeahead preview, admin
// rename); extracted once so both stay byte-identical instead of drifting.
//
// Pure, no server-only imports — safe to import from client components.

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

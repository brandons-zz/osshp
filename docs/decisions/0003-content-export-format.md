# ADR 0003 — Content export format (the export ↔ import contract)

**Status:** Accepted · **Date:** 2026-07-02
**Milestone:** M4 W1 (issue 001) · **Consumed by:** the forthcoming import service (issue 002)

## Context

Issue 001 requires an operator-triggered export of all content as Markdown, so nothing is
trapped in the app (lock-in prevention + backup). Issue 002 (import, not yet built) must be able
to read that export back losslessly — the same frontmatter schema and archive layout is the
contract between the two. This ADR is written now, at export time, so import is built against a
frozen shape rather than reverse-engineering one later.

## Decision

### Archive layout

A `.tar.gz` archive (admin console download) or an equivalent plain directory (CLI output — no
compression, same relative paths) with this layout:

```
posts/<slug>.md      — one file per post (article or photo-post), every status
pages/<slug>.md      — one file per page, every status
media/<key...>       — every media object referenced by any exported post/page body
                        or coverImage, at its original storage key path (e.g.
                        media/3f9c1a2b-.../800.jpg)
manifest.json         — { exportedAt, postCount, pageCount, mediaCount, mediaErrors }
```

`mediaErrors` in `manifest.json` lists any storage key that was referenced by content but could
not be retrieved from object storage at export time (a stale/broken reference) — this makes a
partial archive detectable rather than silently incomplete.

### Scope: all content states, no settings/secrets

**All content statuses are included** — draft, published, and scheduled — not just what the
public theme renders. This is an admin-triggered, authenticated backup of the operator's own
content, not a public read, so the theme's published-only boundary (theme-rendering-contract
§3.3) does not apply here. `status` is itself an exported frontmatter field so nothing is lost.

**Settings, `admin_user`, and all secrets are out of scope by omission** — the export walks only
`posts` and `pages` (plus the media they reference). There is no code path from the export to the
settings/admin-user stores, so there is nothing to leak by omission (not a blocklist that could
drift).

### Frontmatter schema

A YAML-frontmatter-fenced Markdown file (`---` ... `---`, blank line, body), matching the common
"front matter" convention. Every value is written as `key: <JSON.stringify(value)>` — this is
deliberate: JSON is a valid subset of YAML flow scalars/collections (quoted strings, numbers,
booleans, `null`, `[...]`, `{...}`), so the output is real, standard-parseable YAML with **no
osshp-specific parsing required** on the import side, while still being trivially hand-rolled on
the export side (no new dependency — matches the existing hand-assembled-serializer convention,
e.g. `lib/content/feed.ts`'s RSS XML).

Every field is always present, even when `null`/`false` — this keeps "field is null" distinct
from "field is absent" and keeps the shape predictable for import.

**Posts** (`posts/<slug>.md`) — field order is fixed for diff-stable exports:

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | |
| `slug` | string | also the filename (`<slug>.md`) |
| `type` | `"article" \| "photo-post"` | |
| `status` | `"draft" \| "published" \| "scheduled"` | |
| `tags` | `{name, slug}[]` | matches `NewPost.tags` / `PostUpdate.tags` exactly — import can pass this straight through |
| `publishDate` | ISO 8601 string or `null` | |
| `createdAt` | ISO 8601 string | |
| `updatedAt` | ISO 8601 string | |
| `excerpt` | string | |
| `coverImage` | `{src, alt}` or `null` | `src` is an **archive-relative** path (see below), not the live `/media/<key>` URL |
| `panoramic` | boolean | |
| `showInBlog` | boolean | photo-posts only; ignored for articles |
| `featured` | boolean | issue 012 — eligible for the home "Selected" showcase; applies to both post types |

Body: the post's Markdown source, verbatim, except for the media-link rewrite below.

**Pages** (`pages/<slug>.md`):

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | |
| `slug` | string | also the filename |
| `type` | `"page"` | synthetic — pages have no `type` column; this disambiguates a lone exported file from a post if it's ever moved out of the `pages/` directory |
| `status` | `"draft" \| "published" \| "scheduled"` | |
| `showInNav` | boolean | |
| `createdAt` | ISO 8601 string | |
| `updatedAt` | ISO 8601 string | |

Body: the page's Markdown source, verbatim, except for the media-link rewrite below.

### Media handling: copy into the archive, links rewritten

**Decision: copy, not reference** (per the M4 plan's D-EXPORT-MEDIA recommendation) — the export
archive must be usable on its own, with no dependency on the source instance being reachable.

- Any `/media/<key>` reference found in a post/page body, or in `coverImage.src`, is:
  1. Rewritten to the **archive-relative** path `media/<key>` (the leading `/media/` prefix is
     dropped; the rest of the key — e.g. `<uuid>/800.jpg` — is preserved unchanged).
  2. The referenced object is read back from object storage and written into the archive at
     exactly that same `media/<key>` path.
- Media keys are deduplicated across all exported content before being fetched (one copy per
  distinct key, however many posts/pages reference it).
- `media/<key>` paths are **archive-root-relative**, not relative to the referencing file's own
  directory (i.e. always `media/...`, never `../media/...`) — both `posts/*.md` and `pages/*.md`
  use the same root-relative form, so the rewrite rule is uniform regardless of which directory
  the reference lives in.

## Consequences

- Import (issue 002) can parse each `.md` file's frontmatter with any standard YAML library,
  reconstruct `tags`/`coverImage` as plain objects with zero osshp-specific decoding, and copy
  `media/<key>` files back into object storage at the same key before rewriting the body's
  `media/<key>` references back to `/media/<key>` — the inverse of the export rewrite.
- Because `tags` already matches `NewPost.tags`'s shape, import's create path can pass the parsed
  frontmatter almost directly to `createPost`/`createPage` (import is issue 002's job — this ADR
  only fixes the contract, it does not build the consumer).
- A future format change to this schema is a breaking change for both export and import and must
  update this ADR in the same commit.

## Alternatives considered

- **Emit resolvable references instead of copying media.** Rejected — issue 001's AC requires the
  export folder to be "usable on its own"; references would make it depend on the source instance
  staying reachable, defeating the backup/lock-in purpose.
- **A real YAML library dependency.** Rejected for the same reason `lib/content/feed.ts` hand-
  assembles RSS XML instead of pulling in an XML library — the emitted shape is small, fixed, and
  the JSON-subset trick makes correctness trivial to reason about without adding a dependency.

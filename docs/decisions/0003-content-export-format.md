# ADR 0003 — Content export format (the export ↔ import contract)

**Status:** Accepted · **Date:** 2026-07-02 · **Amended:** 2026-07-04 (issue 050 — gallery membership); 2026-07-05 (issue 077 — media attribution)
**Milestone:** M4 W1 (issue 001) · **Consumed by:** the import service (issue 002)

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
manifest.json         — { exportedAt, postCount, pageCount, mediaCount, mediaErrors,
                          mediaAttribution? } — see "Media attribution" below
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
| `isGallery` | boolean | issue 050/047 — photo-posts only; true ⇒ `gallery` below is this post's ordered album |
| `gallery` | `{src, alt, caption}[]` | issue 050/047 — every field always present (`[]` for a non-gallery post); see "Gallery membership" below |
| `galleryCover` | archive-relative media key (`media/<key>`) or `null` | issue 050/047 — the gallery's explicitly-chosen cover, or `null` when no explicit choice was made (defaults to the first `gallery[]` entry — see below) |

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

### Gallery membership (issue 050/047 amendment)

The 047 gallery model stores an ordered set of images per post in a `post_media` join
(`post_id, media_id, position, caption`), plus `is_gallery`/`cover_media_id` columns on the post —
none of which was covered by this ADR when first written, so a gallery post's images/order/
captions/cover were silently lost on export→import (issue 050). Three new post frontmatter fields
close that gap, following the same "copy, not reference" and "no raw DB ids" principles already in
this ADR:

- **`gallery`** is the ordered set of `{src, alt, caption}` objects (array order = `post_media`
  `position`). `src` is an **archive-relative** media key in the exact same `media/<key>` form as
  `coverImage.src` — each gallery image is a real media reference and goes through the same
  "rewrite the link, copy the bytes into `media/<key>`" treatment as `coverImage`/body references
  above, so a gallery's images are guaranteed to be present in the archive. `alt` and `caption` are
  the gallery entry's own values (alt is canonical on the media row; caption is per-post). Width/
  height are intentionally **not** carried here — they live on the `media` row, not `post_media`,
  and media dimensions round-tripping is outside this ADR's scope (media rows created by import
  never had width/height populated even before this amendment — see ADR 0004).
- **`galleryCover`** is the archive-relative media key (`media/<key>`) of the gallery's
  *explicitly*-chosen cover (`post.coverMediaId`), or `null` when no explicit choice was made. A
  raw `cover_media_id` (a DB id) is **not exported directly** — a DB id from the source instance is
  meaningless on the target instance. The archive-relative media key is the portable identifier:
  because gallery images are copied into the archive at a stable key and re-ingested at that same
  key on import (this ADR's existing media-copy guarantee), the key survives the trip even though
  every `mediaId` on both sides is fresh. `null` round-trips as `null` — the store's own "default
  to the first gallery image when `cover_media_id` is null" behavior does the rest, so an unpinned
  cover stays unpinned after import.
- **`isGallery`** is exported as a plain boolean, exactly like the other feature flags in this
  table.

Non-gallery posts (articles, and photo-posts that use the existing single `coverImage` flow) always
emit `isGallery: false` and `gallery: []` — per this ADR's "every field always present" rule — so
they are unaffected by this amendment and continue to round-trip exactly as before.

### Media attribution (issue 077 amendment)

Issue 077 (auto-import of external inline images) added three optional columns to the `media`
table — `source_url`, `attribution`, `license` — recorded when an image is fetched from an
external host and stored locally. This is a MEDIA-row property, not a post/page field, so unlike
the gallery amendment above it does **not** live in post/page frontmatter — it is collected once
per distinct referenced media key and added to `manifest.json`:

- **`mediaAttribution`** (optional): `Record<archive-relative media key, {sourceUrl, attribution,
  license}>` — present ONLY when at least one exported media object has any of the three fields
  set (an ordinary upload with none of them set does not appear here at all, keeping the manifest
  free of noise for the common case). Values may be `null` for any field that wasn't recorded.
- This is the one place `manifest.json` carries data the import service actually consumes —
  every other manifest field (`postCount`, `mediaErrors`, etc.) remains purely informational (see
  ADR 0004's "Media: ingest first…" section for how it's applied).
- **The rendered, human-visible credit does NOT depend on this field at all.** The figcaption a
  visitor sees is derived purely from the Markdown image's title text (`![alt](url "credit")`),
  which already round-trips through the ordinary body-text path (verbatim, except for the `/media/
  <key>` link rewrite this ADR already specifies) with zero extra mechanism. `mediaAttribution` in
  the manifest exists so the underlying `media` row's bookkeeping fields (used for future
  media-library display / audit, not rendering) survive a re-import too.
- Absent on any archive exported before this amendment — the field is optional and its absence
  changes nothing (see ADR 0004's leniency rules, same backward-compatibility shape as the
  gallery amendment above).

## Consequences

- Import (issue 002) can parse each `.md` file's frontmatter with any standard YAML library,
  reconstruct `tags`/`coverImage` as plain objects with zero osshp-specific decoding, and copy
  `media/<key>` files back into object storage at the same key before rewriting the body's
  `media/<key>` references back to `/media/<key>` — the inverse of the export rewrite.
- Because `tags` already matches `NewPost.tags`'s shape, import's create path can pass the parsed
  frontmatter almost directly to `createPost`/`createPage` (import is issue 002's job — this ADR
  only fixes the contract, it does not build the consumer).
- **Backward compatibility (issue 050):** `isGallery`/`gallery`/`galleryCover` are additions at the
  end of the posts table, not a restructuring — an archive produced before this amendment simply
  has those three keys absent. Import treats absence exactly like `isGallery: false`,
  `gallery: []`, `galleryCover: null` (see ADR 0004's leniency rules), so every archive exported
  before issue 050 still imports cleanly with no gallery data fabricated.
- A future format change to this schema is a breaking change for both export and import and must
  update this ADR in the same commit.

## Alternatives considered

- **Emit resolvable references instead of copying media.** Rejected — issue 001's AC requires the
  export folder to be "usable on its own"; references would make it depend on the source instance
  staying reachable, defeating the backup/lock-in purpose.
- **A real YAML library dependency.** Rejected for the same reason `lib/content/feed.ts` hand-
  assembles RSS XML instead of pulling in an XML library — the emitted shape is small, fixed, and
  the JSON-subset trick makes correctness trivial to reason about without adding a dependency.

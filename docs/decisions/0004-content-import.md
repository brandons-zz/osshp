# ADR 0004 — Content import: modes, validation, and archive-extraction hardening

**Status:** Accepted · **Date:** 2026-07-02 · **Amended:** 2026-07-04 (issue 050 — gallery membership); 2026-07-05 (issue 077 — media attribution)
**Milestone:** M4 W1 (issue 002) · **Consumes:** the export format frozen by
[ADR 0003](0003-content-export-format.md)

## Context

Issue 001 (export) and this ADR's ADR 0003 froze a Markdown + YAML-frontmatter
archive shape so operators are never locked in and can back up their content.
Issue 002 is the other half: an operator-triggered **import** that reads that
same shape back in — for a genuine backup/restore round-trip, for moving
between osshp instances, and as the general "bring your own Markdown" tool for
operators arriving with content from elsewhere (a blog export, a folder of
notes, the migrated Steili.com docs).

Import is a materially different trust boundary from export. Export reads
data this instance already trusts (its own DB) and writes it out. Import reads
**bytes an authenticated admin uploads, that may have originated anywhere** —
a prior export of this same instance, a download from a third party, or an
archive assembled by hand — and turns them into DB rows and object-storage
writes. That is the sharpest new trust boundary this feature adds, and it
shapes every decision below.

## Decisions

### Re-import behavior is chosen by the importer, at import time

Issue 002's AC is explicit: the choice between skip / overwrite / create is
**not a fixed policy** — it is selected per import, in both the admin UI (a
`<select>` on the import form) and the CLI (`--mode=` flag), defaulting to
`skip` (the safest option: never clobbers, never silently duplicates).

- **`skip`** — an existing slug (posts and pages are matched independently,
  each against their own store) is left untouched; the item is reported
  `skipped` with a reason.
- **`overwrite`** — an existing slug's fields are replaced in place, including
  restoring the source's original `createdAt`/`updatedAt` (see below) for a
  lossless round-trip; an absent slug is created instead.
- **`create`** — always creates a new row. A colliding slug is disambiguated
  (`slug-2`, `slug-3`, …) by probing the store for the next free candidate —
  never a silent duplicate slug and never a clobber of the existing row.

All three modes are exercised by dedicated tests in
`src/lib/import/__tests__/importer.test.ts`.

### `createdAt`/`updatedAt` become optional, caller-supplied overrides on the store

Losslessness is an explicit AC ("round-trips losslessly with the issue-001
export format"), and the export format includes `createdAt`/`updatedAt` as
frontmatter fields. Those columns were previously DB-defaulted (`now()`) with
no write path at all. `NewPost`/`PostUpdate`/`NewPage`/`PageUpdate` gained
optional `createdAt`/`updatedAt` fields; `createPost`/`createPage` `COALESCE`
them against `now()` when absent, and `updatePost`/`updatePage` only stamp
`updated_at = now()` when the caller did not supply an explicit value. Every
existing caller omits these fields and is completely unaffected — this is a
backward-compatible extension of the content store, not a new import-specific
write path, so the single lossless behavior is exercised the same way whether
a post is freshly created or overwritten by a re-import.

### Frontmatter parsing is the narrow, single-line JSON-flow-scalar shape ADR 0003 defines — with a lenient fallback for hand-authored content

`lib/import/frontmatter.ts` is the literal inverse of `lib/export/frontmatter.ts`:
one `key: JSON.stringify(value)` per line. This is what makes the round-trip
losslessness provable — parsing is byte-exact for anything our own exporter
produced. Multi-line block YAML (`tags:\n  - foo`) is explicitly out of scope;
a file shaped that way fails with a clear per-line parse error rather than
being silently misread.

Within that shape, a bare unquoted scalar (`title: Hello World`, common in
hand-authored frontmatter that isn't JSON-quoted) falls back to a plain
string instead of a hard parse failure — this is what lets the same importer
serve as the general bring-your-own-Markdown tool the issue also asks for
("generalize [the docs-migration tool] into a real import feature"), not only
a strict reader of our own export.

### Validation: hard requirements vs. lenient defaults

`lib/import/schema.ts` splits every frontmatter field into two classes:

- **Identity/routing/shape fields — hard requirement, whitelisted, fails the
  item on any bad value.** `type`, `status`, and `coverImage`'s shape are
  checked against closed enums/shapes; an unrecognized value is a validation
  error with a specific reason, never guessed at or coerced into "something
  plausible." This is the direct defense against "injection via
  frontmatter/body into stored content" — a value that will become a routing
  decision, a CHECK-constrained column, or a stored URL is never trusted
  without being checked against a whitelist first.
- **Supplementary/cosmetic fields — lenient, safe-default on any bad value.**
  `tags` (including a plain-string-array shape), `excerpt`,
  `createdAt`/`updatedAt`, and the boolean flags (`panoramic`, `showInBlog`,
  `featured`, `showInNav`, with `"true"`/`"false"` string coercion) degrade to a sane
  default rather than failing the whole item. These fields carry no identity
  or routing weight — dropping a bad tag or falling back to `now()` for an
  unparseable timestamp is strictly better than rejecting an otherwise-good
  file over metadata.

`slug` sits in between: an explicit valid slug is used as-is; an invalid or
absent one is derived (from the title, then the filename) via `slugify()`
rather than failing outright — bulk import of arbitrary Markdown very often
has no `slug:` frontmatter field at all (the filename **is** the slug by
convention in most static-site generators).

### Archive-extraction hardening (the sharpest new trust boundary)

`lib/import/tar-reader.ts` is a from-scratch USTAR reader (the inverse of the
export module's hand-rolled writer) built specifically to defend against the
security review's callouts:

- **Path traversal / zip-slip.** Every entry path is validated
  (`isSafeArchivePath`) before it is used as a map key: no `..` segments, no
  leading `/`, no Windows drive-letter absolute paths, no NUL bytes. Critically,
  **import never extracts a tar entry to the local filesystem at all** — parsed
  entries land in an in-memory `Map`, and posts/pages/media reach durable
  storage only through the existing typed `createPost`/`createPage`/`MediaStorage.put`
  APIs. This eliminates the classic "write a file outside the intended
  directory" zip-slip outcome by construction, not just by path-checking.
- **Oversized/malicious entries.** Three independent caps: a per-entry byte
  cap (`MAX_ENTRY_BYTES`, checked against the *declared* header size before
  any data is sliced — a forged size claim is rejected before it can cause an
  out-of-bounds read), a whole-archive entry-count cap (`MAX_TAR_ENTRIES`),
  and a whole-archive byte cap (`MAX_TOTAL_BYTES`) enforced both post-gunzip
  and while accumulating entries. The admin route additionally caps the raw
  upload itself (`MAX_UPLOAD_BYTES`, 500 MB) before any of the finer-grained
  parsing caps even run.
- **Non-regular-file entries.** Only regular-file typeflags are accepted as
  data-bearing entries; directory entries are a no-op; every other typeflag —
  symlinks, hardlinks, devices, GNU longname/pax extension headers — is
  rejected as an unsupported entry with a clear reason. A symlink entry's
  "data" is an attacker-controlled path string, not file content; treating it
  as an ordinary regular file is the classic tar-format attack this guards
  against. (Our own writer never emits any of these — the reader only needs
  to be defensive, not compatible with every GNU tar feature.)
- **Media storage keys** derived from validated archive paths are re-checked
  (defense in depth) against the same path-safety predicate and a length cap
  before they ever become an S3-compatible object key.

Every hardening rule above has a dedicated adversarial unit test in
`src/lib/import/__tests__/tar-reader.test.ts` (hand-crafted traversal path,
forged oversized-entry header, symlink-typeflag entry, truncated/corrupt
archive) plus an integration test proving the batch is not aborted by one bad
entry (`src/lib/import/__tests__/importer.test.ts`).

### Media: ingest first, rewrite links to resolve, record what's missing

Media ingestion happens before any post/page is written, mirroring the
export's "copy, not reference" decision (ADR 0003) in reverse: every
`media/<key>` file the source provides is copied into object storage at that
same key (idempotent — a byte-identical re-import is a no-op write), and a
`media` row is ensured for it. Any `media/<key>` reference found in a body or
`coverImage.src` that the source did **not** include bytes for is recorded in
`ImportReport.mediaErrors` (mirroring the export manifest's `mediaErrors`
shape) rather than silently left broken or failing the whole item — the link
is still rewritten to the public `/media/<key>` form on the assumption the
target instance may already have that object.

**Attribution restore (issue 077 amendment):** `manifest.json`'s optional `mediaAttribution` map
(ADR 0003) is parsed defensively when present (`source.ts`) — a missing file, unparseable JSON, or
a value that isn't the expected shape simply yields fewer or zero entries, never a thrown error,
since restoring attribution is always best-effort and must never block or fail an import. Applied
in the SAME `ingestMedia()` pass that copies bytes and creates/confirms each row: a freshly-created
media row gets the attribution fields set at creation; a row that already existed (e.g. an
`overwrite`-mode re-import of an archive already ingested once) gets them patched via
`updateMediaAttribution()`. This is the ONLY manifest field the import service actually reads —
every other manifest field remains purely informational, matching `manifest.json`'s original
"informational only, not imported" framing except for this one narrow, explicitly-typed exception.

### Gallery membership: resolved after media ingestion, per-entry lenient (issue 050/047 amendment)

ADR 0003 added `isGallery`/`gallery`/`galleryCover` frontmatter fields so a gallery's images,
order, captions, and explicit cover choice actually reach the archive. This ADR's counterpart is
how import turns those parsed-but-unresolved fields into real `post_media` rows:

- **`schema.ts` (pure, no DB access) only normalizes shape** — `gallery` becomes an ordered
  `{key, alt, caption}[]` (the `media/` prefix stripped from each entry's `src`, mirroring how
  `coverImage.src` is later rewritten), and `galleryCover` becomes a bare key or `null`. A
  malformed individual gallery entry (not an object, or no resolvable `src`) is **dropped, not
  fatal** — the same per-item leniency as `tags`, and for the same reason: one bad photo entry in
  an otherwise-good gallery shouldn't sink the whole post. This differs deliberately from
  `coverImage`, which is a *single* field and fails the whole item on a bad shape — gallery is a
  *collection*, where per-item leniency is the more useful behavior.
- **`importer.ts` resolves keys to live media ids after `ingestMedia()` has run** — a gallery entry
  or cover key is looked up via `getMediaByKey()` only once every provided media file has already
  been copied into storage and given a `media` row. A key that never resolves (the source archive
  didn't include that file, or the file failed to ingest) is **skipped, not fatal**, and its key is
  added to `ImportReport.mediaErrors` — mirroring exactly how a broken `body`/`coverImage.src`
  reference is already handled, just applied to gallery entries too. Array order is preserved for
  every entry that *does* resolve, so a partially-resolvable gallery still lands in the right
  relative order.
- **The cover falls back to "first gallery image" exactly like the store already does** — when
  `galleryCoverKey` is `null`, or names a key that never resolves, import passes `coverMediaId:
  null` straight through to `createPost`/`updatePost`. `Post.coverImage()`'s existing "no explicit
  cover_media_id ⇒ use the first gallery image" default (defined before this issue, in the 047
  gallery model) does the rest — import does not need to duplicate that logic.
- **`isGallery`/`gallery`/`coverMediaId` are threaded through `createPost`/`updatePost` on every
  mode.** In `overwrite` mode this means gallery membership on an existing post is now genuinely
  replaced by the archive's contents (including being cleared if the archive says
  `isGallery: false`) — this is the fix for issue 050 itself: before this amendment, re-importing a
  gallery post left its `post_media` rows completely untouched because import had no code path that
  even looked at them.
- **The publish-time gallery alt gate applies on import too (issue 066).** The photos routes
  enforce "publishing a missing-alt gallery is impossible from ANY admin route" (issue 051,
  WCAG 1.1.1) — and `POST /api/admin/import` is an admin route, so the importer runs the SAME pure
  check (`galleryPublishAltError`, imported from the routes' shared `_gallery.ts` module so the
  invariant has exactly one definition that cannot drift between writers). The archive's per-entry
  `alt` is the effective alt here — import always writes it through to the media row, so unlike
  the PATCH route there is no stored-alt fallback to consult. On a violation (a
  `published`/`scheduled` gallery with any empty effective alt, or a gallery with ZERO images —
  none resolvable, or hand-authored empty) the post is **imported as `draft`, never failed and
  never published**: content is preserved, nothing missing-alt becomes publicly visible, and the
  per-item report entry says the post was demoted and names the alt-less images by their archive
  media key. A gallery imports as published only with ≥1 resolved image AND complete effective
  alts. Draft galleries are alt-exempt (import unchanged), and a published gallery with complete
  alts imports as published with no demotion note.
- **The gallery-size ceiling applies on import too (issue 066).** The admin photos routes reject
  galleries over `MAX_GALLERY_SIZE` (100) outright; import must not be able to construct what the
  route layer forbids. Resolved gallery membership is capped at the same constant (imported from
  the same shared module) — excess entries are dropped order-preservingly, and the per-item
  report entry says how many were dropped. The publish/alt gate is then judged on the capped set
  (what is actually written).
- **Media dimensions (`width`/`height`) are out of scope**, unchanged from the original ADR: they
  live on the `media` row, are not part of `GalleryInput`, and `ingestMedia()` has never populated
  them for any imported media (gallery or otherwise) — not a regression introduced by this
  amendment.

### Backward compatibility: archives with no gallery fields import unchanged (issue 050)

An archive exported before this amendment (or any hand-authored Markdown file) simply has no
`isGallery`/`gallery`/`galleryCover` keys. `schema.ts`'s normal "absent → safe default" handling
covers this with no special-casing: `isGallery` defaults `false`, `gallery` defaults `[]`,
`galleryCoverKey` defaults `null`. A resolved empty gallery and a `null` cover id are then passed
through unchanged, so `createPost`/`updatePost` behave exactly as they did before issue 050 for
every non-gallery post. This is exercised by a dedicated regression test
(`src/lib/import/__tests__/importer.test.ts` and `schema.test.ts`) that imports a frontmatter
object with the three keys entirely absent and asserts the resulting post is a normal,
non-gallery post.

### Two entry points share one orchestrator, three source builders

Same "one source of truth, two renderings" shape the export module uses:
`importSource()` (`lib/import/importer.ts`) is the single orchestrator,
consumed by both `POST /api/admin/import` (admin console, multipart upload)
and `scripts/import-content.ts` (CLI, self-contained binary via
`bun build --compile`, same pattern as `export-content`/`admin-break-glass`).
Three builders in `lib/import/source.ts` normalize the different entry points
into one `ImportSource` shape before orchestration:

- `sourceFromSingleMarkdown` — one uploaded/loose `.md` file.
- `sourceFromTar` — an uploaded or CLI-local `.tar`/`.tar.gz` archive
  (auto-detected by gzip magic bytes).
- `sourceFromDirectory` — a CLI-local directory matching the export shape
  (the "bulk import of a folder" AC — server-local access only; the admin
  console cannot practically accept a folder upload). Symlinks encountered
  while walking are skipped, not followed, so a symlink planted in the source
  directory cannot be used to read a file outside it.

## Consequences

- The Phase 1 Steili.com docs-migration tool (mentioned in the issue as a
  special case to fold in rather than build as a throwaway) is a `.md`-file or
  directory source for this same pipeline — no separate migration tool is
  needed going forward; it becomes "point `import-content` at the docs
  folder."
- A future format change to the export shape (ADR 0003) is a breaking change
  for both export and this import module and must update both ADRs in the
  same commit.
- Only regular-file tar entries are supported. An archive built by a tool that
  relies on GNU longname/pax extension headers for very long paths will have
  those specific entries reported as unsupported rather than imported — our
  own writer never needs them (USTAR's 255-byte path limit is enough for this
  archive's shape), so this is a deliberate scope boundary, not an oversight.

## Alternatives considered

- **A real YAML library dependency for parsing.** Rejected for the same
  reason ADR 0003 rejected it for writing — the shape is small, fixed, and the
  hand-rolled parser makes the security-relevant caps (frontmatter/body/field
  size limits) trivial to place exactly where they're needed, rather than
  trusting a general-purpose parser's own resource limits.
- **Extracting archives to a temp directory on disk before processing.**
  Rejected — every entry would then need the same path-safety check PLUS the
  temp-directory write itself becomes a second traversal surface to defend.
  Parsing directly into memory and only ever writing through typed
  `createPost`/`createMedia`/`storage.put` APIs removes that surface entirely.
- **A single "resolve" strategy instead of three selectable modes.** Rejected
  per the issue's explicit AC — re-import behavior is chosen by the importer,
  not decided for them.

# ADR 0004 — Content import: modes, validation, and archive-extraction hardening

**Status:** Accepted · **Date:** 2026-07-02
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

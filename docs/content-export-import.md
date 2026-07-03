# osshp — Content Export / Import

**Audience:** operators moving content in or out of an osshp instance —
lock-in prevention, migrating between instances, or bulk-importing existing
Markdown content.

This is the **content-portability** feature: exporting/importing individual
posts and pages as Markdown. It is distinct from `docs/backup-restore.md`,
which is a full-instance operational backup (database + media + secrets).
Use export/import when you want your content to leave (or a folder of
Markdown to arrive) in a plain, no-lock-in format; use backup/restore to
protect the whole running instance. The export admin page states this
distinction directly.

**Format reference:** the frontmatter schema and archive layout below are
frozen by [ADR 0003](decisions/0003-content-export-format.md) (export) and
[ADR 0004](decisions/0004-content-import.md) (import) — those two documents
are the authoritative contract if this guide and the code ever disagree;
this guide is the operator-facing how-to.

---

## Export

### What gets exported

**Every post and page, in every status** (draft, published, and scheduled) —
not just what's publicly visible. This is an authenticated admin action over
your own content, not a public read, so nothing is filtered by publish
state. Every referenced image (post/page body images and cover images) is
copied into the archive too, so the result is **self-contained** — it does
not depend on the source instance staying online to be useful.

**Not included:** site settings, the admin account, or any secrets. For that,
use a full-instance backup (`docs/backup-restore.md`) instead.

### Admin console

**Admin → Export / Backup** (`/admin/export`) → "Download export archive
(.tar.gz)". This streams a single `.tar.gz` download built from
`GET /api/admin/export`.

### CLI (headless / scripted)

```sh
docker compose exec app ./export-content [output-dir]
# or, if you have bun on the host and app/ dependencies installed:
bun run export:content -- [output-dir]
```

`output-dir` defaults to `./export-<UTC-timestamp>` inside the container's
working directory. Unlike the admin download, the CLI writes a **plain
directory** (no compression) with the same internal layout — convenient for
piping into another tool or a cron job without unpacking a `.tar.gz` first.

### Archive layout

```
posts/<slug>.md      — one file per post (article or photo-post), every status
pages/<slug>.md      — one file per page, every status
media/<key...>       — every media object referenced by any exported post/page
                        body or coverImage, at its original storage key path
                        (e.g. media/3f9c1a2b-.../800.jpg)
manifest.json         — { exportedAt, postCount, pageCount, mediaCount, mediaErrors }
```

`manifest.json`'s `mediaErrors` array lists any storage key that was
referenced by content but couldn't be retrieved at export time (a stale or
broken reference) — this makes a partial archive detectable instead of
silently incomplete. The CLI prints the same warning to the terminal if it
finds any.

### Frontmatter format

Every `posts/<slug>.md` and `pages/<slug>.md` file is a standard
YAML-frontmatter-fenced Markdown file:

```markdown
---
title: "How osshp Handles Content Rendering"
slug: "how-osshp-handles-content-rendering"
type: "article"
status: "published"
tags: [{"name":"Technical","slug":"technical"}]
publishDate: "2026-06-15T00:00:00.000Z"
createdAt: "2026-06-15T00:00:00.000Z"
updatedAt: "2026-06-20T00:00:00.000Z"
excerpt: "..."
coverImage: {"src":"media/3f9c1a2b-.../800.jpg","alt":"..."}
panoramic: false
showInBlog: false
featured: false
---

The post body, in Markdown, verbatim — except any `/media/<key>` link is
rewritten to the archive-relative `media/<key>` path above.
```

Every field is written as `key: <JSON.stringify(value)>` — this is a
deliberate choice, not an accident: JSON is a valid subset of YAML flow
scalars, so the file is genuinely standard, parseable YAML with no
osshp-specific decoder required, while still being simple to hand-roll (no
new dependency for either side). Every field is always present, even when
`null`/`false`, so "empty" and "absent" stay distinguishable.

Pages carry a smaller field set (`title`, `slug`, `type: "page"`, `status`,
`showInNav`, `createdAt`, `updatedAt`) — `type: "page"` is synthetic (pages
have no `type` column internally); it's there so a page file is still
self-describing if it's ever moved out of the `pages/` directory.

Full field-by-field tables: ADR 0003.

---

## Import

### What it's for

Three distinct use cases, all served by the same importer:

1. **A lossless round-trip** of this instance's own export — restore a
   backup, or move content between two osshp instances.
2. **Bring-your-own-Markdown** — bulk-import a folder of Markdown content
   from anywhere (a static-site export, a folder of notes) that isn't
   necessarily shaped like an osshp export.
3. **A single file** — drop in one `.md` file at a time.

Import is a materially different trust boundary from export: it reads bytes
an authenticated admin *uploads*, which may have originated anywhere. See
"Security notes" below for what that means in practice; you don't need to do
anything differently as an operator, it's documented so you know the caps
exist.

### Admin console

**Admin → Import content** (`/admin/import`) → choose a re-import mode,
choose a file (a single `.md`, or a `.tar`/`.tar.gz` archive), submit. The
page renders a report after the run: created / updated / skipped / error
counts, plus per-item detail (which slug, what happened, why).

Upload cap: **500 MB** per file (`MAX_UPLOAD_BYTES` in
`app/src/app/api/admin/import/route.ts`). For a folder of Markdown larger
than that, or for scripted/cron use, use the CLI instead — it can also
import a **directory** directly (no upload step at all), which the admin
console can't do.

### CLI (headless / scripted / directory import)

```sh
docker compose exec app ./import-content <path> [--mode=skip|overwrite|create]
# or: bun run import:content -- <path> [--mode=...]
```

`<path>` may be:

- a single `.md` file,
- a `.tar` or `.tar.gz` archive (auto-detected by content, not just the file
  extension),
- **a directory on disk** matching the export layout (`posts/`, `pages/`,
  `media/`) — the CLI-only bulk-folder case; the directory must already be
  reachable inside the container (mount it in, or run the CLI on a host with
  the checkout available).

`--mode` defaults to `skip` if omitted.

### The three re-import modes

Chosen per-import, in both the admin form (a `<select>`) and the CLI
(`--mode=`). There is no fixed policy — you choose it every time:

| Mode | Behavior on a slug that already exists |
| --- | --- |
| **`skip`** (default) | Left untouched. Reported as `skipped` with a reason. Never clobbers, never duplicates — the safe default. |
| **`overwrite`** | Replaced in place, including the source's original `createdAt`/`updatedAt` timestamps (a genuinely lossless round-trip for re-imports of your own export). An absent slug is created instead. |
| **`create`** | Always creates a new entry. A colliding slug is disambiguated (`slug-2`, `slug-3`, …) rather than silently duplicating or clobbering. |

Posts and pages are matched independently against their own store, so a
post and a page can share a slug without conflicting with each other.

### Validation behavior

Frontmatter fields fall into two classes (ADR 0004 has the full field-by-
field breakdown):

- **Identity/routing/shape fields** (`type`, `status`, `coverImage`'s shape)
  are checked against a strict whitelist — an unrecognized value fails that
  item's import with a specific reason, never guessed at.
- **Supplementary/cosmetic fields** (`tags`, `excerpt`, timestamps, boolean
  flags) degrade to a safe default on a bad value rather than failing the
  whole item — dropping a malformed tag is strictly better than rejecting an
  otherwise-good file over metadata.

`slug` sits in between: an explicit valid slug is used as-is; an invalid or
missing one is derived from the title, then the filename — this is what
makes bulk-importing arbitrary Markdown (no `slug:` frontmatter at all, the
common case for content from other static-site generators) work without
every file needing to be hand-annotated first.

A single malformed file inside a batch **does not fail the whole import** —
it's reported as an error for that item, and every other item in the batch
still imports. Only a failure that prevents the run from completing at all
(a bad path, an unreadable upload, a database error) fails the whole CLI
invocation (non-zero exit code) or admin-console request.

### Media handling

Any `media/<key>` file the source provides is copied into object storage at
that same key (idempotent — importing the same archive twice doesn't
duplicate anything) before any post/page is written. If a body or
`coverImage` references a `media/<key>` the source didn't include bytes
for, the link is still rewritten to the live `/media/<key>` form (on the
assumption the target instance may already have that object) and the gap is
recorded in the returned report's `mediaErrors` — visible in both the admin
report and the CLI's printed summary.

### Security notes (why the caps exist)

Import treats uploaded archive bytes as untrusted input by design (ADR 0004
has the full adversarial-testing detail):

- Archive entries are parsed entirely **in memory** — import never extracts
  a file to the local filesystem, so a malicious path (`../../etc/...`) has
  nowhere to write to even before path validation runs.
- Every entry path is checked for traversal, absolute paths, and NUL bytes
  before use.
- Only regular-file entries are accepted; symlinks, hardlinks, and device
  entries are rejected outright.
- Three independent size caps apply: **100 MB** per archive entry, **20,000**
  entries per archive, **1 GB** total per archive (post-decompression) — on
  top of the 500 MB raw upload cap the admin route enforces before any of
  this parsing even starts.

You'll only ever see these limits as an error message if you genuinely hit
them (a very large media library, or a hand-crafted archive) — normal
day-to-day export/import of a personal site's content stays well under all
of them.

---

**See also:** [ADR 0003 — export format](decisions/0003-content-export-format.md),
[ADR 0004 — import modes and hardening](decisions/0004-content-import.md),
`docs/backup-restore.md` (full-instance backup, a different tool for a
different job).

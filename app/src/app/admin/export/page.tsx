// /admin/export — the "Export / Backup" admin console action (issue 001).
//
// A plain authenticated GET download: /api/admin/export streams a self-
// contained .tar.gz archive (all posts + pages, every status, referenced
// media copied in). The auth layout already enforces a valid session, so no
// additional check is needed here — this page is a static explanation +
// download link, no client state.

import { Button } from "@/components/ui";

export default function ExportPage() {
  return (
    <div className="stack">
      <h1>Export / Backup</h1>
      <p className="muted">
        Download a self-contained archive of all your content — every post
        and photo-post, every page, in every status (draft, published, and
        scheduled) — as Markdown files with YAML frontmatter, plus copies of
        every image they reference. The archive is portable: it does not
        depend on this osshp instance to be useful, and it is the format the
        content-import tool reads back in.
      </p>
      <p className="muted">
        This does not include site settings or credentials. For a full
        instance backup (database + media storage + secrets), use{" "}
        <code>scripts/backup.sh</code> from the host instead.
      </p>
      <Button asChild>
        <a href="/api/admin/export" download>
          Download export archive (.tar.gz)
        </a>
      </Button>
    </div>
  );
}

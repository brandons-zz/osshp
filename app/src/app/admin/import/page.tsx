// /admin/import — the "Import content" admin console action (issue 002).
//
// Auth is enforced by the admin layout (session already validated before this
// page renders); the form itself talks to POST /api/admin/import, which
// re-validates the session (defense in depth, same pattern as every other
// /api/admin/* route).

import { ImportForm } from "./ImportForm";

export default function ImportPage() {
  return (
    <div className="stack">
      <h1>Import content</h1>
      <p className="muted">
        Import a single Markdown file, or a bulk .tar/.tar.gz archive matching
        the export archive layout (posts/, pages/, media/ — the same shape{" "}
        <a href="/admin/export">Export / Backup</a> produces). Referenced media
        is copied into the media store and links are rewritten to resolve.
      </p>
      <p className="muted">
        Choose what happens when a slug already exists: skip it, overwrite it
        in place, or always create a new entry (a colliding slug is
        disambiguated automatically — nothing is ever silently duplicated or
        overwritten by accident).
      </p>
      <ImportForm />
    </div>
  );
}

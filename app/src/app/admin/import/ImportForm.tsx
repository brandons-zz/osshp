"use client";

// Import form — the client half of the "Import content" admin console action
// (issue 002). Uploads a single .md file, or a .tar/.tar.gz bulk archive, to
// POST /api/admin/import along with the chosen re-import mode, then renders
// the returned ImportReport (created/skipped-with-reason/errors).

import { useState } from "react";
import { Button } from "@/components/ui";

type ImportMode = "skip" | "overwrite" | "create";

interface ImportItemResult {
  path: string;
  kind: "post" | "page" | "unknown";
  slug: string | null;
  outcome: "created" | "updated" | "skipped" | "error";
  reason?: string;
}

interface ImportReport {
  mode: ImportMode;
  items: ImportItemResult[];
  mediaImportedCount: number;
  mediaErrors: string[];
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}

const MODE_HELP: Record<ImportMode, string> = {
  skip: "Existing entries (matched by slug) are left untouched.",
  overwrite: "Existing entries are replaced in place with the imported content.",
  create: "Always creates a new entry; a colliding slug is disambiguated (e.g. \"-2\").",
};

export function ImportForm() {
  const [mode, setMode] = useState<ImportMode>("skip");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const form = new FormData();
      form.set("mode", mode);
      form.set("file", file);
      const res = await fetch("/api/admin/import", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as ImportReport & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Import failed.");
      }
      setReport(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={(e) => void handleSubmit(e)}>
        <div className="field">
          <label htmlFor="import-file">File</label>
          <input
            id="import-file"
            type="file"
            accept=".md,.tar,.tar.gz,.tgz"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="field-hint">
            A single Markdown file (one entry), or a .tar/.tar.gz archive matching
            the export archive layout (bulk import).
          </span>
        </div>

        <div className="field">
          <label htmlFor="import-mode">On re-import (existing slug already present)</label>
          <select
            id="import-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ImportMode)}
          >
            <option value="skip">Skip existing</option>
            <option value="overwrite">Overwrite existing</option>
            <option value="create">Always create new</option>
          </select>
          <span className="field-hint">{MODE_HELP[mode]}</span>
        </div>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || !file}>
          {busy ? "Importing…" : "Import"}
        </Button>
      </form>

      {report ? <ImportReportView report={report} /> : null}
    </div>
  );
}

function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="stack" aria-live="polite">
      <h2>Import results</h2>
      <p>
        {report.createdCount} created, {report.updatedCount} updated,{" "}
        {report.skippedCount} skipped, {report.errorCount} error
        {report.errorCount === 1 ? "" : "s"}. {report.mediaImportedCount} media file
        {report.mediaImportedCount === 1 ? "" : "s"} imported.
      </p>
      {report.mediaErrors.length > 0 ? (
        <p className="muted">
          {report.mediaErrors.length} referenced media file
          {report.mediaErrors.length === 1 ? "" : "s"} not found in the source and
          left unresolved: {report.mediaErrors.join(", ")}
        </p>
      ) : null}
      {report.items.length === 0 ? (
        <p className="muted">No files were found to import.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Kind</th>
              <th>Slug</th>
              <th>Outcome</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item, i) => (
              <tr key={`${item.path}-${i}`}>
                <td>
                  <code>{item.path}</code>
                </td>
                <td>{item.kind}</td>
                <td>{item.slug ?? "—"}</td>
                <td>
                  <span className="status-pill" data-status={item.outcome}>
                    {item.outcome}
                  </span>
                </td>
                <td>{item.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

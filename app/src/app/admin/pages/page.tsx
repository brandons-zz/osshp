// /admin/pages — list every page (all statuses) with authoring entry points.
// This is the Pages module's admin-list render target. Server component reading
// the core page store directly (admin reads return all statuses; the public
// boundary is the separate published-only read). Inert when the module is disabled.

import { getDb } from "@/lib/db/client";
import { listPages } from "@/lib/content/pages";
import { isModuleEnabled } from "@/lib/platform";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { DeleteButton } from "@/app/admin/DeleteButton";

export default async function PagesAdminList() {
  const db = getDb();
  if (!(await isModuleEnabled(db, PAGES_MODULE_ID))) {
    return (
      <div className="stack">
        <h1>Pages</h1>
        <p className="muted">
          The Pages module is disabled. Enable it in <a href="/setup">setup</a>.
        </p>
      </div>
    );
  }
  const pages = await listPages(db);

  return (
    <div className="stack">
      <div className="row row-between">
        <h1>Pages</h1>
        <a className="osshp-button" href="/admin/pages/new">
          New page
        </a>
      </div>
      {pages.length === 0 ? (
        <p className="muted">No pages yet. Create your first one.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Slug</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td>
                  <span className="status-pill" data-status={p.status}>
                    {p.status}
                  </span>
                </td>
                <td>
                  <code>{p.slug}</code>
                </td>
                <td className="row row-gap">
                  <a className="osshp-button osshp-button--ghost" href={`/admin/pages/${p.id}/edit`}>Edit</a>
                  <DeleteButton
                    endpoint={`/api/admin/pages/${p.id}`}
                    listHref="/admin/pages"
                    noun="page"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

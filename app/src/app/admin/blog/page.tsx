// /admin/blog — list every post (all statuses) with authoring entry points. This
// is the Blog module's admin-list render target. Server component reading the
// core post store directly (admin reads return all statuses; the public boundary
// is the separate published-only read). Inert when the module is disabled.

import { getDb } from "@/lib/db/client";
import { listPosts } from "@/lib/content/posts";
import { isModuleEnabled } from "@/lib/platform";
import { BLOG_MODULE_ID } from "@/modules/blog/manifest";
import { DeleteButton } from "@/app/admin/DeleteButton";

export default async function BlogAdminList() {
  const db = getDb();
  if (!(await isModuleEnabled(db, BLOG_MODULE_ID))) {
    return (
      <div className="stack">
        <h1>Blog</h1>
        <p className="muted">
          The Blog module is disabled. Enable it in <a href="/setup">setup</a>.
        </p>
      </div>
    );
  }
  const posts = (await listPosts(db)).filter((p) => p.type === "article");

  return (
    <div className="stack">
      <div className="row row-between">
        <h1>Blog</h1>
        <a className="osshp-button" href="/admin/blog/new">
          New post
        </a>
      </div>
      {posts.length === 0 ? (
        <p className="muted">No posts yet. Write your first one.</p>
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
            {posts.map((p) => (
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
                  <a href={`/admin/blog/${p.id}/edit`}>Edit</a>
                  <DeleteButton
                    endpoint={`/api/admin/blog/posts/${p.id}`}
                    listHref="/admin/blog"
                    noun="post"
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

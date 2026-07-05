// /admin/pages/[id]/edit — edit / publish an existing page. Server component
// loads the page (admin read — any status) and hands its current values to
// the client editor. notFound() for an unknown id.

import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getPageById } from "@/lib/content/pages";
import { PageEditor } from "../../PageEditor";

export default async function EditPagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const page = await getPageById(getDb(), id);
  if (!page) notFound();

  // Pages support draft/published only; coerce any other status to draft for
  // the editor (scheduled is unused in the Pages module UI).
  const editorStatus: "draft" | "published" =
    page.status === "published" ? "published" : "draft";

  return (
    <PageEditor
      mode="edit"
      initial={{
        id: page.id,
        title: page.title,
        slug: page.slug,
        body: page.body,
        status: editorStatus,
        showInNav: page.showInNav,
      }}
    />
  );
}

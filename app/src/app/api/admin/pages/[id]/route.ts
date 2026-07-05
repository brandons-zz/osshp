// PATCH /api/admin/pages/[id] — edit / publish an existing page.
// DELETE /api/admin/pages/[id] — delete a page (hard delete).
//
// Admin surface (default-deny) + authoritative session validation, same as the
// blog create/edit routes. Inline CSRF guard (host-comparison + no-store)
// because this handler takes the route `params` arg and so cannot use the
// single-arg guardMutation wrapper — same protection (§M2.1).

import { getDb } from "@/lib/db/client";
import { getPageById, updatePage, deletePage } from "@/lib/content/pages";
import type { ContentStatus } from "@/lib/content/types";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { validateTitleSlugLength } from "@/lib/content/limits";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";
import type { ImageImportResult } from "@/lib/media";

interface UpdateBody {
  title?: string;
  slug?: string;
  body?: string;
  status?: ContentStatus;
  showInNav?: boolean;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Same-origin CSRF guard, applied inline (same protection as guardMutation).
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const disabledGate = await requireModuleEnabled(db, PAGES_MODULE_ID, "Pages");
  if (disabledGate) return disabledGate;
  const { id } = await params;
  let body: UpdateBody;
  try {
    body = (await request.json()) as UpdateBody;
  } catch {
    return withNoStore(
      Response.json({ error: "invalid JSON body" }, { status: 400 }),
    );
  }
  const lengthError = validateTitleSlugLength(body.title, body.slug);
  if (lengthError) {
    return withNoStore(Response.json({ error: lengthError }, { status: 400 }));
  }
  // Issue 077: auto-import any external inline image in the (possibly edited)
  // body. Only runs when a body was actually sent — `undefined` means "leave
  // the stored body unchanged."
  let imageImports: ImageImportResult[] = [];
  let importedBody = body.body;
  if (importedBody !== undefined) {
    const result = await autoImportExternalImages(db, getMediaStorage(), importedBody);
    importedBody = result.body;
    imageImports = result.report;
  }

  const updated = await updatePage(db, id, {
    title: body.title,
    slug: body.slug,
    body: importedBody,
    status: body.status,
    showInNav: body.showInNav,
  });
  if (!updated) {
    return withNoStore(
      Response.json({ error: "page not found" }, { status: 404 }),
    );
  }
  return withNoStore(
    Response.json({
      id: updated.id,
      slug: updated.slug,
      status: updated.status,
      ...(imageImports.length > 0 ? { imageImports } : {}),
    }),
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Same-origin CSRF guard.
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const disabledGate = await requireModuleEnabled(db, PAGES_MODULE_ID, "Pages");
  if (disabledGate) return disabledGate;
  const { id } = await params;
  // Verify the page exists before deleting.
  const existing = await getPageById(db, id);
  if (!existing) {
    return withNoStore(
      Response.json({ error: "page not found" }, { status: 404 }),
    );
  }
  await deletePage(db, id);
  return withNoStore(new Response(null, { status: 204 }));
}

// POST /api/admin/pages — create a page (draft or published).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// already requires a validly-signed session to reach here; this handler ALSO
// authoritatively validates the session (revocation/expiry, not just signature).
// guardMutation-wrapped (CSRF, no-store, §M2.1).

import { getDb } from "@/lib/db/client";
import { createPage } from "@/lib/content/pages";
import type { ContentStatus } from "@/lib/content/types";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest, requireModuleEnabled } from "@/lib/platform";
import { PAGES_MODULE_ID } from "@/modules/pages/manifest";
import { validateTitleSlugLength } from "@/lib/content/limits";
import { autoImportExternalImages, getMediaStorage } from "@/lib/media";

interface CreateBody {
  title?: string;
  slug?: string;
  body?: string;
  status?: ContentStatus;
  showInNav?: boolean;
}

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const disabledGate = await requireModuleEnabled(db, PAGES_MODULE_ID, "Pages");
  if (disabledGate) return disabledGate;
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const title = body.title?.trim();
  const slug = body.slug?.trim();
  if (!title || !slug) {
    return Response.json(
      { error: "title and slug are required" },
      { status: 400 },
    );
  }
  const lengthError = validateTitleSlugLength(title, slug);
  if (lengthError) {
    return Response.json({ error: lengthError }, { status: 400 });
  }
  // Issue 077: auto-import any external inline image before persisting.
  const { body: importedBody, report: imageImports } = await autoImportExternalImages(
    db,
    getMediaStorage(),
    body.body ?? "",
  );
  const page = await createPage(db, {
    title,
    slug,
    body: importedBody,
    status: body.status ?? "draft",
    showInNav: body.showInNav === true,
  });
  return Response.json(
    {
      id: page.id,
      slug: page.slug,
      ...(imageImports.length > 0 ? { imageImports } : {}),
    },
    { status: 201 },
  );
});

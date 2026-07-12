// GET /api/admin/tags — list every tag with its post count (the /admin/tags
// list), or, with `?q=`, search matching tags (the editor's TagCombobox
// typeahead). Safe method (no CSRF), stamped no-store like the other admin
// reads (issue 037 media list precedent) since it reflects the current DB
// state and must never cache.
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// already requires a signed session; this ALSO authoritatively validates it.
// Tags are core (shared by Blog and Photos, like Media), so there is no
// single module to gate on — either module's posts can reference a tag.

import { getDb } from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/platform";
import { withNoStore } from "@/lib/auth";
import { listTagsWithCounts, searchTags } from "@/lib/content/tags";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (q) {
    const tags = await searchTags(db, q);
    return withNoStore(Response.json({ tags }));
  }
  const rows = await listTagsWithCounts(db);
  return withNoStore(
    Response.json({
      tags: rows.map(({ tag, count }) => ({ ...tag, count })),
    }),
  );
}

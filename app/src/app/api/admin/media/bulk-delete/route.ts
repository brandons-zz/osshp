// POST /api/admin/media/bulk-delete — delete a selected set of media, usage-aware
// (issue 057). Body: { ids: string[], force?: boolean }.
//
// Admin surface (default-deny) + authoritative session validation.
// guardMutation-wrapped (CSRF same-origin + no-store) — this handler takes only
// the Request, so the single-arg wrapper applies (unlike the [id] routes).
//
// Usage-aware + partial-failure-safe: each id is deleted independently through
// the shared gate. Without `force`, in-use items are reported back (with their
// references) rather than removed, so the client can list what is referenced and
// re-issue with force. Always 200 with a per-item result array — a mixed set
// (some deleted, some blocked, some missing) is the normal case, not an error.

import { getDb } from "@/lib/db/client";
import { guardMutation, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage } from "@/lib/media";
import { bulkDeleteMedia } from "@/lib/content/media-delete";

interface BulkDeleteBody {
  ids?: unknown;
  force?: unknown;
}

const MAX_BULK = 500; // a single-site sanity cap — far above any real selection.

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: BulkDeleteBody;
  try {
    body = (await request.json()) as BulkDeleteBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (
    !Array.isArray(body.ids) ||
    body.ids.some((id) => typeof id !== "string")
  ) {
    return Response.json(
      { error: "ids must be an array of strings" },
      { status: 400 },
    );
  }
  const ids = body.ids as string[];
  if (ids.length === 0) {
    return Response.json({ error: "no ids provided" }, { status: 400 });
  }
  if (ids.length > MAX_BULK) {
    return Response.json(
      { error: `at most ${MAX_BULK} items per request` },
      { status: 400 },
    );
  }
  const force = body.force === true;

  const outcome = await bulkDeleteMedia(db, getMediaStorage(), ids, { force });
  return Response.json(outcome);
});

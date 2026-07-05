// POST /api/admin/blog/preview — render Markdown to sanitized, syntax-highlighted
// HTML for the editor's live preview.
//
// Renders through the SAME app-owned pipeline the public site uses (renderMarkdown
// = unified/remark/rehype-sanitize + Shiki, §9), so the preview is faithful to the
// published output and no parallel sanitizer is introduced. Admin surface
// (default-deny middleware) + authoritative session check. guardMutation-wrapped
// like every new mutating route (CSRF; no-store on the response). It does not
// write content; POST is used because it carries a body and is an admin action.

import { renderMarkdown } from "@/lib/theme/sanitize";
import { guardMutation } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { getSessionFromRequest } from "@/lib/platform";

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  if (!(await getSessionFromRequest(getDb(), request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { markdown?: unknown };
  try {
    body = (await request.json()) as { markdown?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  return Response.json({ html: renderMarkdown(markdown) });
});

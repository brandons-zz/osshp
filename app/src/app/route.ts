// GET / — the public home, rendered through the active theme. Before an admin is
// provisioned the instance has nothing to show and no operator, so the root
// redirects into the first-run setup wizard (single-use; M1.6 bootstrap closes it
// once the admin exists). After setup, "/" is the theme-rendered home (the
// published post list).
//
// This is a Route Handler (not a page) so the THEME owns the full <html> document
// (theme-rendering-contract §3.2) — the app root layout is not applied here.

import { getDb } from "@/lib/db/client";
import { isBootstrapAvailable } from "@/lib/auth/bootstrap";
import { renderPublicRoute } from "@/lib/platform/render";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (await isBootstrapAvailable(db)) {
    return Response.redirect("/setup", 302);
  }
  return renderPublicRoute({ kind: "home" }, request);
}

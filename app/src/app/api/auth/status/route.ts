// GET /api/auth/status — minimal state for the setup wizard / login UI (M1.8).
// Reveals only whether an admin is provisioned and whether THIS request is
// authenticated; no admin record, no secrets.

import { getDb } from "@/lib/db/client";
import {
  isBootstrapAvailable,
  readSessionCookie,
  validateSession,
} from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const adminProvisioned = !(await isBootstrapAvailable(db));
  const authenticated = Boolean(
    await validateSession(db, readSessionCookie(request)),
  );
  return Response.json({ adminProvisioned, authenticated });
}

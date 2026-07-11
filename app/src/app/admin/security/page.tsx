// /admin/security — the Security Center (Slice 2).
//
// Credential VISIBILITY (sessions/devices, recent auth activity, recovery-code
// status) plus the one new mutation the center owns: revoke every session but this
// one. Credential MANAGEMENT stays on the sibling /admin/account/security page —
// this page links to it, it does not duplicate those mutations (design D1).
//
// The admin layout already enforces a valid session; this server component reads
// the initial overview + first events page directly (no self-fetch) and hands them
// to the client component, which owns the revoke flow, the re-fetch after revoke,
// and events pagination. `current` is computed from THIS session's id so the
// caller's own row is marked without the full id ever reaching the client.

import { getDb } from "@/lib/db/client";
import { getAdminSession } from "@/lib/platform";
import { buildSecurityOverview, listAuditEvents } from "@/lib/auth";
import { SecurityCenter } from "./SecurityCenter";

export default async function SecurityCenterPage() {
  const session = await getAdminSession();
  if (!session) return null; // layout redirects unauthenticated; defensive only

  const db = getDb();
  const [overview, events] = await Promise.all([
    buildSecurityOverview(db, session.id),
    listAuditEvents(db, {}),
  ]);

  return <SecurityCenter initialOverview={overview} initialEvents={events} />;
}

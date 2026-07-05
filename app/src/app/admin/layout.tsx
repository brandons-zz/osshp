// Admin shell layout — the authenticated console chrome. Every /admin/* route
// renders inside it. Defense in depth over the default-deny middleware: this also
// authoritatively validates the session (revocation/expiry) and redirects to
// /login if it is not valid. The nav is projected from the ENABLED modules'
// adminNav capability (a disabled module contributes nothing), built from the
// owned-component vocabulary (admin UI uses owned components only, §8.3).
//
// The nav itself (link list + core surfaces + Sign out) is rendered by AdminNav
// — a client component that collapses the list behind a disclosure on small
// screens (issue 041) while leaving this layout a plain server component.

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getAdminSession, getEnabledCapabilities } from "@/lib/platform";
import { AdminNav } from "./AdminNav";
import { LogoutButton } from "./LogoutButton";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminSession();
  if (!session) redirect("/login");

  const caps = await getEnabledCapabilities(getDb());
  const nav = [...caps.adminNav].sort((a, b) => a.order - b.order);

  return (
    <div className="shell">
      <AdminNav nav={nav}>
        <LogoutButton />
      </AdminNav>
      <main className="shell-main">{children}</main>
    </div>
  );
}

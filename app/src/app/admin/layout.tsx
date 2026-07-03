// Admin shell layout — the authenticated console chrome. Every /admin/* route
// renders inside it. Defense in depth over the default-deny middleware: this also
// authoritatively validates the session (revocation/expiry) and redirects to
// /login if it is not valid. The nav is projected from the ENABLED modules'
// adminNav capability (a disabled module contributes nothing), built from the
// owned-component vocabulary (admin UI uses owned components only, §8.3).

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getAdminSession, getEnabledCapabilities } from "@/lib/platform";
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
      <nav className="shell-nav" aria-label="Admin">
        <p className="shell-brand">osshp admin</p>
        <a href="/admin">Dashboard</a>
        {nav.map((entry) => (
          <a key={`${entry.moduleId}-${entry.href}`} href={entry.href}>
            {entry.label}
          </a>
        ))}
        <a href="/admin/account/security">Account security</a>
        <a href="/admin/settings">Settings</a>
        <a href="/admin/export">Export / Backup</a>
        <a href="/admin/import">Import</a>
        <a href="/">View site</a>
        <div className="shell-nav-footer">
          <LogoutButton />
        </div>
      </nav>
      <main className="shell-main">{children}</main>
    </div>
  );
}

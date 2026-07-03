// Admin dashboard — the landing surface after sign-in. Lists the enabled modules
// (their admin entry points) so the operator can jump to authoring. Minimal for
// the walking skeleton; richer dashboards are later work.

import { getDb } from "@/lib/db/client";
import { getEnabledCapabilities } from "@/lib/platform";

export default async function AdminDashboard() {
  const caps = await getEnabledCapabilities(getDb());
  const nav = [...caps.adminNav].sort((a, b) => a.order - b.order);

  return (
    <div className="stack">
      <h1>Dashboard</h1>
      {nav.length === 0 ? (
        <p className="muted">
          No modules are enabled. Re-run <a href="/setup">setup</a> to enable
          features.
        </p>
      ) : (
        <ul className="stack plain-list">
          {nav.map((entry) => (
            <li className="shell-card" key={`${entry.moduleId}-${entry.href}`}>
              <a href={entry.href}>
                <strong>{entry.label}</strong>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

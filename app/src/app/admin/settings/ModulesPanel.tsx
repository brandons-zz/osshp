"use client";

// Modules panel — enable/disable the first-party modules (Blog / Pages / Photos)
// post-setup (issue 027). A structured checklist matching the setup wizard's
// module-selection step (SetupWizard.tsx `.choice` rows) so the same choice is
// presented the same way whether it's made during setup or later from Settings.
//
// Submits the FULL desired enabled set to PATCH /api/admin/modules — a
// dedicated route, not the generic settings allowlist (see route.ts for why).
// Disabling every module is allowed: it never removes this Settings page, the
// account/export/import pages, or the dashboard from the admin nav — those are
// core admin routes rendered unconditionally by AdminLayout, not module-driven
// (only each module's OWN admin-nav entry disappears when it is disabled).

import { useState } from "react";
import { Button } from "@/components/ui";

export interface ModuleToggleItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ModulesPanelProps {
  modules: ModuleToggleItem[];
}

export function ModulesPanel({ modules }: ModulesPanelProps) {
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(modules.filter((m) => m.enabled).map((m) => m.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function toggle(id: string) {
    setSaved(false);
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/modules", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: [...enabledIds] }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Server error (${res.status})`);
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  if (modules.length === 0) return null;

  return (
    <section className="shell-card stack">
      <h2>Modules</h2>
      <p className="muted">
        Enable or disable each first-party module. A disabled module's public
        pages and admin section become unreachable and drop from navigation;
        re-enabling brings them straight back — nothing is deleted. Settings,
        account security, and export/import always stay reachable regardless of
        which modules are on.
      </p>

      <form className="stack" onSubmit={handleSave}>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="muted" role="status">
            Modules saved.
          </p>
        ) : null}

        {modules.map((m) => (
          <label className="choice" key={m.id}>
            <input
              type="checkbox"
              checked={enabledIds.has(m.id)}
              onChange={() => toggle(m.id)}
              disabled={busy}
            />
            <span>
              <strong>{m.name}</strong>
              <br />
              <span className="muted">{m.description}</span>
            </span>
          </label>
        ))}

        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save modules"}
          </Button>
        </div>
      </form>
    </section>
  );
}

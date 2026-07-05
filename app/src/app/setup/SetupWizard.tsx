"use client";

// SetupWizard — the first-run setup wizard client component.
//
// Rendered only when the server-side guard in page.tsx confirms that setup is
// not yet complete (isBootstrapAvailable is true AND site.setupComplete is
// falsy). Once the site is configured this component is never reached — page.tsx
// calls notFound() before rendering it.

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Button } from "@/components/ui";
import { AccentSwatch } from "./AccentSwatch";

type Step = "loading" | "admin" | "locked" | "brand" | "modules";
interface ModuleChoice {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
}

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [accent, setAccent] = useState("#2563eb");

  const [modules, setModules] = useState<ModuleChoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Decide the entry step from current admin/auth state.
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/status");
      const { adminProvisioned, authenticated } = await res.json();
      if (!adminProvisioned) {
        setStep("admin");
      } else if (!authenticated) {
        setStep("locked");
      } else {
        const setup = await fetch("/api/setup").then((r) => r.json());
        if (setup.setupComplete) {
          window.location.assign("/admin");
          return;
        }
        loadModules(setup);
        setStep("brand");
      }
    })().catch(() => setStep("admin"));
  }, []);

  function loadModules(setup: {
    available: ModuleChoice[];
    enabled: string[];
  }) {
    setModules(setup.available);
    setSelected(
      new Set(
        setup.available
          .filter((m) => m.defaultEnabled || setup.enabled.includes(m.id))
          .map((m) => m.id),
      ),
    );
  }

  async function createAdmin() {
    setBusy(true);
    setError("");
    try {
      const optRes = await fetch("/api/auth/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("Could not start passkey enrollment.");
      const optionsJSON = await optRes.json();
      const response = await startRegistration({ optionsJSON });
      const verifyRes = await fetch("/api/auth/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Passkey could not be verified.");
      }
      const setup = await fetch("/api/setup").then((r) => r.json());
      loadModules(setup);
      setStep("brand");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrollment failed.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          accent,
          modules: [...selected],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Could not save setup.");
      }
      window.location.assign("/admin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="wizard">
      <h1>Set up your site</h1>
      <ol className="wizard-steps">
        <li aria-current={step === "admin" ? "step" : undefined}>1. Admin</li>
        <li aria-current={step === "brand" ? "step" : undefined}>2. Name &amp; brand</li>
        <li aria-current={step === "modules" ? "step" : undefined}>3. Modules</li>
      </ol>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {step === "loading" ? <p className="muted">Loading…</p> : null}

      {step === "locked" ? (
        <div className="shell-card">
          <p>This site is already set up.</p>
          <p>
            <a href="/login">Sign in</a> to manage it.
          </p>
        </div>
      ) : null}

      {step === "admin" ? (
        <div className="shell-card stack">
          <p>
            Create your administrator passkey. This is the only account, and it can
            only be created once.
          </p>
          <Button onClick={createAdmin} disabled={busy}>
            {busy ? "Waiting for passkey…" : "Create admin passkey"}
          </Button>
        </div>
      ) : null}

      {step === "brand" ? (
        <form
          className="shell-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) setStep("modules");
            else setError("A site title is required.");
          }}
        >
          <div className="field">
            <label htmlFor="title">Site title</label>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="description">Description (optional)</label>
            <input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="accent">Accent color</label>
            <div className="accent-row">
              <input
                id="accent"
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
              />
              <AccentSwatch value={accent} />
            </div>
            <span className="field-hint">
              Any hue — the platform keeps text and controls AA-accessible
              automatically.
            </span>
          </div>
          <Button type="submit">Continue</Button>
        </form>
      ) : null}

      {step === "modules" ? (
        <form
          className="shell-card"
          onSubmit={(e) => {
            e.preventDefault();
            finish();
          }}
        >
          <p className="muted">Choose the features to enable. You can change this later.</p>
          {modules.map((m) => (
            <label className="choice" key={m.id}>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => toggle(m.id)}
              />
              <span>
                <strong>{m.name}</strong>
                <br />
                <span className="muted">{m.description}</span>
              </span>
            </label>
          ))}
          <div className="row" style={{ marginTop: "var(--space-m)" }}>
            <Button type="submit" disabled={busy}>
              {busy ? "Finishing…" : "Finish setup"}
            </Button>
          </div>
        </form>
      ) : null}
    </main>
  );
}

"use client";

// Account security form — password, TOTP, and recovery-code management.
//
// Server component (page.tsx) reads the current credential status and passes it
// as props; this client component owns the mutation flows. Every mutation calls
// the existing /api/admin/account/* routes, which are CSRF-guarded and session-
// gated. On success each mutation revokes all sessions and issues a fresh one, so
// we reload the page to pick up the new cookie + re-render the server-side status.
//
// TOTP enrollment is a two-step sequence (verify-before-enable, T5):
//  1. POST /totp → server mints a secret, returns it ONCE; displayed here.
//  2. Operator enters the 6-digit code their app generates.
//  3. PUT /totp → server confirms the code, enables the lane; page reloads.
//
// Recovery codes are display-once: the POST response carries the plaintext;
// we show them immediately from the response and never fetch them again.

import { useState } from "react";
import { Button } from "@/components/ui";

export interface AccountSecurityFormProps {
  hasPassword: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
}

// ─── Password section ──────────────────────────────────────────────────────────

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      setSaved(true);
      setPassword("");
      // Session was rotated — reload to pick up the new cookie + re-render status.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shell-card stack">
      <h2>Password</h2>
      <p className="muted">
        {hasPassword
          ? "A password is set. Enter a new one to change it (minimum 12 characters)."
          : "No password set. Set one to enable the password + TOTP recovery lane."}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="muted" role="status">
          Password saved.
        </p>
      ) : null}
      <form className="stack" onSubmit={handleSave}>
        <div className="field">
          <label htmlFor="acct-password">
            {hasPassword ? "New password" : "Password"}
          </label>
          <input
            id="acct-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => {
              setPassword(e.target.value);
              setSaved(false);
            }}
            minLength={12}
            required
          />
          <span className="field-hint">Minimum 12 characters.</span>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ─── TOTP section ─────────────────────────────────────────────────────────────

type TotpState =
  | { phase: "idle" }
  | { phase: "enrolling"; secret: string; uri: string }
  | { phase: "confirmed" };

function TotpSection({ totpEnabled }: { totpEnabled: boolean }) {
  const [state, setState] = useState<TotpState>({ phase: "idle" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function startEnrollment() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/totp", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      const data = (await res.json()) as { secret: string; uri: string };
      setState({ phase: "enrolling", secret: data.secret, uri: data.uri });
      setToken("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start enrollment.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment(e: React.FormEvent) {
    e.preventDefault();
    if (state.phase !== "enrolling") return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/totp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      // Session was rotated; reload to re-render the updated status.
      window.location.reload();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not verify code.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === "enrolling") {
    return (
      <section className="shell-card stack">
        <h2>TOTP authenticator</h2>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted">
          Open your authenticator app (Google Authenticator, Bitwarden,
          Authy…) and add a new entry using{" "}
          <strong>manual / enter setup key</strong>. Paste the secret below, or
          tap the link to open it directly.
        </p>
        <div className="field">
          <label htmlFor="totp-secret">Setup key (base32 secret)</label>
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
          <input
            id="totp-secret"
            type="text"
            value={state.secret}
            readOnly
            aria-readonly="true"
            onClick={(e) =>
              (e.currentTarget as HTMLInputElement).select()
            }
          />
          <span className="field-hint">
            Click to select, then copy into your authenticator.{" "}
            <a
              href={state.uri}
              target="_blank"
              rel="noreferrer"
              aria-label="Open TOTP setup URI in authenticator app"
            >
              Open in app
            </a>
          </span>
        </div>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          This secret is shown <strong>once only</strong> and is not stored in
          plaintext. After you confirm, it will never be displayed again.
        </p>
        <form className="stack" onSubmit={confirmEnrollment}>
          <div className="field">
            <label htmlFor="totp-token">
              6-digit code from your authenticator
            </label>
            <input
              id="totp-token"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError("");
              }}
              autoComplete="one-time-code"
              required
              placeholder="123456"
            />
          </div>
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Activate TOTP"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setState({ phase: "idle" });
                setError("");
              }}
              style={{ background: "var(--surface-2)", color: "var(--text)" }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="shell-card stack">
      <h2>TOTP authenticator</h2>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {totpEnabled ? (
        <p className="muted">
          TOTP is enrolled. Use it alongside your password to sign in when your
          passkey is unavailable.
        </p>
      ) : (
        <p className="muted">
          No TOTP authenticator enrolled. Enrolling one enables the
          password&nbsp;+&nbsp;TOTP recovery lane.
        </p>
      )}
      <div>
        <Button onClick={startEnrollment} disabled={busy}>
          {busy
            ? "Starting…"
            : totpEnabled
              ? "Re-enroll TOTP"
              : "Set up TOTP"}
        </Button>
      </div>
    </section>
  );
}

// ─── Recovery codes section ────────────────────────────────────────────────────

function RecoveryCodesSection({
  recoveryCodesRemaining,
}: {
  recoveryCodesRemaining: number;
}) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function generateCodes() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/recovery-codes", {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      const data = (await res.json()) as { codes: string[] };
      setCodes(data.codes);
      // Session was rotated. The page will reload on "Done" so the count updates.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate codes.");
    } finally {
      setBusy(false);
    }
  }

  if (codes !== null) {
    return (
      <section className="shell-card stack">
        <h2>Recovery codes</h2>
        <p className="error" role="alert">
          <strong>Save these codes now — they will not be shown again.</strong>{" "}
          Each code can be used once. Store them somewhere safe (password
          manager, printed copy locked away).
        </p>
        <ul className="plain-list" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: 2 }}>
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <div>
          <Button
            onClick={() => window.location.reload()}
          >
            Done — I&apos;ve saved my codes
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="shell-card stack">
      <h2>Recovery codes</h2>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {recoveryCodesRemaining > 0 ? (
        <p className="muted">
          {recoveryCodesRemaining} of 10 codes remaining. Each code can be
          used once; generating a new set invalidates all remaining codes.
        </p>
      ) : (
        <p className="muted">
          No recovery codes generated. Generate a set to enable the recovery-code
          sign-in lane (last resort when both passkey and TOTP are unavailable).
        </p>
      )}
      <div>
        <Button onClick={generateCodes} disabled={busy}>
          {busy
            ? "Generating…"
            : recoveryCodesRemaining > 0
              ? "Regenerate recovery codes"
              : "Generate recovery codes"}
        </Button>
      </div>
    </section>
  );
}

// ─── Composed form ─────────────────────────────────────────────────────────────

export function AccountSecurityForm({
  hasPassword,
  totpEnabled,
  recoveryCodesRemaining,
}: AccountSecurityFormProps) {
  return (
    <div className="stack">
      <PasswordSection hasPassword={hasPassword} />
      <TotpSection totpEnabled={totpEnabled} />
      <RecoveryCodesSection
        recoveryCodesRemaining={recoveryCodesRemaining}
      />
    </div>
  );
}

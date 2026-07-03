"use client";

// /login/recovery — fallback sign-in for operators who cannot use their passkey.
//
// Two independent lanes, matching the backend:
//
//  Lane 1 — Password + TOTP:
//    POST /api/auth/recovery/password-totp (both factors required, rate-limited).
//    On success: a session cookie is issued and we redirect to /admin.
//    The operator can then optionally re-enroll a new passkey from the console.
//
//  Lane 2 — Recovery code (last resort):
//    POST /api/auth/recovery/code (single-use, rate-limited).
//    On success: NO session (R6) — a re-enrollment window opens. We then drive
//    the passkey registration ceremony so the operator re-establishes a passkey
//    and gets a session. Redirect to /admin after verification.
//
// Error messages are NEVER lane-specific ("recovery failed" for all failures) to
// prevent enumeration of which factor was wrong. Rate-limited server-side (B4).

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Button } from "@/components/ui";

// ─── Lane 1: Password + TOTP ──────────────────────────────────────────────────

function PasswordTotpForm() {
  const [password, setPassword] = useState("");
  const [totpToken, setTotpToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/recovery/password-totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, totpToken }),
      });
      if (res.status === 429) {
        setError(
          "Too many attempts. Please wait a few minutes before trying again.",
        );
        return;
      }
      if (!res.ok) {
        // Non-enumerating: never reveal which factor failed.
        setError("Recovery failed. Check your password and authenticator code.");
        return;
      }
      // Session cookie was set by the server; navigate to admin.
      window.location.assign("/admin");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shell-card stack">
      <h2>Sign in with password and authenticator</h2>
      <p className="muted">
        Both your password and your current TOTP code are required. This lane
        is available only when both have been set up in the admin console.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <form className="stack" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="rec-password">Password</label>
          <input
            id="rec-password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => {
              setPassword(e.target.value);
              setError("");
            }}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="rec-totp">6-digit authenticator code</label>
          <input
            id="rec-totp"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={totpToken}
            autoComplete="one-time-code"
            onChange={(e) => {
              setTotpToken(e.target.value);
              setError("");
            }}
            required
            placeholder="123456"
          />
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Sign in"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ─── Lane 2: Recovery code ────────────────────────────────────────────────────

type RecoveryCodeState =
  | { phase: "idle" }
  | { phase: "reenrolling" };

function RecoveryCodeForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<RecoveryCodeState>({ phase: "idle" });
  // The single-use re-enrollment token returned by the recovery-code lane (F1).
  // It binds the open window to this operator and is required by the register
  // ceremony; the retry button re-uses it (it is consumed only on a successful
  // verify, so a failed attempt can be retried with the same token).
  const [reenrollToken, setReenrollToken] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/recovery/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.status === 429) {
        setError(
          "Too many attempts. Please wait a few minutes before trying again.",
        );
        return;
      }
      if (!res.ok) {
        // Non-enumerating: same message whether code is wrong, used, or unknown.
        setError("Recovery failed. Check the code and try again.");
        return;
      }
      // Code accepted (R6). The server opened a possession-bound re-enrollment
      // window and returned a single-use token but NO session. Drive the passkey
      // registration ceremony (presenting the token) to re-establish access.
      const data = (await res.json().catch(() => ({}))) as {
        reenrollToken?: string;
      };
      setReenrollToken(data.reenrollToken ?? "");
      setPhase({ phase: "reenrolling" });
      await driveReenrollment(data.reenrollToken ?? "");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function driveReenrollment(token: string = reenrollToken) {
    setError("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/register/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reenrollToken: token }),
      });
      if (!optRes.ok) {
        throw new Error("Could not start passkey enrollment.");
      }
      const optionsJSON = await optRes.json();
      const response = await startRegistration({ optionsJSON });
      const verifyRes = await fetch("/api/auth/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response, reenrollToken: token }),
      });
      if (!verifyRes.ok) {
        const err = (await verifyRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(err.error ?? "Passkey enrollment could not be verified.");
      }
      // Session issued; navigate to admin.
      window.location.assign("/admin");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Passkey enrollment failed. Try refreshing and using a recovery code again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (phase.phase === "reenrolling") {
    return (
      <section className="shell-card stack">
        <h2>Set up a new passkey</h2>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted">
          Recovery code accepted. Enroll a new passkey to complete sign-in. Your
          browser or device will prompt you to create a passkey.
        </p>
        <div>
          <Button onClick={() => driveReenrollment()} disabled={busy}>
            {busy ? "Waiting for passkey…" : "Enroll new passkey"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="shell-card stack">
      <h2>Sign in with a recovery code</h2>
      <p className="muted">
        Use one of the recovery codes you saved when you set up your account.
        Each code is single-use. After a successful recovery you will be asked
        to enroll a new passkey.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <form className="stack" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="rec-code">Recovery code</label>
          <input
            id="rec-code"
            type="text"
            value={code}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setCode(e.target.value);
              setError("");
            }}
            required
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          />
          <span className="field-hint">
            Dashes and case are ignored.
          </span>
        </div>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Use recovery code"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecoveryLoginPage() {
  return (
    <main className="wizard">
      <h1>Account recovery</h1>
      <p className="muted">
        Use a recovery method when you cannot sign in with your passkey.
        After recovery you will be able to re-enroll your passkey from the
        admin console.
      </p>
      <div className="stack">
        <PasswordTotpForm />
        <RecoveryCodeForm />
      </div>
      <p className="muted" style={{ marginTop: "var(--space-m)" }}>
        <a href="/login">← Back to sign in</a>
      </p>
    </main>
  );
}

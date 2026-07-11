"use client";

// Account security form — password, TOTP, recovery-code, and passkey management.
//
// Server component (page.tsx) reads the current credential status and passes it as
// props; this client component owns the mutation flows. Every credential-changing
// action is now gated by A1 step-up re-authentication: the backend returns a
// uniform 403 without a fresh grant. So each action first runs the step-up flow
// (StepUpDialog — passkey-primary, password+TOTP fallback behind an explicit
// affordance, D14), obtains a grant, and sends it on the x-osshp-stepup-grant
// header. On success the server revokes all sessions and issues a fresh one, so we
// reload to pick up the new cookie + re-render the server-side status.
//
// A single StepUpDialog is lifted to the form and shared by every section via the
// promise-based requestStepUp(actionLabel) → grant | null (null = cancelled).
//
// Two-request flows only gate the FIRST (state-touching) request, matching the
// backend: TOTP POST (begin) is gated, PUT (confirm) is self-gated by the pending
// secret; passkey enroll gates register/options, and register/verify rides the
// single-use challenge.

import { useCallback, useRef, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Button } from "@/components/ui";
import { StepUpDialog } from "./StepUpDialog";

/** Obtain a step-up grant for an action; resolves to the grant, or null if the
 *  operator cancelled the step-up prompt. */
type RequestStepUp = (actionLabel: string) => Promise<string | null>;

const GRANT_HEADER = "x-osshp-stepup-grant";
const EXPIRED_MSG = "Your confirmation expired. Please try again.";

export interface AccountSecurityFormProps {
  hasPassword: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  passkeys: { credentialId: string }[];
}

// ─── Password section ──────────────────────────────────────────────────────────

function PasswordSection({
  hasPassword,
  requestStepUp,
}: {
  hasPassword: boolean;
  requestStepUp: RequestStepUp;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    const grant = await requestStepUp("change your password");
    if (!grant) return; // cancelled
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/password", {
        method: "POST",
        headers: { "content-type": "application/json", [GRANT_HEADER]: grant },
        body: JSON.stringify({ password }),
      });
      if (res.status === 403) {
        setError(EXPIRED_MSG);
        return;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      setSaved(true);
      setPassword("");
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
          : "No password set. Set one to enable the password + TOTP recovery lane."}
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

function TotpSection({
  totpEnabled,
  requestStepUp,
}: {
  totpEnabled: boolean;
  requestStepUp: RequestStepUp;
}) {
  const [state, setState] = useState<TotpState>({ phase: "idle" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function startEnrollment() {
    setError("");
    // Beginning enrollment overwrites the stored secret (mutating) → step-up gated.
    const grant = await requestStepUp("set up a new authenticator");
    if (!grant) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/totp", {
        method: "POST",
        headers: { [GRANT_HEADER]: grant },
      });
      if (res.status === 403) {
        setError(EXPIRED_MSG);
        return;
      }
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
      // Confirm (PUT) is NOT step-up gated: possession of the pending secret the
      // gated POST minted is itself the proof (backend §3).
      const res = await fetch("/api/admin/account/totp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify code.");
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
            onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
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
  requestStepUp,
}: {
  recoveryCodesRemaining: number;
  requestStepUp: RequestStepUp;
}) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function generateCodes() {
    setError("");
    const grant = await requestStepUp("regenerate your recovery codes");
    if (!grant) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/account/recovery-codes", {
        method: "POST",
        headers: { [GRANT_HEADER]: grant },
      });
      if (res.status === 403) {
        setError(EXPIRED_MSG);
        return;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Error (${res.status})`);
      }
      const data = (await res.json()) as { codes: string[] };
      setCodes(data.codes);
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
        <ul
          className="plain-list"
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: 2 }}
        >
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <div>
          <Button onClick={() => window.location.reload()}>
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

// ─── Passkeys section ──────────────────────────────────────────────────────────

function PasskeysSection({
  passkeys,
  requestStepUp,
}: {
  passkeys: { credentialId: string }[];
  requestStepUp: RequestStepUp;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isLast = passkeys.length <= 1;

  async function addPasskey() {
    setError("");
    // Enrolling a passkey is a credential change → step-up gates register/options.
    const grant = await requestStepUp("add a passkey");
    if (!grant) return;
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/register/options", {
        method: "POST",
        headers: { [GRANT_HEADER]: grant },
      });
      if (optRes.status === 403) {
        setError(EXPIRED_MSG);
        return;
      }
      if (!optRes.ok) {
        const err = (await optRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Could not start passkey enrollment.");
      }
      const optionsJSON = await optRes.json();
      // register/verify rides the single-use challenge the gated options stored —
      // it needs no grant of its own (backend §3).
      const response = await startRegistration({ optionsJSON });
      const verifyRes = await fetch("/api/auth/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        const err = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Passkey could not be verified.");
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add passkey.");
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(credentialId: string) {
    setError("");
    const grant = await requestStepUp("remove this passkey");
    if (!grant) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/admin/account/passkeys/${encodeURIComponent(credentialId)}`,
        { method: "DELETE", headers: { [GRANT_HEADER]: grant } },
      );
      if (res.status === 403) {
        setError(EXPIRED_MSG);
        return;
      }
      if (res.status === 400) {
        setError("You can't remove your only passkey. Add another one first.");
        return;
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Could not remove passkey.");
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove passkey.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shell-card stack">
      <h2>Passkeys</h2>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="muted">
        Passkeys are your primary way to sign in. Keep at least two (e.g. a
        laptop and a phone) so losing one device never locks you out.
      </p>
      {passkeys.length > 0 ? (
        <ul className="plain-list stack" aria-label="Registered passkeys">
          {passkeys.map((pk, i) => (
            <li key={pk.credentialId} className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Passkey {i + 1}{" "}
                <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                  ({pk.credentialId.slice(0, 12)}…)
                </span>
              </span>
              <Button
                type="button"
                className="osshp-button--danger"
                disabled={busy || isLast}
                aria-label={`Remove passkey ${i + 1}`}
                onClick={() => removePasskey(pk.credentialId)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No passkeys registered.</p>
      )}
      {isLast ? (
        <p className="field-hint">
          Add a second passkey before you can remove this one.
        </p>
      ) : null}
      <div>
        <Button onClick={addPasskey} disabled={busy}>
          {busy ? "Waiting for passkey…" : "Add a passkey"}
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
  passkeys,
}: AccountSecurityFormProps) {
  // One shared step-up dialog, resolved via a promise per requesting action.
  const resolverRef = useRef<((grant: string | null) => void) | null>(null);
  const [stepUpLabel, setStepUpLabel] = useState<string | null>(null);

  const requestStepUp = useCallback<RequestStepUp>((actionLabel) => {
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
      setStepUpLabel(actionLabel);
    });
  }, []);

  const settle = useCallback((grant: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setStepUpLabel(null);
    resolve?.(grant);
  }, []);

  return (
    <div className="stack">
      <PasskeysSection passkeys={passkeys} requestStepUp={requestStepUp} />
      <PasswordSection hasPassword={hasPassword} requestStepUp={requestStepUp} />
      <TotpSection totpEnabled={totpEnabled} requestStepUp={requestStepUp} />
      <RecoveryCodesSection
        recoveryCodesRemaining={recoveryCodesRemaining}
        requestStepUp={requestStepUp}
      />
      <StepUpDialog
        open={stepUpLabel !== null}
        actionLabel={stepUpLabel ?? ""}
        onGrant={(grant) => settle(grant)}
        onCancel={() => settle(null)}
      />
    </div>
  );
}

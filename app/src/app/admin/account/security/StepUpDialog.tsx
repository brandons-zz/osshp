"use client";

// StepUpDialog — the client half of A1 step-up re-authentication (D14).
//
// Every credential-changing admin action now requires a fresh step-up grant on
// the x-osshp-stepup-grant header (the backend returns a uniform 403 without one).
// This modal obtains that grant: PASSKEY-PRIMARY per D14 — it invokes the WebAuthn
// assertion ceremony (/api/auth/stepup/options → startAuthentication → /verify)
// directly; the password+TOTP fallback (/api/auth/stepup/password-totp) is exposed
// ONLY behind the explicit "Passkey unavailable?" affordance.
//
// Modal chrome reuses the codebase's proven AA pattern (ConfirmDialog): a native
// <dialog showModal()> — top-layer, Esc-to-cancel, backdrop-click, focus restore —
// with the shared two-direction focus trap, semantic-token styling (.osshp-dialog),
// and a border-box shell that reflows at 320px (WCAG 1.4.10). All controls are
// native <button>/<input> (2.1.1 keyboard, 4.1.2 name/role/value); errors announce
// via role="alert"; the dialog is named/described via aria-labelledby/describedby.
//
// It does not perform the credential change itself — on success it calls onGrant
// with the plaintext grant, and the caller sends it on the gated request.

import { useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Button } from "@/components/ui";
import { useDialogFocusTrap } from "@/components/ui/use-dialog-focus-trap";

export interface StepUpDialogProps {
  /** Whether the dialog is visible. The caller toggles this. */
  open: boolean;
  /** Verb phrase naming the action, e.g. "change your password". */
  actionLabel: string;
  /** Called with the plaintext grant once fresh presence is proven. */
  onGrant: (grant: string) => void;
  /** Called when the operator cancels (Cancel, Esc, or backdrop). */
  onCancel: () => void;
}

type Mode = "passkey" | "fallback";

export function StepUpDialog({ open, actionLabel, onGrant, onCancel }: StepUpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const [mode, setMode] = useState<Mode>("passkey");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [totpToken, setTotpToken] = useState("");

  useDialogFocusTrap(dialogRef);

  // Show / hide the native modal, reset state on open, restore focus on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        prevFocusRef.current = document.activeElement as HTMLElement | null;
        setMode("passkey");
        setError("");
        setPassword("");
        setTotpToken("");
        setBusy(false);
        dialog.showModal();
        // Focus the primary confirm action (the expected next step).
        primaryBtnRef.current?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
      prevFocusRef.current?.focus();
      prevFocusRef.current = null;
    }
  }, [open]);

  // Esc fires the native 'cancel' event — map it to onCancel and keep React in control.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      e.preventDefault();
      if (!busy) onCancel();
    }
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel, busy]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (busy) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) onCancel();
  }

  async function confirmWithPasskey() {
    setError("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/stepup/options", { method: "POST" });
      if (optRes.status === 429) {
        setError("Too many attempts. Please wait a moment and try again.");
        return;
      }
      if (!optRes.ok) {
        setError("Could not start passkey confirmation. Please try again.");
        return;
      }
      const optionsJSON = await optRes.json();
      const response = await startAuthentication({ optionsJSON });
      const verifyRes = await fetch("/api/auth/stepup/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        setError("Passkey confirmation failed. Try again, or use your password and code.");
        return;
      }
      const data = (await verifyRes.json()) as { grant: string };
      onGrant(data.grant);
    } catch {
      // startAuthentication throws when the OS prompt is dismissed / no passkey.
      setError("The passkey prompt was dismissed. Try again, or use your password and code.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithFallback(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/stepup/password-totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, totpToken }),
      });
      if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
        return;
      }
      if (res.status === 400) {
        setError("Enter both your password and your authenticator code.");
        return;
      }
      if (!res.ok) {
        // Server is deliberately generic — never reveals which factor failed.
        setError("That password or code was not accepted.");
        return;
      }
      const data = (await res.json()) as { grant: string };
      onGrant(data.grant);
    } catch {
      setError("Confirmation failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="osshp-dialog"
      aria-labelledby="stepup-title"
      aria-describedby="stepup-desc"
      tabIndex={-1}
      onClick={handleBackdropClick}
    >
      <h2 id="stepup-title" className="osshp-dialog-title">
        Confirm it&apos;s you
      </h2>
      <p id="stepup-desc" className="osshp-dialog-desc">
        For your security, confirm your identity to {actionLabel}.
      </p>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {mode === "passkey" ? (
        <div className="stack">
          <div className="osshp-dialog-actions">
            <Button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              ref={primaryBtnRef}
              type="button"
              onClick={confirmWithPasskey}
              disabled={busy}
            >
              {busy ? "Waiting for passkey…" : "Confirm with passkey"}
            </Button>
          </div>
          <p className="muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            <Button
              type="button"
              className="osshp-button--link"
              disabled={busy}
              onClick={() => {
                setMode("fallback");
                setError("");
                // Focus the first fallback field after it renders.
                setTimeout(() => passwordRef.current?.focus(), 0);
              }}
            >
              Passkey unavailable? Use your password and code
            </Button>
          </p>
        </div>
      ) : (
        <form className="stack" onSubmit={confirmWithFallback}>
          <div className="field">
            <label htmlFor="stepup-password">Password</label>
            <input
              id="stepup-password"
              ref={passwordRef}
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
            <label htmlFor="stepup-totp">Authenticator code</label>
            <input
              id="stepup-totp"
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
          <div className="osshp-dialog-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode("passkey");
                setError("");
                setTimeout(() => primaryBtnRef.current?.focus(), 0);
              }}
            >
              Back
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Confirm"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

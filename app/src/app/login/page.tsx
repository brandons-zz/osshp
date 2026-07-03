"use client";

// /login — passkey sign-in for the single admin. The default-deny middleware
// redirects unauthenticated admin-page requests here. Runs the SimpleWebAuthn
// authentication ceremony in the browser (options → navigator.credentials via
// startAuthentication → verify); on success the server rotates the session and
// sets the Secure cookie, and we land in the admin shell.

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Button } from "@/components/ui";

export default function LoginPage() {
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");

  async function signIn() {
    setStatus("working");
    setMessage("");
    try {
      const optRes = await fetch("/api/auth/login/options", { method: "POST" });
      if (optRes.status === 409) {
        setStatus("error");
        setMessage("No admin has been set up yet.");
        return;
      }
      if (!optRes.ok) throw new Error("Could not start sign-in.");
      const optionsJSON = await optRes.json();
      const response = await startAuthentication({ optionsJSON });
      const verifyRes = await fetch("/api/auth/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Sign-in could not be verified.");
      }
      window.location.assign("/admin");
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Sign-in failed.");
    }
  }

  return (
    <main className="wizard">
      <h1>Sign in</h1>
      <p className="muted">Use your passkey to access the admin.</p>
      <div className="shell-card stack">
        <Button onClick={signIn} disabled={status === "working"}>
          {status === "working" ? "Waiting for passkey…" : "Sign in with passkey"}
        </Button>
        {status === "error" ? (
          <p className="error" role="alert">
            {message} <a href="/setup">Set up this site</a>
          </p>
        ) : null}
        <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-xs)" }}>
          <a href="/login/recovery">Can&apos;t use your passkey?</a>
        </p>
      </div>
    </main>
  );
}

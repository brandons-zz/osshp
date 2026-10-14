"use client";

// Admin light/dark toggle (issue 081). The admin shell participates in the
// site's scheme system: the root layout SSRs `data-scheme` on <html> from the
// visitor's persisted choice / operator default, and appShellSchemeScript()
// resolves "auto" pre-paint. This control flips the scheme live and persists
// it with the SAME key, cookie format and storage as the public site's toggle
// (themes/editorial schemeToggleScript), so the choice survives reloads with no
// flash and is shared with the public site in this browser.
//
// The current scheme is read from <html> after mount rather than passed from
// the server: under "auto" only the client knows it (prefers-color-scheme).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { SCHEME_STORAGE_KEY } from "@/lib/theme/scheme";
import type { Scheme } from "@/lib/theme/types";

/** Pure decision, unit-testable without a DOM: the scheme a click switches to. */
export function nextScheme(current: string | null): Scheme {
  return current === "dark" ? "light" : "dark";
}

function readScheme(): Scheme {
  return document.documentElement.getAttribute("data-scheme") === "dark"
    ? "dark"
    : "light";
}

export function SchemeToggle() {
  // null until mounted: the server cannot know the scheme under "auto", so
  // render a neutral label first instead of a possibly-wrong one.
  const [scheme, setScheme] = useState<Scheme | null>(null);

  useEffect(() => {
    setScheme(readScheme());
    // Follow changes made elsewhere (the pre-paint hook tracking the OS in
    // auto mode), so the label never goes stale.
    const observer = new MutationObserver(() => setScheme(readScheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-scheme"],
    });
    return () => observer.disconnect();
  }, []);

  function toggle() {
    const next = nextScheme(readScheme());
    const root = document.documentElement;
    root.setAttribute("data-scheme", next);
    root.style.colorScheme = next;
    // An explicit choice ends "auto" OS-following for this page.
    root.removeAttribute("data-scheme-auto");
    try {
      document.cookie = `${SCHEME_STORAGE_KEY}=${next};path=/;max-age=31536000;SameSite=Lax`;
    } catch {
      // cookies unavailable — the live switch still applies
    }
    try {
      localStorage.setItem(SCHEME_STORAGE_KEY, next);
    } catch {
      // storage unavailable — the cookie still persists the choice
    }
    setScheme(next);
  }

  // A toggle button keeps a constant name ("Dark mode") and exposes its state
  // through aria-pressed (4.1.2); the On/Off text carries the same state
  // visually so it never rides on styling alone (1.4.1).
  const dark = scheme === "dark";
  return (
    <Button
      className="osshp-button--secondary shell-scheme-toggle"
      onClick={toggle}
      aria-pressed={scheme === null ? undefined : dark}
    >
      Dark mode
      <span className="shell-scheme-toggle-state" aria-hidden="true">
        {scheme === null ? "" : dark ? "On" : "Off"}
      </span>
    </Button>
  );
}

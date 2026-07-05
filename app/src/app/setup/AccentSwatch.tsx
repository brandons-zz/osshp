"use client";

// Live accent-color preview for the setup wizard (issue 005) and the admin
// Settings → Branding editor (issue 042).
//
// The swatch is decorative (aria-hidden); the hex value is shown as text so the
// selection is never conveyed by color alone (WCAG 1.4.1), and the swatch border
// (shell.css) supplies a non-text boundary in both schemes (1.4.11).
//
// issue 042 root cause: the previous version set the color via a JSX `style`
// prop, which — when this component is part of a server-rendered initial paint
// (as it is in Settings, where the accent is already known at request time) —
// serializes to a literal `style="background:#…"` ATTRIBUTE in the HTML the
// browser parses before any JS runs. The app's CSP has no `unsafe-inline` on
// `style-src` (headers.ts), so that attribute is silently dropped: the circle
// rendered white/empty even though the hex text (a separate, CSP-exempt text
// node) showed the correct value. It only worked in the setup wizard because
// that subtree never appears in the initial SSR HTML — it mounts client-side
// after the wizard moves off its "loading" step, so React's *first* commit is a
// client-side DOM creation, which sets style properties via the CSSOM
// (`style.setProperty`), not by writing the attribute string. CSP's style-src
// governs the attribute/stylesheet parse path, not CSSOM property writes — a
// browser-implemented carve-out (see headers.ts).
//
// Fix: never emit the color as a JSX style prop (so SSR output never carries a
// blocked attribute); apply it imperatively via the CSSOM in an effect instead,
// which works identically whether the component is mounted via SSR+hydration or
// pure client-side rendering.
import { useEffect, useRef } from "react";

/**
 * Pure DOM step, isolated so it's unit-testable without a real element (bun
 * test has no DOM/jsdom in this repo — see use-dialog-focus-trap.test.ts for
 * the same fake-object pattern). Uses `style.setProperty`, i.e. a CSSOM write,
 * never `setAttribute("style", …)` — the latter would reintroduce the CSP
 * violation this component exists to avoid.
 */
export function applyAccentSwatchColor(
  el: { style: { setProperty(prop: string, value: string): void } },
  value: string,
): void {
  el.style.setProperty("background", value);
}

export function AccentSwatch({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (ref.current) applyAccentSwatchColor(ref.current, value);
  }, [value]);

  return (
    <>
      <span
        ref={ref}
        className="accent-swatch"
        data-accent-value={value}
        aria-hidden="true"
      />
      <output htmlFor="accent" className="accent-value">
        {value.toUpperCase()}
      </output>
    </>
  );
}

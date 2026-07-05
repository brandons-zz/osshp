import { describe, expect, test } from "bun:test";
import {
  resolveBrandTokens,
  brandTokensToCss,
  sanitizeAccent,
  sanitizeFontFamily,
} from "../brand";
import { contrastRatio } from "../color";
import type { Scheme } from "../types";

// The AA guardrail (§7) must yield AA-safe accent tokens for ANY hue. These
// tests encode the fixed acceptance bar (§7.3), not the exact reference hexes —
// the clamp algorithm is an implementation choice, the contrast targets are not.

const SURFACES: Record<Scheme, { bg: string; surface: string }> = {
  light: { bg: "#FBFBFA", surface: "#FFFFFF" },
  dark: { bg: "#131417", surface: "#1B1C20" },
};

// Representative operator accents — Blue (reference default), Teal, Rose.
const HUES: Record<string, string> = {
  Blue: "#2563eb",
  Teal: "#0F8E72",
  Rose: "#C0396A",
};

for (const [name, accent] of Object.entries(HUES)) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${name}/${scheme}: derived accent tokens all meet their AA targets`, () => {
      const { bg, surface } = SURFACES[scheme];
      const t = resolveBrandTokens({ accent }, scheme);

      // accent-solid ≥3:1 vs surface AND bg (1.4.11).
      expect(contrastRatio(t.accentSolid, surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.accentSolid, bg)).toBeGreaterThanOrEqual(3);
      // on-accent ≥4.5:1 on the solid (1.4.3).
      expect(contrastRatio(t.onAccent, t.accentSolid)).toBeGreaterThanOrEqual(
        4.5,
      );
      // accent-text ≥4.5:1 vs bg (1.4.3).
      expect(contrastRatio(t.accentText, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
}

test("Teal-light proof case: white-on-teal fails 4.5 → dark on-accent auto-picked", () => {
  // The documented proof (design-language §6.2): on the teal solid #0F8E72,
  // white is 4.09:1 (fails 4.5) so the guardrail must auto-select the near-black.
  const teal = resolveBrandTokens({ accent: "#0F8E72" }, "light");
  // White would have failed against this solid …
  expect(contrastRatio("#FFFFFF", teal.accentSolid)).toBeLessThan(4.5);
  // … so a dark on-accent was chosen and it passes.
  expect(contrastRatio(teal.onAccent, teal.accentSolid)).toBeGreaterThanOrEqual(
    4.5,
  );
  // The picked label is the near-black, not white.
  expect(teal.onAccent.toLowerCase()).not.toBe("#ffffff");
});

test("brandTokensToCss emits both schemes and aliases --focus to --accent-text", () => {
  const css = brandTokensToCss({ accent: "#2563eb" });
  expect(css).toContain('[data-scheme="dark"]');
  expect(css).toContain("--accent-solid:");
  expect(css).toContain("--accent-text:");
  expect(css).toContain("--on-accent:");
  // --focus is the accent-text value (§5.2).
  const light = resolveBrandTokens({ accent: "#2563eb" }, "light");
  expect(css).toContain(`--focus:${light.accentText}`);
});

test("body-copy safety: the guardrail never forces the operator to use the accent for body text", () => {
  // Sanity: an extreme accent still produces a valid solid (clamp converges).
  const t = resolveBrandTokens({ accent: "#ffff00" }, "light");
  expect(contrastRatio(t.accentSolid, "#FFFFFF")).toBeGreaterThanOrEqual(3);
});

// ── CSS-injection validation at the emission boundary (owasp-audit A03-G1) ───
// The operator's accent + fonts are interpolated into a <style> block that bypasses
// the HTML sanitizer; the validation must live at the emission boundary, not only
// at the setup route. These tests prove an injection payload never reaches the CSS.

describe("brand-token emission-boundary validation (A03-G1)", () => {
  test("sanitizeAccent: valid hex passes, junk falls back to a safe default", () => {
    expect(sanitizeAccent("#2563eb")).toBe("#2563eb");
    expect(sanitizeAccent("0F8E72")).toBe("#0F8E72"); // normalized with #
    expect(sanitizeAccent("#abc")).toBe("#abc");
    // injection / malformed → safe default, never the attacker string
    for (const bad of [
      "red;}@import url(//evil)",
      "</style><script>alert(1)</script>",
      "#zzz",
      "blue",
      "",
      null,
      undefined,
    ]) {
      const out = sanitizeAccent(bad as string);
      expect(out).toBe("#2563eb");
    }
  });

  test("sanitizeFontFamily: safe families pass, injection payloads are rejected", () => {
    expect(sanitizeFontFamily('"Inter", system-ui, sans-serif')).toBe(
      '"Inter", system-ui, sans-serif',
    );
    expect(sanitizeFontFamily("Atkinson Hyperlegible")).toBe(
      "Atkinson Hyperlegible",
    );
    for (const bad of [
      "x;}@import url(//evil)",
      "</style><script>alert(1)</script>",
      "Foo;color:red",
      "Foo{bar}",
      "url(//evil)",
      "Foo\\65",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeFontFamily(bad as string)).toBeNull();
    }
  });

  test("brandTokensToCss never emits CSS-structural injection characters from a hostile font/accent", () => {
    const css = brandTokensToCss({
      accent: "red;}@import url(//evil)",
      fontHeading: "</style><script>alert(1)</script>",
      fontBody: "Foo;color:red",
    });
    // The malicious tokens must not appear; the emission falls back to safe values.
    expect(css).not.toContain("@import");
    expect(css).not.toContain("</style>");
    expect(css).not.toContain("<script");
    expect(css).not.toContain("url(//evil)");
    // a valid accent + the system font stack are emitted instead
    expect(css).toContain("--accent-solid:");
    expect(css).toContain("--brand-font-body:");
  });
});

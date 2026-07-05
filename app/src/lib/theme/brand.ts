// The app-side AA contrast guardrail (theme-rendering-contract §7,
// design-language §6.2).
//
// The operator picks ANY accent hue (settings.branding.accent). The app derives
// already-AA-safe accent tokens and hands them to the theme via
// ThemeRenderContext.brand — the theme NEVER re-derives them. Centralizing the
// guardrail in the app makes AA a property of the platform, not of each theme's
// good behavior (§7.2). Pure luminance math, no model (Karpathy rule 5); the
// exact clamp is an implementation choice, the acceptance bar is fixed (§7.3):
//   accentSolid ≥3:1 vs surface AND bg · onAccent ≥4.5:1 on accentSolid ·
//   accentText ≥4.5:1 vs bg — for any input hue, in both schemes.

import { contrastRatio, shiftLightness } from "./color";
import type { ResolvedBrandTokens, Scheme } from "./types";

/**
 * The scheme's neutral surfaces (design-language §3). The guardrail derives the
 * accent AGAINST these; neutral temperature is constrained to pre-verified sets
 * (§6.1), so the app owns these values. Layer-2 token VALUES still come from the
 * theme sheet — these are the references the guardrail measures against.
 */
const SCHEME_SURFACES: Record<Scheme, { bg: string; surface: string }> = {
  light: { bg: "#FBFBFA", surface: "#FFFFFF" },
  dark: { bg: "#131417", surface: "#1B1C20" },
};

/** On-accent label candidates (design-language §6.2(2)). */
const WHITE = "#FFFFFF";
const NEAR_BLACK = "#0E0F12";

const SYSTEM_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SYSTEM_MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// ── CSS-injection validation at the emission boundary (owasp-audit A03-G1) ───
//
// The operator's accent + fonts are interpolated VERBATIM into a <style> block
// that legitimately bypasses the HTML SanitizedHtml boundary (you cannot run CSS
// through an HTML sanitizer). Validating here — at the point the values become CSS,
// not only at the setup route — means EVERY current and future write path
// (setup, a future branding panel, import/migration) is covered by construction.
// A rejected value never reaches the <style>; it falls back to a safe default
// rather than throwing, so a single bad branding setting cannot 500 the public
// site.

/** A valid CSS hex color: #rgb or #rrggbb (the only accent shape we emit). */
const HEX_RE = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Safe fallback accent when the stored value is malformed/injected (setup default). */
const FALLBACK_ACCENT = "#2563eb";

/**
 * Allowlist for a CSS `font-family` value: letters, digits, spaces, and the
 * punctuation valid in a family list (quotes, comma, hyphen, underscore, period).
 * Anything else — `;` `{` `}` `<` `>` `@` `(` `)` `/` `\` etc. — is rejected, which
 * blocks declaration/`<style>` breakout and `@import` exfiltration (e.g.
 * `x;}@import url(//evil)`, `</style><script>…`).
 */
const FONT_SAFE_RE = /^[A-Za-z0-9 ,"'._-]+$/;

/** Clamp the accent to a valid hex (normalized with a leading #); else the default. */
export function sanitizeAccent(value: string | null | undefined): string {
  if (typeof value === "string" && HEX_RE.test(value.trim())) {
    const v = value.trim();
    return v.startsWith("#") ? v : `#${v}`;
  }
  return FALLBACK_ACCENT;
}

/**
 * Return a CSS-safe font-family value, or null if it contains any character
 * outside the allowlist (caller falls back to the system stack). Also rejects
 * empty and absurdly long values.
 */
export function sanitizeFontFamily(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v === "" || v.length > 200) return null;
  return FONT_SAFE_RE.test(v) ? v : null;
}

const STEP = 2; // lightness shift per iteration, percentage points
const MAX_ITERS = 60; // 60 * 2 = 120pp — spans the full [0,100] L range

/** In light mode darkening raises contrast vs light surfaces; dark mode lightens. */
function contrastDirection(scheme: Scheme): number {
  return scheme === "light" ? -STEP : STEP;
}

/**
 * Adjust `hex`'s lightness toward higher contrast until it meets `target` vs
 * every color in `against`. Convergent: pushing to black (light) / white (dark)
 * maximizes contrast vs the opposite-luminance surfaces.
 */
function adjustForContrast(
  hex: string,
  against: readonly string[],
  target: number,
  scheme: Scheme,
): string {
  let c = hex;
  const minContrast = () => Math.min(...against.map((a) => contrastRatio(c, a)));
  const dir = contrastDirection(scheme);
  for (let i = 0; i < MAX_ITERS && minContrast() < target; i++) {
    c = shiftLightness(c, dir);
  }
  return c;
}

/**
 * Auto-select the on-accent label color (§6.2(2)): pick whichever of white /
 * near-black yields ≥4.5:1 on the solid, preferring the higher-contrast one.
 * If neither passes (a mid-luminance solid), nudge the solid toward the better
 * candidate until it does — and return the (possibly adjusted) solid.
 *
 * This is the Teal-light proof case: white-on-teal is 4.09:1 (fails), so dark is
 * auto-picked (4.68:1 passes).
 */
function pickOnAccent(solid: string): { solid: string; onAccent: string } {
  const cWhite = contrastRatio(WHITE, solid);
  const cDark = contrastRatio(NEAR_BLACK, solid);
  if (cWhite >= 4.5 && cWhite >= cDark) return { solid, onAccent: WHITE };
  if (cDark >= 4.5) return { solid, onAccent: NEAR_BLACK };
  if (cWhite >= 4.5) return { solid, onAccent: WHITE };

  // Neither reaches 4.5 — adjust the solid toward the better candidate. White
  // needs a darker solid; near-black needs a lighter solid.
  const pickWhite = cWhite >= cDark;
  const label = pickWhite ? WHITE : NEAR_BLACK;
  const dir = pickWhite ? -STEP : STEP;
  let s = solid;
  for (let i = 0; i < MAX_ITERS && contrastRatio(label, s) < 4.5; i++) {
    s = shiftLightness(s, dir);
  }
  return { solid: s, onAccent: label };
}

export interface BrandInput {
  accent: string;
  fontHeading?: string | null;
  fontBody?: string | null;
}

/**
 * Derive the already-AA-safe accent tokens for one scheme. Body text never uses
 * the accent (it uses --text/--text-muted, always ≥7:1), so an operator's hue
 * choice can never make reading copy fail (§7.2).
 */
export function resolveBrandTokens(
  input: BrandInput,
  scheme: Scheme,
): ResolvedBrandTokens {
  const { bg, surface } = SCHEME_SURFACES[scheme];

  // Validate at the emission boundary (A03-G1): a malformed/injected accent or
  // font is rejected here, before it can reach the inline <style>.
  const accent = sanitizeAccent(input.accent);

  // 1. accent-solid: ≥3:1 vs the surface it sits on AND the page bg (1.4.11).
  const solid0 = adjustForContrast(accent, [surface, bg], 3.0, scheme);
  // 2. on-accent: auto white / near-black ≥4.5:1 on the solid (may nudge solid).
  const { solid, onAccent } = pickOnAccent(solid0);
  // 3. accent-text: link text ≥4.5:1 vs the page bg (1.4.3). Derived from the
  //    operator's accent, not the clamped solid (§6.2(3)).
  const accentText = adjustForContrast(accent, [bg], 4.5, scheme);

  const fontBody = sanitizeFontFamily(input.fontBody) || SYSTEM_FONT_STACK;
  const fontHeading = sanitizeFontFamily(input.fontHeading) || fontBody;
  return {
    accentSolid: solid,
    accentText,
    onAccent,
    fontHeading,
    fontBody,
    fontMono: SYSTEM_MONO_STACK,
  };
}

/**
 * Emit the Layer-3 brand tokens for BOTH schemes as CSS so a visitor scheme
 * toggle is a pure `data-scheme` attribute flip with no re-derivation (§6).
 * --focus aliases --accent-text (§5.2). Fonts are scheme-independent.
 */
export function brandTokensToCss(input: BrandInput): string {
  const block = (sel: string, t: ResolvedBrandTokens) =>
    `${sel}{` +
    `--accent-solid:${t.accentSolid};` +
    `--accent-text:${t.accentText};` +
    `--on-accent:${t.onAccent};` +
    `--focus:${t.accentText};` +
    `--brand-font-heading:${t.fontHeading};` +
    `--brand-font-body:${t.fontBody};` +
    `--font-mono:${t.fontMono};` +
    `}`;
  const light = resolveBrandTokens(input, "light");
  const dark = resolveBrandTokens(input, "dark");
  // Default (no data-scheme yet) uses light; explicit attributes override.
  return (
    block(':root,:root[data-scheme="light"]', light) +
    block(':root[data-scheme="dark"]', dark)
  );
}

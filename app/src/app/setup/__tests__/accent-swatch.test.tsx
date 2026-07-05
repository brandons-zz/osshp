import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccentSwatch, applyAccentSwatchColor } from "../AccentSwatch";

// Intent (issue 005): after picking an accent the operator gets a visible
// confirmation of the exact color — the swatch reflects the chosen value and the
// hex is shown as text (so the info is not carried by color alone, WCAG 1.4.1).
//
// issue 042: the swatch previously carried the color as a JSX `style` prop,
// which — when this component is part of a server-rendered initial paint (as
// in Settings, where the value is known at request time) — serializes to a
// literal `style=""` HTML attribute. The app's CSP has no `unsafe-inline` on
// `style-src` (src/lib/security/headers.ts), so that attribute is dropped and
// the circle rendered white/empty. The fix never emits the color via a style
// prop; it applies it imperatively via the CSSOM (`style.setProperty`) after
// mount, which is exempt from `style-src`. These tests pin both halves: the
// SSR markup carries no style attribute, and the CSSOM step itself is correct.

describe("setup/settings accent swatch (issue 005, CSP fix issue 042)", () => {
  test("SSR markup carries the value as data, never as an inline style attribute", () => {
    const html = renderToStaticMarkup(<AccentSwatch value="#0F8E72" />);
    // No style="" attribute anywhere in the swatch markup — CSP style-src (no
    // unsafe-inline) would silently drop it, reproducing issue 042.
    expect(html).not.toContain("style=");
    // The value still travels with the initial markup, as data (unaffected by
    // CSP), so the post-mount effect has something to read.
    expect(html).toContain('data-accent-value="#0F8E72"');
    // the value is also shown as text (not color-only)
    expect(html).toContain("0F8E72");
    // decorative swatch is hidden from AT; the <output> carries the readable value
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<output");
  });

  test("a different pick updates the displayed value", () => {
    const html = renderToStaticMarkup(<AccentSwatch value="#c0396a" />);
    expect(html).toContain('data-accent-value="#c0396a"');
    expect(html).toContain("C0396A"); // uppercased for display
  });

  test("applyAccentSwatchColor sets the swatch background via the CSSOM, not an attribute string", () => {
    const calls: Array<[string, string]> = [];
    const fakeEl = {
      style: {
        setProperty(prop: string, value: string) {
          calls.push([prop, value]);
        },
      },
    };
    applyAccentSwatchColor(fakeEl, "#FF6A00");
    expect(calls).toEqual([["background", "#FF6A00"]]);
  });
});

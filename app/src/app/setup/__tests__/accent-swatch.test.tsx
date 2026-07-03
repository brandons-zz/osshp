import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccentSwatch } from "../AccentSwatch";

// Intent (issue 005): after picking an accent the operator gets a visible
// confirmation of the exact color — the swatch reflects the chosen value and the
// hex is shown as text (so the info is not carried by color alone, WCAG 1.4.1).

describe("setup accent swatch (issue 005)", () => {
  test("swatch reflects the chosen color and shows its hex value", () => {
    const html = renderToStaticMarkup(<AccentSwatch value="#0F8E72" />);
    // the chosen color drives the swatch fill
    expect(html).toContain("background:#0F8E72");
    // the value is also shown as text (not color-only)
    expect(html).toContain("0F8E72");
    // decorative swatch is hidden from AT; the <output> carries the readable value
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<output");
  });

  test("a different pick updates the displayed value", () => {
    const html = renderToStaticMarkup(<AccentSwatch value="#c0396a" />);
    expect(html).toContain("background:#c0396a");
    expect(html).toContain("C0396A"); // uppercased for display
  });
});

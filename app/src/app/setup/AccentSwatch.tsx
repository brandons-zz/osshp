// Live accent-color preview for the setup wizard (issue 005).
//
// The swatch is decorative (aria-hidden); the hex value is shown as text so the
// selection is never conveyed by color alone (WCAG 1.4.1), and the swatch border
// (shell.css) supplies a non-text boundary in both schemes (1.4.11). The dynamic
// color is applied via React on the client — this sub-tree renders only after the
// wizard transitions past the "loading" step — so it sets the swatch color through
// the CSSOM and needs no inline-style CSP exception.

export function AccentSwatch({ value }: { value: string }) {
  return (
    <>
      <span
        className="accent-swatch"
        style={{ background: value }}
        aria-hidden="true"
      />
      <output htmlFor="accent" className="accent-value">
        {value.toUpperCase()}
      </output>
    </>
  );
}

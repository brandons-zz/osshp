// Step-up UI wiring (A1 / D14) — structural contract + wiring source-scan.
//
// The interaction behavior (focus trap, Esc, the WebAuthn ceremony) is
// browser-native and re-gated live by Val; these tests pin the structural AA
// contract of the StepUpDialog and the fact that EVERY credential-change action in
// AccountSecurityForm first obtains a step-up grant and sends it on the
// x-osshp-stepup-grant header (the wiring that was missing and caused every form to
// silently 403).

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepUpDialog } from "../StepUpDialog";

function noop() {}

describe("StepUpDialog — structural AA contract (D14)", () => {
  const html = renderToStaticMarkup(
    <StepUpDialog
      open
      actionLabel="change your password"
      onGrant={noop}
      onCancel={noop}
    />,
  );

  test("renders a native <dialog> with the osshp-dialog kernel chrome", () => {
    expect(html).toContain("<dialog");
    expect(html).toContain("osshp-dialog");
  });

  test("is named and described via aria-labelledby/aria-describedby (4.1.2)", () => {
    expect(html).toContain('aria-labelledby="stepup-title"');
    expect(html).toContain('aria-describedby="stepup-desc"');
    expect(html).toContain('id="stepup-title"');
    expect(html).toContain('id="stepup-desc"');
  });

  test("names the action in the description", () => {
    expect(html).toContain("change your password");
  });

  test("passkey-primary: the primary action is the passkey confirm (D14)", () => {
    expect(html).toContain("Confirm with passkey");
    // The fallback is exposed only behind an explicit, link-styled affordance…
    expect(html).toContain("osshp-button--link");
    expect(html).toContain("Passkey unavailable");
    // …and the password/TOTP fields are NOT shown until it is chosen (mode=passkey
    // is the initial render).
    expect(html).not.toContain('id="stepup-password"');
    expect(html).not.toContain('id="stepup-totp"');
  });

  test("offers a Cancel affordance", () => {
    expect(html).toContain("Cancel");
  });
});

describe("AccountSecurityForm — every credential action is step-up-gated + sends the grant header", () => {
  const src = readFileSync(join(import.meta.dir, "../AccountSecurityForm.tsx"), "utf8");

  test("the grant header constant is the design's header name", () => {
    expect(src).toContain('const GRANT_HEADER = "x-osshp-stepup-grant"');
  });

  test("each of the five gated actions requests a step-up grant first", () => {
    for (const label of [
      "change your password",
      "set up a new authenticator", // TOTP begin (mutating)
      "regenerate your recovery codes",
      "add a passkey", // register/options step-up
      "remove this passkey",
    ]) {
      expect(src).toContain(`requestStepUp("${label}")`);
    }
  });

  test("exactly the five gated requests carry the grant header (confirm/verify do not)", () => {
    // [GRANT_HEADER]: grant appears once per gated fetch — five total. The TOTP
    // PUT (confirm) and register/verify are self-gated and MUST NOT carry it.
    const matches = src.match(/\[GRANT_HEADER\]:\s*grant/g);
    expect(matches?.length).toBe(5);
  });

  test("each gated action handles the uniform 403 (grant expired/consumed) gracefully", () => {
    // Every gated fetch checks res.status === 403 and shows the expired message
    // instead of leaving a dead form.
    expect(src).toContain("EXPIRED_MSG");
    expect(src.match(/res\.status === 403|optRes\.status === 403/g)?.length).toBe(5);
  });
});

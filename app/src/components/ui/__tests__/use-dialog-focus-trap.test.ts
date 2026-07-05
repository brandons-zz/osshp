// Unit test for the modal focus-trap WRAP logic (issue 037 defect 5).
//
// The native <dialog> does not reliably wrap focus backward in this build, so the
// shell installs an explicit trap. The pure decision — given the focusable set,
// the active element, and Shift — is nextTrapTarget(); it is what makes the wrap
// correct in BOTH directions. jsdom can't model the native modal, but this pure
// function is the load-bearing logic and is fully testable.

import { expect, test, describe } from "bun:test";
import { nextTrapTarget } from "../use-dialog-focus-trap";

// Minimal stand-ins for focusable elements (nextTrapTarget only compares identity).
function makeEls(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => ({ id: `e${i}` }) as unknown as HTMLElement);
}

describe("nextTrapTarget — two-direction focus wrap", () => {
  test("Shift+Tab on the FIRST focusable wraps to the LAST", () => {
    const els = makeEls(3);
    expect(nextTrapTarget(els, els[0], true)).toBe(els[2]);
  });

  test("Tab on the LAST focusable wraps to the FIRST", () => {
    const els = makeEls(3);
    expect(nextTrapTarget(els, els[2], false)).toBe(els[0]);
  });

  test("Tab in the middle → null (let the browser move interior focus)", () => {
    const els = makeEls(3);
    expect(nextTrapTarget(els, els[1], false)).toBeNull();
    expect(nextTrapTarget(els, els[1], true)).toBeNull();
  });

  test("Shift+Tab on the last, Tab on the first → null (no wrap needed)", () => {
    const els = makeEls(3);
    expect(nextTrapTarget(els, els[2], true)).toBeNull();
    expect(nextTrapTarget(els, els[0], false)).toBeNull();
  });

  test("single focusable: Tab and Shift+Tab both keep it (first === last)", () => {
    const els = makeEls(1);
    expect(nextTrapTarget(els, els[0], false)).toBe(els[0]);
    expect(nextTrapTarget(els, els[0], true)).toBe(els[0]);
  });

  test("empty focusable set → null (nothing to focus)", () => {
    expect(nextTrapTarget([], null, false)).toBeNull();
    expect(nextTrapTarget([], null, true)).toBeNull();
  });

  test("focus not on a boundary element → null", () => {
    const els = makeEls(3);
    const outsider = { id: "x" } as unknown as HTMLElement;
    expect(nextTrapTarget(els, outsider, false)).toBeNull();
    expect(nextTrapTarget(els, outsider, true)).toBeNull();
  });
});

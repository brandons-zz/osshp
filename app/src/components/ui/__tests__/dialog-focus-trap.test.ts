// Regression guard for the app-wide modal focus trap (issue 037 defect 5).
//
// Root cause found via a prod-build browser probe: a modal <dialog> with
// scrollable overflow (the .osshp-dialog / .media-dialog shells) becomes a
// keyboard-focusable SCROLL CONTAINER in Chromium, so the bare dialog element
// enters the Tab order as a spurious, non-interactive stop (Shift+Tab "lands on
// the dialog element"). The fix is twofold and both halves are pinned here:
//   1. Every dialog opens MODALLY via showModal() — a non-modal open does NOT
//      trap focus (focus escapes to <body>).
//   2. Every dialog carries tabIndex={-1} so the element is out of the sequential
//      Tab order while remaining programmatically focusable for showModal().
//
// A source scan (like admin-layout-core-links.test.ts) pins the invariant across
// ALL dialog shells without a browser: the trap itself is browser-native and was
// verified at runtime in a production build.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, describe } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..", "..");

const DIALOG_SOURCES: Array<{ name: string; path: string }> = [
  { name: "ConfirmDialog", path: "components/ui/confirm-dialog.tsx" },
  { name: "MarkdownHelp", path: "components/ui/markdown-help.tsx" },
  { name: "MediaPicker", path: "components/media/MediaPicker.tsx" },
  { name: "MediaDetail", path: "app/admin/media/MediaDetail.tsx" },
];

describe("modal dialog focus trap (issue 037 defect 5)", () => {
  for (const { name, path } of DIALOG_SOURCES) {
    const src = readFileSync(join(ROOT, path), "utf8");
    // Strip line comments so docstring mentions ("<dialog showModal()>") don't
    // satisfy or trip the code-level assertions below.
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    test(`${name} opens the dialog modally via showModal()`, () => {
      expect(code).toContain("dialog.showModal()");
      // A non-modal open (.show() or a JSX `open` attribute) would NOT trap.
      expect(code).not.toContain(".show()");
      expect(code).not.toMatch(/<dialog[^>]*\sopen[=\s>]/);
    });

    test(`${name} sets tabIndex={-1} on the <dialog> (out of the Tab order)`, () => {
      expect(code).toContain("tabIndex={-1}");
    });

    test(`${name} installs the shared two-direction focus trap`, () => {
      // Native <dialog> does not reliably wrap backward — every shell must use
      // the shared useDialogFocusTrap hook (defect 5).
      expect(code).toContain("useDialogFocusTrap(dialogRef)");
    });
  }
});

"use client";

// Shared modal-dialog focus trap (issue 037 defect 5).
//
// Native <dialog showModal()> establishes a top-layer modal, but in this build
// Chromium does NOT reliably wrap focus BACKWARD: a single Shift+Tab from the
// first focusable control escapes to <body> instead of wrapping to the last
// control. (Forward Tab from the last wraps, but we handle it here too for
// symmetry.) So the trap cannot be left "browser-native" — this hook adds the
// explicit keydown wrap that every dialog shell shares:
//   - Tab on the LAST focusable → focus the FIRST (preventDefault).
//   - Shift+Tab on the FIRST focusable → focus the LAST (preventDefault).
// Interior Tab moves are left to the browser. tabIndex={-1} stays on the <dialog>
// element (keeps it out of the Tab order) and showModal() stays (top-layer + Esc
// + backdrop + inertness of the rest of the page).
//
// Stacked dialogs (MediaDetail → its sibling ConfirmDialog): the listener is on
// EACH dialog element and only fires for keydowns within that dialog. When the
// confirm opens on top, focus is confined to it (native), so its keydowns bubble
// to its own element — the topmost open dialog traps, the one underneath is
// dormant. The handler also no-ops unless this dialog is actually open.

import { useEffect, type RefObject } from "react";

// Standard focusable selector; excludes disabled controls and anything
// explicitly removed from the tab order (tabindex="-1", incl. the <dialog>).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable=false])",
].join(",");

/** Visible, enabled, focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // Rendered (not display:none / detached). getClientRects is empty for hidden.
    return el.getClientRects().length > 0;
  });
}

/**
 * Pure trap logic: given the focusable set, the currently-focused element, and
 * whether Shift is held, return the element to focus to WRAP, or null if the
 * browser's default interior move should stand. Unit-testable without a DOM.
 */
export function nextTrapTarget(
  focusables: readonly HTMLElement[],
  active: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (shiftKey) {
    // Shift+Tab on the first (or focus already lost) → wrap to the last.
    if (active === first) return last;
  } else {
    // Tab on the last → wrap to the first.
    if (active === last) return first;
  }
  return null;
}

/**
 * Install the explicit two-direction focus trap on a modal <dialog>. Attach once
 * per dialog shell; it self-gates on `dialog.open`, so a shell that opens via a
 * prop OR imperatively (MarkdownHelp) is covered without an extra open flag.
 */
export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLDialogElement | null>,
): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialog!.open) return;
      const focusables = getFocusableElements(dialog!);
      const target = nextTrapTarget(focusables, document.activeElement, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [dialogRef]);
}

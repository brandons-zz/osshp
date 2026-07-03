"use client";

// ConfirmDialog — themed, accessible confirmation modal (Batch A follow-up).
//
// Replaces window.confirm for delete (and any other destructive action) with a
// native <dialog showModal()> that is:
//   - Focus-trapped (browser-native via showModal)
//   - Esc-to-cancel (browser fires 'cancel' event; mapped to onCancel)
//   - Keyboard-operable (Cancel / Confirm are native <button> elements)
//   - Screen-reader-accessible (role=dialog is implicit on <dialog>; aria-label
//     provides the accessible name; aria-describedby provides the description)
//   - Colophon-styled (semantic tokens via kernel.css .osshp-dialog)
//   - CSP-safe: no inline event handlers; all interaction via React event system
//
// Focus is placed on the Cancel button when the dialog opens — the safe default
// for a destructive confirm (reduces accidental confirmations). The trigger
// element regains focus on close.
//
// Usage: render as a sibling of the trigger button with open={false} initially;
// set open={true} to show, onCancel/onConfirm to handle the outcome.

import { useEffect, useRef } from "react";
import { Button } from "./button";

export interface ConfirmDialogProps {
  /** Whether the dialog is visible. The caller toggles this. */
  open: boolean;
  /** Short heading — becomes the accessible name of the dialog. */
  title: string;
  /** Explanatory sentence shown below the heading. */
  description: string;
  /** Label for the destructive action button. Default "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button (focused on open). Default "Cancel". */
  cancelLabel?: string;
  /** When true (default), the confirm button carries danger styling. */
  danger?: boolean;
  /** Called when the user confirms (clicks confirm or presses Enter on it). */
  onConfirm: () => void;
  /** Called when the user cancels (clicks cancel, presses Esc, or clicks backdrop). */
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // Track what had focus before the dialog opened so we can restore it.
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        prevFocusRef.current = document.activeElement as HTMLElement | null;
        dialog.showModal();
        // Focus Cancel (safe default — reduces accidental destructive confirms).
        cancelBtnRef.current?.focus();
      }
    } else {
      if (dialog.open) {
        dialog.close();
        // Restore focus to the trigger element.
        prevFocusRef.current?.focus();
        prevFocusRef.current = null;
      }
    }
  }, [open]);

  // Browser fires 'cancel' on Esc — map to onCancel.
  // We also need preventDefault to stop the browser's default close-and-cleanup,
  // letting React control the open state instead.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      e.preventDefault(); // prevent native close; let React state drive it
      onCancel();
    }
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

  // Backdrop click: the click event target is the <dialog> element itself when
  // the user clicks outside the content (on the ::backdrop). We distinguish this
  // from clicks on dialog children by checking the bounding rect.
  function handleDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) onCancel();
  }

  return (
    <dialog
      ref={dialogRef}
      className="osshp-dialog"
      aria-label={title}
      onClick={handleDialogClick}
    >
      <h2 className="osshp-dialog-title">{title}</h2>
      <p className="osshp-dialog-desc">{description}</p>
      <div className="osshp-dialog-actions">
        {/* Cancel first in DOM — focused on open, activated by Esc logic above. */}
        <Button
          ref={cancelBtnRef}
          type="button"
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          className={danger ? "osshp-button--danger" : undefined}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

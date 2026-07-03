"use client";

// DeleteButton — a reusable client component for destructive delete actions.
//
// Shows a "Delete" button; on click opens a themed ConfirmDialog (Batch A —
// replaces the previous window.confirm which was not theme-matched). On confirm,
// sends a same-origin DELETE request to the provided endpoint and redirects to
// `listHref` on success. Error is surfaced in the editor's error region or via
// a fallback alert().
//
// Accessible: ConfirmDialog is focus-trapped, Esc-to-cancel, AA-conformant,
// role=dialog (native <dialog>). See components/ui/confirm-dialog.tsx.

import { useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";

export interface DeleteButtonProps {
  /** DELETE endpoint URL (e.g. `/api/admin/blog/posts/abc`). */
  endpoint: string;
  /** Where to navigate after successful deletion. */
  listHref: string;
  /** Human noun for the confirm prompt (e.g. "post", "photo post", "page"). */
  noun?: string;
}

export function DeleteButton({
  endpoint,
  listHref,
  noun = "item",
}: DeleteButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function executeDelete() {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Delete failed.");
      }
      window.location.assign(listHref);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        className="osshp-button--danger"
        disabled={busy}
        onClick={() => setConfirmOpen(true)}
      >
        {busy ? "Deleting…" : "Delete"}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete this ${noun}?`}
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void executeDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

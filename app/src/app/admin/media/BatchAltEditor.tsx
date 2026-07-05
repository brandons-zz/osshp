"use client";

// BatchAltEditor — a step-through alt-text editor for the media library's bulk
// selection (issue 057). Alt is PER IMAGE (not "one alt for all"), so the fast
// workflow is: show one selected image at a time with its alt field, Save & next,
// until the set is done. This is far quicker than opening each detail dialog.
//
// UX CHOICE (flagged for owner live review): a step-through editor was chosen
// over an inline column of alt fields because (a) it keeps a large image visible
// while you describe it — better alt quality — and (b) it scales to 26+ images
// without a wall of inputs. An inline-list variant is the main alternative.
//
// Reuses the native <dialog showModal()> shell + shared focus trap (same as
// MediaDetail): focus trap, Esc, focus restoration. Saves through the EXISTING
// PATCH /api/admin/media/[id] endpoint (one request per image). Robust to a
// single save failing — the error is surfaced and the step is not advanced.
//
// Accessible: focus-trapped dialog; the alt input is labelled and gets initial
// focus; progress + save state are announced via aria-live; buttons are native.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { useDialogFocusTrap } from "@/components/ui/use-dialog-focus-trap";
import { type MediaItem, previewUrl } from "@/components/media/types";

export function BatchAltEditor({
  items,
  onUpdated,
  onClose,
}: {
  items: MediaItem[];
  onUpdated: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const altInputRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useDialogFocusTrap(dialogRef);

  const [index, setIndex] = useState(0);
  const [alt, setAlt] = useState(items[0]?.alt ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const current = items[index];
  const atLast = index >= items.length - 1;

  // Open the modal; restore focus on unmount.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    altInputRef.current?.focus();
    function handleCancel(e: Event) {
      e.preventDefault();
      onClose();
    }
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      prevFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the step changes, load that image's current alt into the field.
  function goto(next: number) {
    const clamped = Math.max(0, Math.min(items.length - 1, next));
    setIndex(clamped);
    setAlt(items[clamped]?.alt ?? "");
    setError("");
    setStatus("");
    altInputRef.current?.focus();
  }

  async function save(): Promise<boolean> {
    if (!current) return false;
    setError("");
    setSaving(true);
    setStatus("Saving…");
    try {
      const res = await fetch(`/api/admin/media/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alt }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Could not save.");
      }
      const updated = (await res.json()) as MediaItem;
      onUpdated(updated);
      setStatus("Saved");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      setStatus("");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndAdvance() {
    const ok = await save();
    if (!ok) return; // surface the error; do not advance past a failed save
    if (atLast) onClose();
    else goto(index + 1);
  }

  if (!current) return null;
  const emptyAlt = current.alt.trim() === "";

  return (
    <dialog
      ref={dialogRef}
      className="osshp-dialog media-dialog"
      aria-label="Edit alt text for selected images"
      tabIndex={-1}
    >
      <div className="osshp-dialog-header">
        <h2 className="osshp-dialog-title">Edit alt text</h2>
        <Button type="button" aria-label="Close" onClick={onClose}>
          ✕
        </Button>
      </div>

      <p className="batch-alt__progress" role="status" aria-live="polite">
        Image {index + 1} of {items.length}
        {emptyAlt ? " — needs a description" : ""}
      </p>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="media-dialog__preview"
        src={previewUrl(current)}
        alt={current.alt || "Selected image, no description yet"}
      />

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <span className="media-saved" role="status" aria-live="polite">
        {status}
      </span>

      <div className="field">
        <label htmlFor="batch-alt-input">Alt text</label>
        <input
          ref={altInputRef}
          id="batch-alt-input"
          value={alt}
          onChange={(e) => {
            setAlt(e.target.value);
            setStatus("");
          }}
          placeholder="Describe the image"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void saveAndAdvance();
            }
          }}
        />
      </div>

      <div className="osshp-dialog-actions batch-alt__actions">
        <Button
          type="button"
          disabled={saving || index === 0}
          onClick={() => goto(index - 1)}
        >
          Previous
        </Button>
        <Button
          type="button"
          disabled={saving || atLast}
          onClick={() => goto(index + 1)}
        >
          Skip
        </Button>
        <Button type="button" disabled={saving} onClick={() => void saveAndAdvance()}>
          {saving ? "Saving…" : atLast ? "Save & finish" : "Save & next"}
        </Button>
      </div>
    </dialog>
  );
}

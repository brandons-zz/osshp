"use client";

// MediaDetail — the per-item detail dialog for the media library (issue 037 §2.3).
//
// Reuses the native <dialog showModal()> focus-trap shell (design §2.3/§8) rather
// than a hand-rolled drawer: focus trap, Esc, backdrop-click, focus restoration
// for free. Contents, in manage-priority order: larger preview, EXIF-stripped
// reassurance + metadata, inline alt edit (PATCH, quiet aria-live "Saved"),
// replace (rewrites references everywhere — §7), a "Used by" reference list
// (GET …/usage), and a usage-aware delete with an honest "Delete anyway" force
// path (§2.4). Initial focus lands on the alt input (the primary manage action),
// never the destructive control.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, ImageDropzone, Link } from "@/components/ui";
import { useDialogFocusTrap } from "@/components/ui/use-dialog-focus-trap";
import {
  type MediaItem,
  type MediaUsageRef,
  previewUrl,
} from "@/components/media/types";

export interface MediaDetailProps {
  item: MediaItem;
  onClose: () => void;
  onUpdated: (item: MediaItem) => void;
  onDeleted: (id: string) => void;
}

export function MediaDetail({
  item,
  onClose,
  onUpdated,
  onDeleted,
}: MediaDetailProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const altInputRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Explicit two-direction focus trap (defect 5). When the sibling ConfirmDialog
  // opens on top, focus is confined to it (native), so this dialog's keydowns
  // are dormant and the confirm's own trap takes over.
  useDialogFocusTrap(dialogRef);

  const [alt, setAlt] = useState(item.alt);
  const [savingAlt, setSavingAlt] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState(""); // aria-live status text
  const [error, setError] = useState("");

  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const [usage, setUsage] = useState<MediaUsageRef[]>([]);
  const [usageLoaded, setUsageLoaded] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Open the modal on mount; restore focus to the trigger on unmount/close.
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

  // Load the where-used list once when opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/media/${item.id}/usage`);
        if (!res.ok) return;
        const data = (await res.json()) as { usage: MediaUsageRef[] };
        if (!cancelled) setUsage(data.usage);
      } catch {
        // Non-fatal — the delete gate still runs server-side.
      } finally {
        if (!cancelled) setUsageLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  function handleDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) onClose();
  }

  async function saveAlt() {
    setError("");
    setSaved(false);
    setSavingAlt(true);
    setStatus("Saving…");
    try {
      const res = await fetch(`/api/admin/media/${item.id}`, {
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
      setSaved(true);
      setStatus("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      setStatus("");
    } finally {
      setSavingAlt(false);
    }
  }

  async function handleReplace(file: File) {
    setError("");
    setReplacing(true);
    setStatus("Replacing…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/admin/media/${item.id}/replace`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Replace failed.");
      }
      const updated = (await res.json()) as MediaItem;
      onUpdated(updated);
      setShowReplace(false);
      setStatus("Replaced");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replace failed.");
      setStatus("");
    } finally {
      setReplacing(false);
    }
  }

  async function executeDelete(force: boolean) {
    setError("");
    setDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/admin/media/${item.id}${force ? "?force=1" : ""}`,
        { method: "DELETE" },
      );
      if (res.status === 204) {
        onDeleted(item.id);
        return;
      }
      // Should not normally reach here (the client gates on usageCount first),
      // but honour a server 409 by surfacing the block.
      if (res.status === 409) {
        const data = (await res.json().catch(() => ({}))) as {
          usage?: MediaUsageRef[];
        };
        if (data.usage) setUsage(data.usage);
        setError("This image is in use — use “Delete anyway” to force removal.");
        setDeleting(false);
        return;
      }
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? "Delete failed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setDeleting(false);
    }
  }

  const inUse = item.usageCount > 0;
  const busy = savingAlt || replacing || deleting;

  const uploaded = useMemo(() => {
    const d = new Date(item.createdAt);
    return Number.isNaN(d.getTime()) ? item.createdAt : d.toLocaleString();
  }, [item.createdAt]);

  const usageSummary = usage.map((u) => u.title || u.slug).join(", ");

  return (
    <>
    <dialog
      ref={dialogRef}
      className="osshp-dialog media-dialog"
      aria-label="Media details"
      // tabIndex=-1: keep the scrollable modal <dialog> out of the Tab order
      // (see confirm-dialog.tsx — defect 5). The detail dialog scrolls (tall
      // content), so without this the bare <dialog> becomes a spurious tab stop.
      tabIndex={-1}
      onClick={handleDialogClick}
    >
      <div className="osshp-dialog-header">
        <h2 className="osshp-dialog-title">Media details</h2>
        <Button type="button" aria-label="Close" onClick={onClose}>
          ✕
        </Button>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="media-dialog__preview" src={previewUrl(item)} alt={item.alt} />

      <div className="media-meta">
        {item.width && item.height ? (
          <span>
            {item.width}×{item.height}px
          </span>
        ) : null}
        {item.mimeType ? <span>{item.mimeType}</span> : null}
        <span>Uploaded {uploaded}</span>
        {item.exifStripped ? <span>EXIF stripped ✓</span> : null}
        <code>{item.url}</code>
      </div>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <span className="media-saved" role="status" aria-live="polite">
        {status}
      </span>

      {/* Inline alt edit — the primary manage action, so it is first. */}
      <div className="media-section">
        <div className="field">
          <label htmlFor="detail-alt">Alt text</label>
          <input
            ref={altInputRef}
            id="detail-alt"
            value={alt}
            onChange={(e) => {
              setAlt(e.target.value);
              setSaved(false);
            }}
            placeholder="Describe the image"
          />
        </div>
        <Button type="button" disabled={busy} onClick={() => void saveAlt()}>
          {savingAlt ? "Saving…" : saved ? "Saved" : "Save alt text"}
        </Button>
      </div>

      {/* Replace — rewrites references everywhere the image is used (§7). */}
      <div className="media-section">
        <h3>Replace</h3>
        {showReplace ? (
          <>
            <p className="field-hint">Replaces this image everywhere it is used.</p>
            <ImageDropzone
              id="detail-replace-file"
              onFile={(f) => void handleReplace(f)}
              busy={replacing}
              dropLabel="Drag a replacement image here, or"
            />
            <Button
              type="button"
              disabled={replacing}
              onClick={() => setShowReplace(false)}
            >
              Cancel replace
            </Button>
          </>
        ) : (
          <Button type="button" disabled={busy} onClick={() => setShowReplace(true)}>
            Replace image…
          </Button>
        )}
      </div>

      {/* Used by — the usage indicator + where-used list. */}
      <div className="media-section">
        <h3>Used by</h3>
        {!usageLoaded ? (
          <p className="muted">Checking…</p>
        ) : usage.length === 0 ? (
          <p className="muted">Not used yet.</p>
        ) : (
          <ul className="media-usage-list">
            {usage.map((u) => (
              <li key={`${u.type}-${u.id}-${u.field}`}>
                <Link href={u.adminHref}>
                  {u.title || u.slug}
                </Link>{" "}
                <span className="muted">
                  ({u.type} · {u.field})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Delete — usage-aware (§2.4). */}
      <div className="osshp-dialog-actions">
        <Button
          type="button"
          className="osshp-button--danger"
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </dialog>

    {/* Rendered as a SIBLING of the detail <dialog>, NOT nested inside it:
        nesting native modal <dialog>s breaks Chromium's focus-trap boundary
        (QA finding 5). As a sibling, each dialog traps focus cleanly and the
        confirm restores focus to the Delete trigger on close. */}
    <ConfirmDialog
      open={deleteOpen}
      title={inUse ? "Delete image in use?" : "Delete image?"}
      description={
        inUse
          ? `This image will be REMOVED from the ${item.usageCount} ${
              item.usageCount === 1 ? "item" : "items"
            } using it${
              usageSummary ? ` (${usageSummary})` : ""
            } — its cover is cleared and its inline images are stripped from those pages. This cannot be undone.`
          : "This cannot be undone."
      }
      confirmLabel={inUse ? "Delete anyway" : "Delete"}
      cancelLabel="Cancel"
      danger
      onConfirm={() => void executeDelete(inUse)}
      onCancel={() => setDeleteOpen(false)}
    />
    </>
  );
}

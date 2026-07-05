"use client";

// MediaPicker — the one shared in-editor image picker (issue 037 §3).
//
// Three entry points, one component: post body, page body (insert-into-body),
// and the cover/photograph slot (set-cover). Two modes selected by tabs:
//   - Choose existing — the shared MediaGrid as a single-select listbox; the alt
//     field is pre-filled from the selected image's stored alt and is editable
//     (context-dependent alt is captured into the content, §6). Empty alt is a
//     nudge, not a block (§6, consistent with the cover UX).
//   - Upload new — the owned ImageDropzone driving the shared uploadImage() path
//     (the same POST /api/admin/media the cover dropzone uses). On success the
//     mode's action fires immediately (one step, matching today's cover flow).
//
// Built on the SAME native <dialog showModal()> focus-trap shell as ConfirmDialog
// (design §3 / §8): browser-native focus containment, Esc-to-close, backdrop
// click, and focus restoration to the trigger — never hand-rolled. Default mode
// is "Choose existing" when the library is non-empty (reuse is the whole point),
// else "Upload new".

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ImageDropzone } from "@/components/ui";
import { uploadImage } from "@/lib/client/upload-image";
import { useDialogFocusTrap } from "@/components/ui/use-dialog-focus-trap";
import { MediaGrid } from "./MediaGrid";
import type { MediaItem } from "./types";

export interface MediaPickerProps {
  open: boolean;
  title: string;
  /** Primary confirm label: "Insert" (body) / "Use as cover" (cover) / "Done". */
  primaryLabel: string;
  onSelect: (picked: { url: string; alt: string }) => void;
  onClose: () => void;
  /**
   * Multi-select mode (issue 047 gallery bulk-add). When true, the picker shows
   * only the library as an aria-multiselectable grid and adds every chosen image
   * at once via onSelectMany (uploads go through the gallery manager's own bulk
   * dropzone, so the Upload tab is hidden here). Single-select behavior (onSelect)
   * is unchanged when false/omitted.
   */
  multiple?: boolean;
  onSelectMany?: (picked: MediaItem[]) => void;
}

type Mode = "choose" | "upload";

export function MediaPicker({
  open,
  title,
  primaryLabel,
  onSelect,
  onClose,
  multiple = false,
  onSelectMany,
}: MediaPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstTabRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Explicit two-direction focus trap (defect 5).
  useDialogFocusTrap(dialogRef);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("choose");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi-select set (issue 047) — ids of the images chosen for the gallery.
  const [multiPicked, setMultiPicked] = useState<string[]>([]);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  // Fetch the library each time the picker opens (so a just-uploaded image from
  // elsewhere shows up). Reset transient state on open.
  useEffect(() => {
    if (!open) return;
    setError("");
    setSelectedId(null);
    setMultiPicked([]);
    setAlt("");
    setLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/media");
        if (!res.ok) throw new Error("Could not load the media library.");
        const data = (await res.json()) as { items: MediaItem[] };
        if (cancelled) return;
        setItems(data.items);
        // Multi-select (gallery) is library-only; always the choose grid.
        setMode(multiple || data.items.length > 0 ? "choose" : "upload");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load media.");
          setMode("upload");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, multiple]);

  // Native dialog open/close + focus management (same machinery as ConfirmDialog).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        prevFocusRef.current = document.activeElement as HTMLElement | null;
        dialog.showModal();
        firstTabRef.current?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
      prevFocusRef.current?.focus();
      prevFocusRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      e.preventDefault();
      onClose();
    }
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);

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

  function chooseCard(item: MediaItem) {
    if (multiple) {
      // Toggle membership in the multi-select set.
      setMultiPicked((prev) =>
        prev.includes(item.id)
          ? prev.filter((id) => id !== item.id)
          : [...prev, item.id],
      );
      return;
    }
    setSelectedId(item.id);
    setAlt(item.alt);
  }

  function confirmChoice() {
    if (!selected) return;
    onSelect({ url: selected.url, alt: alt.trim() });
  }

  function confirmMany() {
    if (multiPicked.length === 0) return;
    // Preserve the order the images were picked in (that becomes gallery order).
    const byId = new Map(items.map((i) => [i.id, i]));
    const chosen = multiPicked
      .map((id) => byId.get(id))
      .filter((i): i is MediaItem => i !== undefined);
    onSelectMany?.(chosen);
  }

  async function handleUpload(file: File) {
    setError("");
    setBusy(true);
    try {
      const uploaded = await uploadImage(file, alt.trim());
      // Immediately perform the mode's action (§3.2 recommendation).
      onSelect({ url: uploaded.url, alt: (alt.trim() || uploaded.alt).trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  const emptyAltNudge = selected && alt.trim() === "";

  return (
    <dialog
      ref={dialogRef}
      className="osshp-dialog media-dialog"
      aria-label={title}
      // tabIndex=-1: keep the scrollable modal <dialog> out of the Tab order
      // (see confirm-dialog.tsx — defect 5).
      tabIndex={-1}
      onClick={handleDialogClick}
    >
      <div className="osshp-dialog-header">
        <h2 className="osshp-dialog-title">{title}</h2>
        <Button type="button" aria-label="Close" onClick={onClose}>
          ✕
        </Button>
      </div>

      {/* Mode tabs — hidden in multi-select (gallery) mode: uploads there go
          through the gallery manager's own bulk dropzone, so the picker is
          library-only. */}
      {multiple ? null : (
        <div className="media-tabs" role="tablist" aria-label="Image source">
          <button
            ref={firstTabRef}
            type="button"
            role="tab"
            className="media-tab"
            aria-selected={mode === "upload"}
            onClick={() => setMode("upload")}
          >
            Upload new
          </button>
          <button
            type="button"
            role="tab"
            className="media-tab"
            aria-selected={mode === "choose"}
            disabled={items.length === 0}
            onClick={() => setMode("choose")}
          >
            Choose existing
          </button>
        </div>
      )}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      {multiple ? (
        <>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="muted">
              No media in the library yet. Close and use the bulk uploader.
            </p>
          ) : (
            <div className="media-grid-scroll">
              <MediaGrid
                items={items}
                selectable
                multiSelectedIds={multiPicked}
                onActivate={chooseCard}
                ariaLabel="Choose photographs to add"
              />
            </div>
          )}
          <div className="osshp-dialog-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={multiPicked.length === 0}
              onClick={confirmMany}
            >
              {multiPicked.length > 0
                ? `Add ${multiPicked.length} photograph${
                    multiPicked.length === 1 ? "" : "s"
                  }`
                : primaryLabel}
            </Button>
          </div>
        </>
      ) : mode === "choose" ? (
        <>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="muted">No media yet. Switch to “Upload new”.</p>
          ) : (
            <div className="media-grid-scroll">
              <MediaGrid
                items={items}
                selectable
                selectedId={selectedId}
                onActivate={chooseCard}
                ariaLabel="Choose an image"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="picker-alt">Alt text</label>
            <input
              id="picker-alt"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="Describe the image"
              aria-describedby={emptyAltNudge ? "picker-alt-nudge" : undefined}
            />
            {emptyAltNudge ? (
              <span className="field-hint" id="picker-alt-nudge">
                No description — leave empty only if this image is decorative.
              </span>
            ) : null}
          </div>

          <div className="osshp-dialog-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={!selected} onClick={confirmChoice}>
              {primaryLabel}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="picker-upload-alt">Alt text</label>
            <input
              id="picker-upload-alt"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="Describe the image (recommended)"
            />
          </div>
          <ImageDropzone
            id="picker-upload-file"
            onFile={(f) => void handleUpload(f)}
            busy={busy}
            dropLabel="Drag an image here, or"
          />
          <div className="osshp-dialog-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}

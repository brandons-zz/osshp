"use client";

// ImageDropzone — owned drag-and-drop + click-to-pick upload control.
//
// Offers BOTH a styled file-picker button AND a drag-and-drop drop zone, as
// required by V-008. Built on the owned-component kernel (ui-component-contract
// §2–§4) and the Colophon design language (restraint, monospace furniture, AA
// contrast).
//
// Accessibility:
//   2.1.1 Keyboard — the "Choose file" <button> is the sole tab stop; the hidden
//          <input type="file"> is tabIndex=-1 and triggered programmatically.
//   2.4.7 Focus visible — :focus-visible ring from structural.css covers the button.
//   4.1.2 Name/Role/Value — the button has text; the input has aria-hidden=true.
//   1.4.3 / 1.4.11 — delegated to .osshp-dropzone styles in kernel.css, which read
//          semantic token pairs verified to be AA-conformant.
//
// Drag-over state is communicated with a CSS data-attribute ([data-drag-over]) so
// no inline style is written (CSP style-src nonce-based; inline styles blocked).
// All state transitions happen client-side after hydration; no inline event
// handler attributes are used.

import { useRef, useState, type DragEvent } from "react";
import { Button } from "./button";

export interface ImageDropzoneProps {
  /** id forwarded to the hidden file input (for programmatic reference, not label). */
  id: string;
  /** MIME/extension filter forwarded to the <input accept>. Default accepts
   *  standard web images plus HEIC/HEIF (iPhone photos). */
  accept?: string;
  /** Called when the user picks or drops a single file (single mode). */
  onFile?: (file: File) => void;
  /**
   * Multi-file mode (issue 047 gallery bulk-add). When true, the picker accepts a
   * multi-select, the drop zone accepts a multi-file drop, and a "Choose folder"
   * affordance appears — every accepted file is handed to `onFiles` at once. The
   * single-file decline notice (issue 046) is not used in this mode.
   */
  multiple?: boolean;
  /** Called with every picked/dropped file in multi-file mode. */
  onFiles?: (files: File[]) => void;
  /** Upload in progress — disables interaction, changes cursor. */
  busy?: boolean;
  /** The control and button are inert. */
  disabled?: boolean;
  /** Instructional text shown inside the drop zone when idle. */
  dropLabel?: string;
}

// This control takes ONE image. Dropping several (e.g. a whole album) used to
// silently upload only the first and discard the rest (issue 046) — a data-loss
// surprise. We now decline a multi-file drop with a clear message instead. True
// multi-image album upload is the gallery feature (issue 047).
const MULTI_FILE_NOTICE =
  "This upload takes one image at a time. Album/gallery support is coming — for now, add photos one at a time.";

export function ImageDropzone({
  id,
  accept = "image/*,.heic,.heif",
  onFile,
  multiple = false,
  onFiles,
  busy = false,
  disabled = false,
  dropLabel = "Drag an image here, or",
}: ImageDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");

  function pickFile() {
    if (!disabled && !busy) inputRef.current?.click();
  }

  // Hand a batch of files to the right callback. In multi-file mode every image
  // goes to onFiles at once; in single mode a >1 drop is declined (issue 046).
  function deliver(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    if (multiple) {
      setNotice("");
      onFiles?.(files);
      return;
    }
    if (files.length > 1) {
      setNotice(MULTI_FILE_NOTICE);
      return;
    }
    setNotice("");
    onFile?.(files[0]);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!disabled && !busy) setDragOver(true);
  }
  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear if leaving the dropzone entirely (not entering a child element).
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || busy) return;
    deliver(e.dataTransfer.files);
  }
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    deliver(e.target.files);
    // Reset the input so the same file(s) can be re-picked after a remove.
    e.target.value = "";
  }

  return (
    <div
      className="osshp-dropzone"
      data-drag-over={dragOver ? "" : undefined}
      data-busy={busy ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      // Clicking anywhere in the zone opens the picker (same as the button).
      onClick={pickFile}
    >
      {/* Hidden real input — activated by the Button below or zone click. */}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple || undefined}
        disabled={disabled || busy}
        onChange={handleChange}
        className="osshp-dropzone__input"
        aria-hidden="true"
        tabIndex={-1}
      />
      {/* Multi-file mode also offers a reliable folder pick (webkitdirectory). */}
      {multiple ? (
        <input
          ref={folderRef}
          id={`${id}-folder`}
          type="file"
          // @ts-expect-error — non-standard but widely supported directory pick.
          webkitdirectory=""
          directory=""
          multiple
          disabled={disabled || busy}
          onChange={handleChange}
          className="osshp-dropzone__input"
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : null}
      <span className="osshp-dropzone__hint" aria-hidden="true">
        {busy ? "Uploading…" : dropLabel}
      </span>
      <Button
        type="button"
        disabled={disabled || busy}
        // stopPropagation prevents the zone's onClick from triggering a second
        // input.click() when the user clicks directly on this button.
        onClick={(e) => {
          e.stopPropagation();
          pickFile();
        }}
      >
        {busy ? "Uploading…" : multiple ? "Choose files" : "Choose file"}
      </Button>
      {multiple ? (
        <Button
          type="button"
          disabled={disabled || busy}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled && !busy) folderRef.current?.click();
          }}
        >
          Choose folder
        </Button>
      ) : null}
      {notice ? (
        // role=status (polite) — a guidance message, not an error condition.
        // Reuses the AA-verified `.error` text token for guaranteed contrast.
        <p className="error" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

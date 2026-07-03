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
  /** MIME/extension filter forwarded to the <input accept>. Default "image/*". */
  accept?: string;
  /** Called when the user picks or drops a single file. */
  onFile: (file: File) => void;
  /** Upload in progress — disables interaction, changes cursor. */
  busy?: boolean;
  /** The control and button are inert. */
  disabled?: boolean;
  /** Instructional text shown inside the drop zone when idle. */
  dropLabel?: string;
}

export function ImageDropzone({
  id,
  accept = "image/*",
  onFile,
  busy = false,
  disabled = false,
  dropLabel = "Drag an image here, or",
}: ImageDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function pickFile() {
    if (!disabled && !busy) inputRef.current?.click();
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
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    // Reset the input so the same file can be re-picked after a remove.
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
        disabled={disabled || busy}
        onChange={handleChange}
        className="osshp-dropzone__input"
        aria-hidden="true"
        tabIndex={-1}
      />
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
        {busy ? "Uploading…" : "Choose file"}
      </Button>
    </div>
  );
}

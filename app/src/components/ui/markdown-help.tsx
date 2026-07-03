"use client";

// MarkdownHelp — inline "?" help affordance for the Markdown body editor (V-009).
//
// A small "?" trigger button opens a native <dialog showModal()> with a quick
// Markdown syntax reference (headings, bold/italic, links, lists, code, images,
// blockquotes). The dialog is:
//   - Keyboard-operable: Tab cycles within the dialog; Esc closes it (via the
//     native 'cancel' event); the "Close" button and the trigger both work.
//   - Dismissible: Esc, Close button, or clicking the backdrop all close it.
//   - Focus-managed: focus moves into the dialog on open; the trigger regains
//     focus on close (WCAG 2.4.3).
//   - CSP-safe: no inline event handlers or <script> tags; no inline styles;
//     all interactivity is through the React module bundle.
//   - AA-conformant: trigger button and dialog text use semantic token pairs
//     defined in kernel.css (osshp-md-help-btn, osshp-dialog, osshp-md-help-*).
//
// The reference content is static data — no network calls, no dynamic rendering.

import { useEffect, useRef } from "react";
import { Button } from "./button";

// Markdown quick-reference data. Covers the syntaxes most useful to a blog
// author: headings, emphasis, links, images, lists, code, and blockquotes.
const MD_SECTIONS = [
  {
    section: "Headings",
    items: [
      { syntax: "# Heading 1", desc: "H1 — page title" },
      { syntax: "## Heading 2", desc: "H2 — section" },
      { syntax: "### Heading 3", desc: "H3 — sub-section" },
    ],
  },
  {
    section: "Emphasis",
    items: [
      { syntax: "**bold**", desc: "Bold" },
      { syntax: "_italic_  or  *italic*", desc: "Italic" },
    ],
  },
  {
    section: "Links & images",
    items: [
      { syntax: "[link text](https://…)", desc: "Hyperlink" },
      { syntax: "![alt text](image-url)", desc: "Inline image" },
    ],
  },
  {
    section: "Lists",
    items: [
      { syntax: "- item", desc: "Unordered list item" },
      { syntax: "1. item", desc: "Ordered list item" },
    ],
  },
  {
    section: "Code",
    items: [
      { syntax: "`code`", desc: "Inline code" },
      { syntax: "```lang\ncode\n```", desc: "Fenced code block" },
    ],
  },
  {
    section: "Blockquote",
    items: [{ syntax: "> quoted text", desc: "Blockquote" }],
  },
] as const;

export function MarkdownHelp() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  function openHelp() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    closeBtnRef.current?.focus();
  }

  function closeHelp() {
    const dialog = dialogRef.current;
    if (!dialog || !dialog.open) return;
    dialog.close();
    triggerRef.current?.focus();
  }

  // 'cancel' fires on Esc — map to closeHelp (which also restores focus).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      e.preventDefault(); // prevent native close; let closeHelp drive state
      closeHelp();
    }
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
    // closeHelp is a stable closure over stable refs — no dependency needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backdrop click: click target is the <dialog> itself, outside its content rect.
  function handleDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) closeHelp();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="osshp-md-help-btn"
        aria-label="Open Markdown syntax reference"
        onClick={openHelp}
      >
        ?
      </button>

      <dialog
        ref={dialogRef}
        className="osshp-dialog osshp-md-help-dialog"
        aria-label="Markdown syntax reference"
        onClick={handleDialogClick}
      >
        <div className="osshp-dialog-header">
          <h2 className="osshp-dialog-title">Markdown reference</h2>
          <Button
            ref={closeBtnRef}
            type="button"
            aria-label="Close reference"
            onClick={closeHelp}
          >
            ✕
          </Button>
        </div>

        {MD_SECTIONS.map(({ section, items }) => (
          <div key={section} className="osshp-md-help-section">
            <h3>{section}</h3>
            {items.map(({ syntax, desc }) => (
              <div key={syntax} className="osshp-md-help-row">
                <code className="osshp-md-help-syntax">{syntax}</code>
                <span className="osshp-md-help-desc">{desc}</span>
              </div>
            ))}
          </div>
        ))}

        <div className="osshp-dialog-actions">
          <Button type="button" onClick={closeHelp}>
            Close
          </Button>
        </div>
      </dialog>
    </>
  );
}

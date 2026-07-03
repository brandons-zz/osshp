"use client";

// Page editor — a Markdown editor (TipTap v3, MIT packages only) with a live
// preview, drafts, and publish. Built on the same pattern as PostEditor (M2.8)
// but scoped to the Page content type: no tags, no cover image, no type field.
//
// Editing model: identical to PostEditor — TipTap hosts the body as a single
// code block (constrained document schema), so getJSON() yields raw Markdown
// verbatim. The live preview calls the SAME /api/admin/blog/preview endpoint
// (unified/remark/rehype-sanitize + Shiki pipeline) so the author sees exactly
// what the public site renders. The UI is built from the owned component kernel.
//
// V-009: MarkdownHelp "?" affordance on the body editor.
// Batch A: window.confirm for delete replaced with ConfirmDialog.

import { useCallback, useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import { Button, ConfirmDialog, MarkdownHelp } from "@/components/ui";

export interface PageInitial {
  id: string;
  title: string;
  slug: string;
  body: string;
  status: "draft" | "published";
  showInNav: boolean;
}

// Document constrained to a single code block → Markdown source surface.
const MarkdownDocument = Document.extend({ content: "codeBlock" });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read the raw Markdown back from the single-code-block document. */
function markdownOf(editor: Editor | null): string {
  if (!editor) return "";
  const doc = editor.getJSON() as {
    content?: Array<{ content?: Array<{ text?: string }> }>;
  };
  return doc.content?.[0]?.content?.[0]?.text ?? "";
}

export function PageEditor({
  mode,
  initial,
}: {
  mode: "new" | "edit";
  initial?: PageInitial;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [markdown, setMarkdown] = useState(initial?.body ?? "");
  const [showInNav, setShowInNav] = useState(initial?.showInNav ?? false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ConfirmDialog state for delete (Batch A — replaces window.confirm).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const initialContent = useMemo(
    () => ({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: initial?.body ? [{ type: "text", text: initial.body }] : [],
        },
      ],
    }),
    [initial?.body],
  );

  const editor = useEditor({
    extensions: [StarterKit.configure({ document: false }), MarkdownDocument],
    content: initialContent,
    immediatelyRender: false, // Next.js SSR — avoid hydration mismatch.
    editorProps: {
      attributes: {
        "aria-label": "Page body (Markdown)",
        class: "md-source",
      },
    },
    onUpdate: ({ editor }) => setMarkdown(markdownOf(editor)),
  });

  const effectiveSlug = slugTouched ? slug : slugify(title);

  // Live preview: debounced render through the SAME app pipeline the public site uses.
  useEffect(() => {
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/admin/blog/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ markdown }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as { html?: string };
          setPreviewHtml(data.html ?? "");
        } catch {
          // Aborted or transient — keep the last good preview.
        }
      })();
    }, 300);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [markdown]);

  // The actual delete — called only after the user confirms in ConfirmDialog.
  const executeDelete = useCallback(async () => {
    if (!initial?.id) return;
    setDeleteConfirmOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/pages/${initial.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Delete failed.");
      }
      window.location.assign("/admin/pages");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setDeleting(false);
    }
  }, [initial?.id]);

  const submit = useCallback(
    async (status: "draft" | "published") => {
      setError("");
      if (!title.trim() || !effectiveSlug) {
        setError("Title and slug are required.");
        return;
      }
      setBusy(true);
      const payload = {
        title: title.trim(),
        slug: effectiveSlug,
        body: markdown,
        status,
        showInNav,
      };
      try {
        const res =
          mode === "new"
            ? await fetch("/api/admin/pages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              })
            : await fetch(`/api/admin/pages/${initial!.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Save failed.");
        }
        window.location.assign("/admin/pages");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed.");
        setBusy(false);
      }
    },
    [title, effectiveSlug, markdown, showInNav, mode, initial],
  );

  return (
    <div className="stack">
      <h1>{mode === "new" ? "New page" : "Edit page"}</h1>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="pg-title">Title</label>
        <input
          id="pg-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="pg-slug">Slug</label>
        <input
          id="pg-slug"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <span className="field-hint">
          Public URL: /pages/{effectiveSlug || "…"}
        </span>
      </div>

      {/* V-010: Show-in-navigation toggle — default OFF. When on, this
          published page is automatically merged into the site header nav. */}
      <div className="field">
        <label className="field-check">
          <input
            id="pg-show-in-nav"
            type="checkbox"
            checked={showInNav}
            onChange={(e) => setShowInNav(e.target.checked)}
          />
          <span>Show in navigation</span>
        </label>
        <span className="field-hint" id="pg-show-in-nav-hint">
          When on, this published page appears automatically in the site header
          nav alongside your manually-configured nav items.
        </span>
      </div>

      {/* V-009: Markdown editor with help "?" affordance. */}
      <div className="md-editor-grid">
        <div className="field md-pane">
          <div className="md-pane-label-row">
            <span className="md-pane-label" id="pg-body-label">
              Body (Markdown)
            </span>
            <MarkdownHelp />
          </div>
          <div className="md-source-wrap" aria-labelledby="pg-body-label">
            <EditorContent editor={editor} />
          </div>
        </div>
        <div className="md-pane">
          <span className="md-pane-label">Preview</span>
          <div
            className="md-preview"
            aria-live="polite"
            aria-label="Rendered preview"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>

      <div className="row row-between">
        <div className="row">
          <Button type="button" disabled={busy} onClick={() => submit("draft")}>
            Save draft
          </Button>
          <Button type="button" disabled={busy} onClick={() => submit("published")}>
            Publish
          </Button>
        </div>
        {mode === "edit" ? (
          <>
            {/* Batch A: danger button opens themed ConfirmDialog (not window.confirm). */}
            <Button
              type="button"
              className="osshp-button--danger"
              disabled={deleting || busy}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {deleting ? "Deleting…" : "Delete page"}
            </Button>
            <ConfirmDialog
              open={deleteConfirmOpen}
              title="Delete page?"
              description="This cannot be undone. The page will be permanently removed and its public URL will return 404."
              confirmLabel="Delete"
              cancelLabel="Cancel"
              danger
              onConfirm={() => void executeDelete()}
              onCancel={() => setDeleteConfirmOpen(false)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

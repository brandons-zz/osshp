"use client";

// Blog post editor — a Markdown editor (TipTap v3, MIT packages only) with a live
// preview, drafts, publish, and scheduled publishing.
//
// Editing model: the editor is a Markdown SOURCE surface — TipTap hosts the body
// as a single code block (the document schema is constrained to `codeBlock`), so
// `getJSON()` yields the raw Markdown verbatim with no lossy WYSIWYG round-trip.
// The body is STORED as Markdown (the content model, spec §8) and rendered to
// sanitized, syntax-highlighted HTML by the SAME app-owned unified/remark/
// rehype-sanitize + Shiki pipeline used on the public site (§9). The live preview
// pane calls that one pipeline through /api/admin/blog/preview, so what the author
// previews is exactly what the public site renders. The UI is built from the owned
// component kernel (§8.3). (A richer WYSIWYG mode — spec §7's other half — is a
// later enhancement; raw-Markdown mode is shipped here to keep the round-trip
// lossless.)
//
// V-007: photo-post editor mode — "Photograph" is the primary upload (required,
//   shown first); the article body editor is secondary (extended caption / context).
// V-008: all image uploads use the owned ImageDropzone (drag-and-drop + styled
//   click-to-pick, replacing the bare native <input type="file">).
// V-009: the Markdown editor has a "?" help affordance (MarkdownHelp component)
//   that opens a keyboard-operable, Esc-dismissible syntax reference.
// Batch A: window.confirm for delete is replaced with ConfirmDialog (themed,
//   focus-trapped, Esc-to-cancel, AA-conformant).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import { Button, ConfirmDialog, ImageDropzone, MarkdownHelp } from "@/components/ui";

export interface PostInitial {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  status: "draft" | "published" | "scheduled";
  publishDate: string | null; // ISO 8601, when scheduled/published
  tags: string; // comma-separated names
  coverSrc?: string; // public /media/<key> URL of the cover image, if any
  coverAlt?: string; // alt text for the cover image
  /** Photo-posts only: whether this post is opted into the /blog listing stream. */
  showInBlog?: boolean;
  /** Whether this post is featured in the home "Selected" showcase (issue 012). */
  featured?: boolean;
}

// Document constrained to a single code block → the editor is a Markdown source
// surface. StarterKit supplies Text, CodeBlock, and undo/redo; its own Document is
// disabled so this constrained one is the schema's top node.
const MarkdownDocument = Document.extend({ content: "codeBlock" });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTags(raw: string): Array<{ name: string; slug: string }> {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((name) => ({ name, slug: slugify(name) }));
}

/** Read the raw Markdown back from the single-code-block document. */
function markdownOf(editor: Editor | null): string {
  if (!editor) return "";
  const doc = editor.getJSON() as {
    content?: Array<{ content?: Array<{ text?: string }> }>;
  };
  return doc.content?.[0]?.content?.[0]?.text ?? "";
}

/** A datetime-local input value (local time) → ISO 8601, or null if empty/invalid. */
function localToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO 8601 → a value the datetime-local input accepts (local time, no seconds). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// The editor is shared by the Blog module and the Photos module. The blog admin
// pages pass nothing extra (the defaults below preserve the original behavior);
// the photos admin pages override the post type, the API base, and the public/
// list paths so a photo post is authored through the same surface without forking
// the component.
export interface PostEditorConfig {
  /** Post type written on save (default 'article'; Photos passes 'photo-post'). */
  postType?: "article" | "photo-post";
  /** API base for create (POST) / update (PATCH `${apiBase}/${id}`). */
  apiBase?: string;
  /** Where to return after a successful save. */
  listHref?: string;
  /** Public URL base shown in the slug hint (e.g. "/blog" or "/photos"). */
  publicBase?: string;
  /** Noun shown in headings ("post" by default; "photo post" for Photos). */
  noun?: string;
}

export function PostEditor({
  mode,
  initial,
  postType = "article",
  apiBase = "/api/admin/blog/posts",
  listHref = "/admin/blog",
  publicBase = "/blog",
  noun = "post",
}: {
  mode: "new" | "edit";
  initial?: PostInitial;
} & PostEditorConfig) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [excerpt, setExcerpt] = useState(initial?.excerpt ?? "");
  const [tags, setTags] = useState(initial?.tags ?? "");
  const [markdown, setMarkdown] = useState(initial?.body ?? "");
  const [scheduleAt, setScheduleAt] = useState(
    initial?.status === "scheduled" ? isoToLocalInput(initial.publishDate) : "",
  );
  const [showSchedule, setShowSchedule] = useState(
    initial?.status === "scheduled",
  );
  const [previewHtml, setPreviewHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Photo-posts only: opt this post into the /blog listing stream (default OFF).
  const [showInBlog, setShowInBlog] = useState(initial?.showInBlog ?? false);
  // Feature this post in the home "Selected" showcase (issue 012; both types).
  const [featured, setFeatured] = useState(initial?.featured ?? false);

  // Cover image: uploaded via Uppy → /api/admin/media → a /media/<key> URL that
  // renders on the public post page through the theme.
  const [coverSrc, setCoverSrc] = useState(initial?.coverSrc ?? "");
  const [coverAlt, setCoverAlt] = useState(initial?.coverAlt ?? "");
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  // ConfirmDialog state for delete (Batch A — replaces window.confirm).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Ref to track what triggered the delete dialog (for focus restoration — handled
  // inside ConfirmDialog's own prevFocusRef, so this is informational only).
  const deleteAnchorRef = useRef<HTMLButtonElement>(null);

  const uploadCover = useCallback(
    async (file: File) => {
      setCoverError("");
      setCoverBusy(true);
      try {
        // Lazy-load Uppy on the client only (it touches browser APIs); the
        // resumable upload engine drives the POST to the media route.
        const { default: Uppy } = await import("@uppy/core");
        const { default: XHRUpload } = await import("@uppy/xhr-upload");
        const uppy = new Uppy({
          autoProceed: false,
          restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["image/*"] },
        });
        uppy.use(XHRUpload, {
          endpoint: "/api/admin/media",
          fieldName: "file",
          formData: true,
        });
        // Alt text travels as a form field the upload route reads.
        uppy.setMeta({ alt: coverAlt });
        uppy.addFile({ name: file.name, type: file.type, data: file });
        const result = await uppy.upload();
        const ok = result?.successful?.[0];
        if (!ok) {
          // Prefer the server's error message over Uppy's generic
          // "This looks like a network error…" copy (V-006).
          // On a non-2xx XHR response, Uppy stores the raw XMLHttpRequest
          // as `file.response`; the server JSON is in `.responseText`.
          const failed = result?.failed?.[0];
          let serverError: string | undefined;
          try {
            const responseText = (
              failed?.response as { responseText?: string } | null
            )?.responseText;
            if (responseText) {
              serverError = (JSON.parse(responseText) as { error?: string })
                .error;
            }
          } catch {
            // Ignore parse failure — fall through to generic message.
          }
          throw new Error(
            serverError ?? "The image could not be uploaded.",
          );
        }
        const resp = ok.response?.body as
          | { url?: string; alt?: string }
          | undefined;
        if (!resp?.url) throw new Error("Upload returned no URL.");
        setCoverSrc(resp.url);
        if (resp.alt) setCoverAlt(resp.alt);
        uppy.destroy();
      } catch (e) {
        setCoverError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setCoverBusy(false);
      }
    },
    [coverAlt],
  );

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
    // StarterKit's own Document is disabled so the constrained one is the schema
    // top node; this restricts the body to a single Markdown source block.
    extensions: [StarterKit.configure({ document: false }), MarkdownDocument],
    content: initialContent,
    immediatelyRender: false, // Next.js SSR — avoid a hydration mismatch.
    editorProps: {
      attributes: {
        "aria-label": "Post body (Markdown)",
        class: "md-source",
      },
    },
    onUpdate: ({ editor }) => setMarkdown(markdownOf(editor)),
  });

  const effectiveSlug = slugTouched ? slug : slugify(title);

  // Live preview: debounced render through the SAME app pipeline the public site
  // uses (sanitize + Shiki), so the preview is faithful to the published output.
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
      const res = await fetch(`${apiBase}/${initial.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Delete failed.");
      }
      window.location.assign(listHref);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setDeleting(false);
    }
  }, [initial?.id, apiBase, listHref]);

  const submit = useCallback(
    async (status: "draft" | "published" | "scheduled") => {
      setError("");
      if (!title.trim() || !effectiveSlug) {
        setError("Title and slug are required.");
        return;
      }
      // Only send publishDate when scheduling; for draft/publish it is omitted so
      // the route applies its rule (publish → stamped now; draft → unchanged).
      let publishDate: string | undefined;
      if (status === "scheduled") {
        const iso = localToIso(scheduleAt);
        if (!iso) {
          setError("Pick a date and time to schedule.");
          return;
        }
        publishDate = iso;
      }
      setBusy(true);
      const payload = {
        title: title.trim(),
        slug: effectiveSlug,
        excerpt,
        body: markdown,
        type: postType,
        status,
        publishDate,
        coverImage: coverSrc ? { src: coverSrc, alt: coverAlt } : null,
        tags: parseTags(tags),
        // Featured applies to both post types; sent unconditionally.
        featured,
        // Only sent for photo-posts; ignored by the blog post API route.
        ...(postType === "photo-post" ? { showInBlog } : {}),
      };
      try {
        const res =
          mode === "new"
            ? await fetch(apiBase, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              })
            : await fetch(`${apiBase}/${initial!.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Save failed.");
        }
        window.location.assign(listHref);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed.");
        setBusy(false);
      }
    },
    [
      title,
      effectiveSlug,
      excerpt,
      markdown,
      tags,
      scheduleAt,
      coverSrc,
      coverAlt,
      showInBlog,
      featured,
      mode,
      initial,
      postType,
      apiBase,
      listHref,
    ],
  );

  // True when this editor is in photo-post mode (drives V-007 layout).
  const isPhotoPost = postType === "photo-post";

  return (
    <div className="stack">
      <h1>{mode === "new" ? `New ${noun}` : `Edit ${noun}`}</h1>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="title">Title</label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="slug">Slug</label>
        <input
          id="slug"
          value={effectiveSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <span className="field-hint">
          Public URL: {publicBase}/{effectiveSlug || "…"}
        </span>
      </div>

      {/* ── V-007: Photo-post primary photograph upload ─────────────────────── */}
      {/* The photograph IS the content of a photo post — shown first, labeled  */}
      {/* prominently, not "optional." Articles use the cover section below.     */}
      {isPhotoPost ? (
        <div className="field photo-primary-field">
          <label htmlFor="primaryPhotoAlt">
            Photograph{" "}
            <span className="muted" aria-hidden="true">
              — primary content
            </span>
          </label>
          {coverError ? (
            <p className="error" role="alert">
              {coverError}
            </p>
          ) : null}
          {coverSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="cover-preview"
              src={coverSrc}
              alt={coverAlt}
              style={{ maxWidth: "320px", height: "auto", display: "block" }}
            />
          ) : null}
          {/* V-008: ImageDropzone — drag-and-drop + styled click-to-pick.     */}
          {!coverSrc ? (
            <ImageDropzone
              id="primaryPhotoFile"
              onFile={(f) => void uploadCover(f)}
              busy={coverBusy}
              dropLabel="Drag your photograph here, or"
            />
          ) : null}
          {coverBusy ? (
            <span className="field-hint">Uploading…</span>
          ) : null}
          <input
            id="primaryPhotoAlt"
            placeholder="Describe the photograph (alt text — required for accessibility)"
            value={coverAlt}
            onChange={(e) => setCoverAlt(e.target.value)}
          />
          {coverSrc ? (
            <Button
              type="button"
              disabled={coverBusy}
              onClick={() => {
                setCoverSrc("");
                setCoverError("");
              }}
            >
              Replace photograph
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="excerpt">Excerpt (optional)</label>
        <input
          id="excerpt"
          value={excerpt}
          onChange={(e) => setExcerpt(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="tags">Tags (comma-separated, optional)</label>
        <input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>

      {/* Feature on the home showcase — applies to BOTH articles and photo posts. */}
      <div className="field">
        <label className="checkbox-label">
          <input
            id="featured"
            type="checkbox"
            checked={featured}
            onChange={(e) => setFeatured(e.target.checked)}
          />
          Feature on the home page
        </label>
        <span className="field-hint">
          Featured {noun}s appear in the “Selected” showcase on the home page. The
          home shows up to four at a time; when more are featured it rotates
          through them. Off by default.
        </span>
      </div>

      {isPhotoPost ? (
        <div className="field">
          <label className="checkbox-label">
            <input
              id="showInBlog"
              type="checkbox"
              checked={showInBlog}
              onChange={(e) => setShowInBlog(e.target.checked)}
            />
            Also show in blog stream
          </label>
          <span className="field-hint">
            When checked, this photo post appears in the /blog listing (linking
            to its /photos page). Off by default.
          </span>
        </div>
      ) : null}

      {/* ── V-008: Article cover image (optional, styled dropzone) ────────── */}
      {/* Photo-post primary upload is handled above; this section is articles. */}
      {!isPhotoPost ? (
        <div className="field">
          <label htmlFor="coverAlt">Cover image (optional)</label>
          {coverError ? (
            <p className="error" role="alert">
              {coverError}
            </p>
          ) : null}
          {coverSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="cover-preview"
              src={coverSrc}
              alt={coverAlt}
              style={{ maxWidth: "240px", height: "auto", display: "block" }}
            />
          ) : null}
          {/* V-008: ImageDropzone — drag-and-drop + styled click-to-pick.     */}
          {!coverSrc ? (
            <ImageDropzone
              id="coverFile"
              onFile={(f) => void uploadCover(f)}
              busy={coverBusy}
              dropLabel="Drag a cover image here, or"
            />
          ) : null}
          {coverBusy ? <span className="field-hint">Uploading…</span> : null}
          <input
            id="coverAlt"
            placeholder="Describe the image (alt text)"
            value={coverAlt}
            onChange={(e) => setCoverAlt(e.target.value)}
          />
          {coverSrc ? (
            <Button
              type="button"
              disabled={coverBusy}
              onClick={() => {
                setCoverSrc("");
                setCoverError("");
              }}
            >
              Remove cover
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ── V-009: Markdown editor with help affordance ───────────────────── */}
      <div className="md-editor-grid">
        <div className="field md-pane">
          {/* Label row: "Body (Markdown)" + "?" help button inline.          */}
          <div className="md-pane-label-row">
            <span className="md-pane-label" id="md-body-label">
              {isPhotoPost ? "Caption / body (Markdown, optional)" : "Body (Markdown)"}
            </span>
            <MarkdownHelp />
          </div>
          <div className="md-source-wrap" aria-labelledby="md-body-label">
            <EditorContent editor={editor} />
          </div>
        </div>
        <div className="md-pane">
          <span className="md-pane-label">Preview</span>
          <div
            className="md-preview"
            aria-live="polite"
            aria-label="Rendered preview"
            // Sanitized by the app pipeline (§9) — the same SanitizedHtml the theme
            // renders on the public site.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>

      {showSchedule ? (
        <div className="field">
          <label htmlFor="scheduleAt">Publish at</label>
          <input
            id="scheduleAt"
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
          />
          <span className="field-hint">
            Stored as a scheduled post until this time.
          </span>
        </div>
      ) : null}

      <div className="row row-between">
        <div className="row">
          <Button type="button" disabled={busy} onClick={() => submit("draft")}>
            Save draft
          </Button>
          <Button type="button" disabled={busy} onClick={() => submit("published")}>
            Publish
          </Button>
          {showSchedule ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => submit("scheduled")}
            >
              Schedule
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={() => setShowSchedule(true)}
            >
              Schedule…
            </Button>
          )}
        </div>
        {mode === "edit" ? (
          <>
            {/* Batch A: danger button opens themed ConfirmDialog (not window.confirm). */}
            <Button
              ref={deleteAnchorRef}
              type="button"
              className="osshp-button--danger"
              disabled={deleting || busy}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              {deleting ? "Deleting…" : `Delete ${noun}`}
            </Button>
            <ConfirmDialog
              open={deleteConfirmOpen}
              title={`Delete ${noun}?`}
              description="This cannot be undone. The post will be permanently removed and its public URL will return 404."
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

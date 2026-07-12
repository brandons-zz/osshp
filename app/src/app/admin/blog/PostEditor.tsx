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
import { MediaPicker } from "@/components/media/MediaPicker";
import { uploadImage, buildImageMarkdown } from "@/lib/client/upload-image";
import {
  GalleryManager,
  type GalleryEntry,
  type GallerySnapshot,
} from "@/app/admin/photos/GalleryManager";
import {
  usePhotoMediaPreview,
  PhotoMediaCleanupOption,
} from "@/app/admin/photos/PhotoMediaCleanupOption";
import { TagCombobox, type TagOption } from "@/components/admin/TagCombobox";
import { slugify } from "@/lib/slug";

/** One gallery image as loaded for editing (issue 047). */
export interface GalleryInitialImage {
  mediaId: string;
  src: string;
  alt: string;
  caption: string;
}

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
  /** Media id of the single cover, when known — lets Single→Gallery seed it. */
  coverMediaId?: string | null;
  /** Photo-posts only: whether this post is opted into the /blog listing stream. */
  showInBlog?: boolean;
  /** Whether this post is featured in the home "Selected" showcase (issue 012). */
  featured?: boolean;
  /** Photo-posts only: whether this post is a GALLERY (issue 047). */
  isGallery?: boolean;
  /** Gallery mode: the ordered images to edit. */
  galleryImages?: GalleryInitialImage[];
}

// Document constrained to a single code block → the editor is a Markdown source
// surface. StarterKit supplies Text, CodeBlock, and undo/redo; its own Document is
// disabled so this constrained one is the schema's top node.
const MarkdownDocument = Document.extend({ content: "codeBlock" });

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
  const [tags, setTags] = useState<TagOption[]>(() =>
    parseTags(initial?.tags ?? ""),
  );
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
  const [coverMediaId, setCoverMediaId] = useState<string | null>(
    initial?.coverMediaId ?? null,
  );
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  // ── Gallery mode (issue 047) ───────────────────────────────────────────────
  // A photo post is Single (today's cover flow) or Gallery (an ordered album).
  // The gallery working set lives in gallerySnap so it survives a Single⇄Gallery
  // toggle (GalleryManager reports it up; we feed it back as the initial on
  // remount). Switching modes never destroys uploaded work.
  const [photoMode, setPhotoMode] = useState<"single" | "gallery">(
    initial?.isGallery ? "gallery" : "single",
  );
  const [gallerySnap, setGallerySnap] = useState<GallerySnapshot>(() => ({
    entries: (initial?.galleryImages ?? []).map((g) => ({
      key: `init-${g.mediaId}`,
      mediaId: g.mediaId,
      src: g.src,
      alt: g.alt,
      caption: g.caption,
      status: "ready" as const,
    })),
    coverMediaId: initial?.isGallery ? (initial?.coverMediaId ?? null) : null,
  }));

  // True when this editor is in photo-post mode (drives V-007 layout + gallery).
  const isPhotoPost = postType === "photo-post";

  // ConfirmDialog state for delete (Batch A — replaces window.confirm).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Photo-post media cleanup opt-in (issue 056): when deleting a photo post, offer
  // to also delete its now-unreferenced photos (usage-aware, server-side).
  const [deleteMedia, setDeleteMedia] = useState(false);
  const mediaCleanupEndpoint = initial?.id ? `${apiBase}/${initial.id}` : "";
  const { preview: mediaPreview, loading: mediaPreviewLoading } =
    usePhotoMediaPreview(
      mediaCleanupEndpoint,
      isPhotoPost && deleteConfirmOpen && !!initial?.id,
    );

  // Ref to track what triggered the delete dialog (for focus restoration — handled
  // inside ConfirmDialog's own prevFocusRef, so this is informational only).
  const deleteAnchorRef = useRef<HTMLButtonElement>(null);

  // Media picker (issue 037): a single shared modal driven in two modes — insert
  // an image into the Markdown body, or set the cover/photograph. The inline
  // ImageDropzone below stays (the wired upload-new path); the picker adds the
  // browse-and-reuse path plus its own upload-new tab.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"body" | "cover">("body");

  const uploadCover = useCallback(
    async (file: File) => {
      setCoverError("");
      setCoverBusy(true);
      try {
        // Shared upload path (issue 037 §3.2) — same POST /api/admin/media the
        // picker's "upload new" tab uses; surfaces the server's error (V-006).
        const uploaded = await uploadImage(file, coverAlt);
        setCoverSrc(uploaded.url);
        setCoverMediaId(uploaded.id);
        if (uploaded.alt) setCoverAlt(uploaded.alt);
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
      const base = `${apiBase}/${initial.id}`;
      const url =
        isPhotoPost && deleteMedia ? `${base}?deleteMedia=1` : base;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Delete failed.");
      }
      window.location.assign(listHref);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
      setDeleting(false);
    }
  }, [initial?.id, apiBase, listHref, isPhotoPost, deleteMedia]);

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

      // Gallery mode (issue 047): gate Publish/Schedule on alt + finished uploads.
      const isGallery = isPhotoPost && photoMode === "gallery";
      const readyImages = gallerySnap.entries.filter(
        (e) => e.status === "ready" && e.mediaId,
      );
      if (isGallery && status !== "draft") {
        const inFlight = gallerySnap.entries.some(
          (e) => e.status === "queued" || e.status === "uploading",
        );
        if (inFlight) {
          setError(
            "Some photographs are still uploading. Wait for them to finish, or Save draft.",
          );
          return;
        }
        if (readyImages.length === 0) {
          setError("Add at least one photograph before publishing.");
          return;
        }
        const missing = readyImages.filter((e) => e.alt.trim() === "").length;
        if (missing > 0) {
          setError(
            `${missing} photograph${missing === 1 ? "" : "s"} still need alt text — add alt to every image (or Save draft).`,
          );
          return;
        }
      }

      setBusy(true);
      const galleryPayload = readyImages.map((e) => ({
        mediaId: e.mediaId,
        caption: e.caption,
        alt: e.alt,
      }));
      const payload = {
        title: title.trim(),
        slug: effectiveSlug,
        excerpt,
        body: markdown,
        type: postType,
        status,
        publishDate,
        // A gallery derives its cover from the chosen gallery image server-side;
        // a Single post carries its own cover image URL.
        coverImage: isGallery
          ? null
          : coverSrc
            ? { src: coverSrc, alt: coverAlt }
            : null,
        tags,
        // Featured applies to both post types; sent unconditionally.
        featured,
        // Only sent for photo-posts; ignored by the blog post API route.
        ...(isPhotoPost
          ? {
              showInBlog,
              isGallery,
              coverMediaId: isGallery ? gallerySnap.coverMediaId : null,
              ...(isGallery ? { gallery: galleryPayload } : {}),
            }
          : {}),
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
      photoMode,
      gallerySnap,
      isPhotoPost,
      mode,
      initial,
      postType,
      apiBase,
      listHref,
    ],
  );

  // Switch Single ⇄ Gallery. Switching to Gallery with a Single cover already
  // uploaded seeds it as the first gallery image (no data loss, spec §2.1).
  const switchMode = useCallback(
    (next: "single" | "gallery") => {
      setPhotoMode(next);
      if (
        next === "gallery" &&
        gallerySnap.entries.length === 0 &&
        coverSrc &&
        coverMediaId
      ) {
        setGallerySnap({
          entries: [
            {
              key: `seed-${coverMediaId}`,
              mediaId: coverMediaId,
              src: coverSrc,
              alt: coverAlt,
              caption: "",
              status: "ready",
            } as GalleryEntry,
          ],
          coverMediaId,
        });
      }
    },
    [gallerySnap.entries.length, coverSrc, coverMediaId, coverAlt],
  );

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

      {/* ── issue 047: Photo-post mode toggle (Single vs Gallery) ───────────── */}
      {isPhotoPost ? (
        <div className="field">
          <span id="photo-mode-label" className="field-label-text">
            This photo post is:
          </span>
          <div
            className="seg"
            role="group"
            aria-labelledby="photo-mode-label"
          >
            <button
              type="button"
              aria-pressed={photoMode === "single"}
              onClick={() => switchMode("single")}
            >
              Single photo
            </button>
            <button
              type="button"
              aria-pressed={photoMode === "gallery"}
              onClick={() => switchMode("gallery")}
            >
              Gallery
            </button>
          </div>
          <span className="field-hint">
            A Single post is one standout photograph. A Gallery is an ordered
            album of many photographs from one occasion. Switching keeps your
            uploaded work.
          </span>
        </div>
      ) : null}

      {/* ── issue 047: Gallery manager (bulk upload, reorder, cover, alt) ────── */}
      {isPhotoPost && photoMode === "gallery" ? (
        <GalleryManager
          initial={gallerySnap.entries}
          initialCoverMediaId={gallerySnap.coverMediaId}
          onChange={setGallerySnap}
        />
      ) : null}

      {/* ── V-007: Photo-post primary photograph upload (Single mode) ────────── */}
      {/* The photograph IS the content of a photo post — shown first, labeled  */}
      {/* prominently, not "optional." Articles use the cover section below.     */}
      {isPhotoPost && photoMode === "single" ? (
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
            <>
              <ImageDropzone
                id="primaryPhotoFile"
                onFile={(f) => void uploadCover(f)}
                busy={coverBusy}
                dropLabel="Drag your photograph here, or"
              />
              <Button
                type="button"
                disabled={coverBusy}
                onClick={() => {
                  setPickerMode("cover");
                  setPickerOpen(true);
                }}
              >
                Choose existing
              </Button>
            </>
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
        <label htmlFor="tags">Tags (optional)</label>
        <TagCombobox id="tags" value={tags} onChange={setTags} />
      </div>

      {/* Feature on the home showcase — applies to BOTH articles and photo posts. */}
      <div className="field">
        <label className="field-check">
          <input
            id="featured"
            type="checkbox"
            checked={featured}
            onChange={(e) => setFeatured(e.target.checked)}
          />
          <span>Feature on the home page</span>
        </label>
        <span className="field-hint">
          Featured {noun}s appear in the “Selected” showcase on the home page. The
          home shows up to four at a time; when more are featured it rotates
          through them. Off by default.
        </span>
      </div>

      {isPhotoPost ? (
        <div className="field">
          <label className="field-check">
            <input
              id="showInBlog"
              type="checkbox"
              checked={showInBlog}
              onChange={(e) => setShowInBlog(e.target.checked)}
            />
            <span>Also show in blog stream</span>
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
            <>
              <ImageDropzone
                id="coverFile"
                onFile={(f) => void uploadCover(f)}
                busy={coverBusy}
                dropLabel="Drag a cover image here, or"
              />
              <Button
                type="button"
                disabled={coverBusy}
                onClick={() => {
                  setPickerMode("cover");
                  setPickerOpen(true);
                }}
              >
                Choose existing
              </Button>
            </>
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
            <Button
              type="button"
              onClick={() => {
                setPickerMode("body");
                setPickerOpen(true);
              }}
            >
              Insert image
            </Button>
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
              onClick={() => {
                setDeleteMedia(false);
                setDeleteConfirmOpen(true);
              }}
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
            >
              {isPhotoPost && deleteConfirmOpen ? (
                <PhotoMediaCleanupOption
                  preview={mediaPreview}
                  loading={mediaPreviewLoading}
                  checked={deleteMedia}
                  onChange={setDeleteMedia}
                />
              ) : null}
            </ConfirmDialog>
          </>
        ) : null}
      </div>

      <MediaPicker
        open={pickerOpen}
        title={pickerMode === "body" ? "Insert image" : "Choose cover image"}
        primaryLabel={pickerMode === "body" ? "Insert" : "Use as cover"}
        onSelect={(picked) => {
          if (pickerMode === "body") {
            // Insert the Markdown image at the cursor in the code-block body
            // (issue 037 §3.4). It renders in the Preview pane via the existing
            // pipeline — no new render code. As a text node so newlines survive.
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "text",
                text: buildImageMarkdown(picked.alt, picked.url),
              })
              .run();
          } else {
            setCoverSrc(picked.url);
            setCoverAlt(picked.alt);
          }
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

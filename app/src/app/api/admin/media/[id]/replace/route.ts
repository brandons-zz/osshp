// POST /api/admin/media/[id]/replace — replace a media item's binary in place,
// keeping the same id, and rewrite content references so every existing use
// stays valid (issue 037 §1.5 / §7).
//
// Flow: multipart `file` → new EXIF/GPS-stripped variants stored under the same
// `<id>/` prefix → media row rewritten (new variants/dimensions/primary key) →
// content references rewritten from the OLD primary URL to the NEW primary URL
// (the §5 scan is reused) → stale old objects pruned by replaceUploadedImage.
// The image updates everywhere it is used at once — the intuitive meaning of
// "replace" (flagged for owner review, design §9-A).
//
// Admin surface (default-deny) + authoritative session validation + inline CSRF
// guard (params arg). Same upload gates as POST /api/admin/media (image-only,
// size cap). SSRF (A10): uploaded bytes only.

import { getDb } from "@/lib/db/client";
import { config } from "@/lib/config";
import { isSameOrigin, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage, replaceUploadedImage, classifyUpload } from "@/lib/media";
import { getMediaById } from "@/lib/content/media";
import { rewriteMediaReferences, findMediaUsage } from "@/lib/content/media-usage";
import { toMediaListItem } from "@/lib/content/media-view";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — matches the upload route.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request, config.origin)) {
    return withNoStore(Response.json({ error: "csrf_failed" }, { status: 403 }));
  }
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  const { id } = await params;
  if (!(await getMediaById(db, id))) {
    return withNoStore(
      Response.json({ error: "media not found" }, { status: 404 }),
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    // Log the real cause (issue 049) — a truncated body from an intermediary
    // (e.g. a Cloudflare Tunnel) surfaces here as a parse failure; don't mask it.
    console.error(
      "[media] formData parse failed (replace):",
      "content-length=",
      request.headers.get("content-length") ?? "unknown",
      "error=",
      e,
    );
    return withNoStore(
      Response.json({ error: "expected multipart form data" }, { status: 400 }),
    );
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return withNoStore(
      Response.json({ error: "missing file field" }, { status: 400 }),
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return withNoStore(
      Response.json({ error: "file too large" }, { status: 413 }),
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Accept by content, not just MIME (issue 048) — same rule as the upload route
  // so a HEIC replacement with a blank iOS MIME isn't false-rejected.
  const { accept } = classifyUpload({
    declaredType: file.type,
    filename: file.name,
    head: buffer.subarray(0, 32),
  });
  if (!accept) {
    return withNoStore(
      Response.json({ error: "file must be an image" }, { status: 415 }),
    );
  }

  let replaced;
  try {
    replaced = await replaceUploadedImage(db, getMediaStorage(), id, {
      buffer,
      filename: file.name,
    });
  } catch (e) {
    console.error("[media] replace processing failed:", e);
    return withNoStore(
      Response.json(
        {
          error:
            "The image could not be processed. It may be in an unsupported format or too small.",
        },
        { status: 422 },
      ),
    );
  }
  if (!replaced) {
    return withNoStore(
      Response.json({ error: "media not found" }, { status: 404 }),
    );
  }

  // Rewrite every reference from ANY old variant URL to the new primary URL so
  // covers and body embeds keep resolving after the dimensions (and thus the
  // variant filenames) change — including a body that embedded a non-primary
  // variant (issue 039).
  await rewriteMediaReferences(db, replaced.oldUrls, replaced.url);

  const usage = await findMediaUsage(db, id);
  return withNoStore(Response.json(toMediaListItem(replaced.media, usage.length)));
}

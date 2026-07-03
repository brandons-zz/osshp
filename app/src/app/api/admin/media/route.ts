// POST /api/admin/media — upload an image (multipart form: `file` + optional `alt`).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// requires a signed session to reach here; this handler ALSO authoritatively
// validates it (revocation/expiry). guardMutation-wrapped (CSRF, no-store).
//
// Pipeline: raw bytes → EXIF/GPS-stripped responsive variants (M2.7) → Garage
// store → media reference. The response carries the public `/media/<key>` URL the
// author wires onto content (e.g. a post cover) so the image renders on the
// public site through the theme.
//
// SSRF (A10): uploaded bytes only — no media-by-URL / server-side remote fetch.

import { getDb } from "@/lib/db/client";
import { guardMutation } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage, storeUploadedImage } from "@/lib/media";

// Reject non-images early and cap the upload size (defense-in-depth; the image
// decoder would reject non-images anyway, but a cheap type/size gate is cleaner).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

export const POST = guardMutation(async (request: Request): Promise<Response> => {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file field" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return Response.json({ error: "file must be an image" }, { status: 415 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large" }, { status: 413 });
  }

  const altRaw = form.get("alt");
  const alt = typeof altRaw === "string" ? altRaw.trim() : "";

  const buffer = Buffer.from(await file.arrayBuffer());

  let stored;
  try {
    stored = await storeUploadedImage(db, getMediaStorage(), { buffer, alt });
  } catch (e) {
    // Log the real cause — this was previously a silent swallow (V-006).
    // The error reaches here from processImage (sharp decode/resize failure) or
    // the object-store put (storage error). Both are opaque to the client, but
    // the server MUST log them so the operator can diagnose failures.
    console.error("[media] upload processing failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    // Classify the error for a more honest client message.
    const isProcessing =
      /unsupported|invalid|decode|corrupt|format|could not|no variants/i.test(msg);
    const clientMsg = isProcessing
      ? "The image could not be processed. It may be in an unsupported format or too small."
      : "The image could not be stored. Please try again.";
    return Response.json({ error: clientMsg }, { status: 422 });
  }

  return Response.json(
    {
      id: stored.media.id,
      url: stored.url,
      alt: stored.media.alt,
      width: stored.media.width,
      height: stored.media.height,
      responsiveSizes: stored.media.responsiveSizes,
    },
    { status: 201 },
  );
});

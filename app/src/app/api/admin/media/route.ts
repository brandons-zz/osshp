// GET  /api/admin/media — list every media item (newest first) + usage counts.
// POST /api/admin/media — upload an image (multipart form: `file` + optional `alt`).
//
// Admin surface: not on the public allowlist, so the default-deny middleware
// requires a signed session to reach here; each handler ALSO authoritatively
// validates it (revocation/expiry). POST is guardMutation-wrapped (CSRF, no-store);
// GET is a safe method (no CSRF) but is stamped no-store — admin data must not cache.
//
// Pipeline: raw bytes → EXIF/GPS-stripped responsive variants (M2.7) → Garage
// store → media reference. The response carries the public `/media/<key>` URL the
// author wires onto content (e.g. a post cover) so the image renders on the
// public site through the theme.
//
// SSRF (A10): uploaded bytes only — no media-by-URL / server-side remote fetch.

import { getDb } from "@/lib/db/client";
import { guardMutation, withNoStore } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/platform";
import { getMediaStorage, storeUploadedImage, classifyUpload } from "@/lib/media";
import { listMediaWithUsage } from "@/lib/content/media-usage";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  if (!(await getSessionFromRequest(db, request))) {
    return withNoStore(
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );
  }
  // Gallery-aware usage counts (§5; issues 056/057). Shared with the SSR
  // /admin/media first paint via one helper so the two never disagree — gallery
  // membership (post_media, a JOIN not embedded text) is merged in, so a
  // gallery-only photo never reads "Unused".
  const items = await listMediaWithUsage(db);
  return withNoStore(Response.json({ items }));
}

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
  } catch (e) {
    // Do NOT swallow the real cause (issue 049): a malformed/truncated multipart
    // body here almost always means an intermediary (e.g. a Cloudflare Tunnel)
    // cut the request body short, not that the client sent the wrong type. Log
    // the actual error and the declared Content-Length so the next real failure
    // is diagnosable instead of masked by the generic string below.
    console.error(
      "[media] formData parse failed (upload):",
      "content-length=",
      request.headers.get("content-length") ?? "unknown",
      "content-type=",
      request.headers.get("content-type") ?? "unknown",
      "error=",
      e,
    );
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file field" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "file too large" }, { status: 413 });
  }

  const altRaw = form.get("alt");
  const alt = typeof altRaw === "string" ? altRaw.trim() : "";

  const buffer = Buffer.from(await file.arrayBuffer());

  // Accept by CONTENT, not just the declared MIME (issue 048). iOS frequently
  // hands a HEIC to the browser with an empty or `application/octet-stream`
  // type; a MIME-only gate would false-reject a genuine iPhone photo before the
  // bytes are inspected. classifyUpload sniffs the magic bytes (filename
  // extension as a fallback) and still rejects true non-images.
  const { accept } = classifyUpload({
    declaredType: file.type,
    filename: file.name,
    head: buffer.subarray(0, 32),
  });
  if (!accept) {
    return Response.json({ error: "file must be an image" }, { status: 415 });
  }

  let stored;
  try {
    stored = await storeUploadedImage(db, getMediaStorage(), {
      buffer,
      alt,
      filename: file.name,
    });
  } catch (e) {
    // Log the real cause — this was previously a silent swallow (V-006).
    // The error reaches here from processImage (sharp decode/resize failure) or
    // the object-store put (storage error). Both are opaque to the client, but
    // the server MUST log them so the operator can diagnose failures.
    console.error("[media] upload processing failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    // Classify the error for a more honest client message.
    const isProcessing =
      /unsupported|invalid|decode|corrupt|format|could not|no variants|pixel|dimensions?|exceeds|too large/i.test(
        msg,
      );
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

// Shared client-side image upload helper (issue 037 §3.2).
//
// The Uppy → POST /api/admin/media path was previously inline in
// PostEditor.uploadCover. It is extracted here so BOTH editors' cover/photograph
// dropzones AND the in-editor MediaPicker's "Upload new" tab drive the exact
// same resumable upload to the exact same route — one path to build, gate, and
// keep AA/CSRF-correct. Uppy is dynamically imported so it stays out of the SSR
// bundle (it touches browser APIs).
//
// Client-only: called from "use client" components. Not a component, so it needs
// no "use client" banner itself.

export interface UploadedImage {
  id: string;
  url: string; // /media/<primaryKey>
  alt: string;
  width?: number;
  height?: number;
  responsiveSizes?: Array<{ width: number; height: number; key: string }>;
}

/**
 * Client-side upload ceiling — mirrors the route's MAX_UPLOAD_BYTES (25 MB).
 * We reject oversize files BEFORE the bytes leave the browser (issue 049) so the
 * author gets an instant, friendly message instead of waiting out a long upload
 * that then fails. Keep this in sync with `MAX_UPLOAD_BYTES` in
 * `src/app/api/admin/media/route.ts`.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Upload one image file to the media route and resolve the stored reference.
 * Surfaces the SERVER's error message on failure (not Uppy's generic network
 * copy — V-006), so the caller can show an honest reason.
 */
export async function uploadImage(
  file: File,
  alt: string,
): Promise<UploadedImage> {
  // Pre-flight size guard (issue 049): fail fast with a clear message rather than
  // streaming a too-large file all the way to a server rejection.
  if (file.size > MAX_UPLOAD_BYTES) {
    const maxMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
    const fileMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `This image is ${fileMb} MB — the maximum is ${maxMb} MB. Please choose a smaller file.`,
    );
  }
  const { default: Uppy } = await import("@uppy/core");
  const { default: XHRUpload } = await import("@uppy/xhr-upload");
  const uppy = new Uppy({
    autoProceed: false,
    // Accept HEIC/HEIF by extension too (issue 048): iOS often reports a blank
    // or octet-stream MIME for HEIC, which the "image/*" pattern alone rejects.
    restrictions: {
      maxNumberOfFiles: 1,
      maxFileSize: MAX_UPLOAD_BYTES,
      allowedFileTypes: ["image/*", ".heic", ".heif"],
    },
  });
  uppy.use(XHRUpload, {
    endpoint: "/api/admin/media",
    fieldName: "file",
    formData: true,
  });
  uppy.setMeta({ alt });
  uppy.addFile({ name: file.name, type: file.type, data: file });
  try {
    const result = await uppy.upload();
    const ok = result?.successful?.[0];
    if (!ok) {
      const failed = result?.failed?.[0];
      let serverError: string | undefined;
      try {
        const responseText = (
          failed?.response as { responseText?: string } | null
        )?.responseText;
        if (responseText) {
          serverError = (JSON.parse(responseText) as { error?: string }).error;
        }
      } catch {
        // Ignore parse failure — fall through to the generic message.
      }
      throw new Error(serverError ?? "The image could not be uploaded.");
    }
    const resp = ok.response?.body as
      | {
          id?: string;
          url?: string;
          alt?: string;
          width?: number;
          height?: number;
          responsiveSizes?: Array<{ width: number; height: number; key: string }>;
        }
      | undefined;
    if (!resp?.url || !resp.id) throw new Error("Upload returned no URL.");
    return {
      id: resp.id,
      url: resp.url,
      alt: resp.alt ?? alt,
      width: resp.width,
      height: resp.height,
      responsiveSizes: resp.responsiveSizes,
    };
  } finally {
    uppy.destroy();
  }
}

/**
 * Build the Markdown image string inserted into a body at the cursor (§3.4).
 * Wrapped in blank lines so it lands as its own block in the raw-Markdown source.
 * The alt is captured into the content here (context-dependent alt, §6).
 */
export function buildImageMarkdown(alt: string, url: string): string {
  return `\n![${alt}](${url})\n`;
}

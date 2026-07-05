// GET /media/[...key] — stream an uploaded media binary back from object storage.
//
// Public surface (the `/media/` prefix is on the auth allowlist): this is the URL
// a post cover image / content reference points at, so the bytes resolve and the
// image RENDERS on the public site through the theme. Keys are app-generated and
// immutable (`<uuid>/<width>.<ext>`), so the response is safely long-cacheable.
//
// Defense-in-depth: although keys are never user-authored, reject any path segment
// that could traverse out of the bucket namespace.

import { Readable } from "node:stream";
import { getMediaStorage } from "@/lib/media";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await params;
  if (
    key.length === 0 ||
    key.some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return new Response("not found", { status: 404 });
  }
  const objectKey = key.join("/");

  try {
    const obj = await getMediaStorage().get(objectKey);
    const body = Readable.toWeb(obj.stream) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": obj.contentType,
        "content-length": String(obj.size),
        // Immutable, uuid-namespaced keys — safe to cache aggressively.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// Shared gallery-payload handling for the photo-post create/update routes
// (issue 047). Leading-underscore filename → ignored by the App Router (not a
// route). Both POST and PATCH normalize + validate the incoming gallery here so
// the contract (and its hardening) can't drift between the two handlers.

import type { Db } from "@/lib/db/types";
import type { ContentStatus, GalleryInput } from "@/lib/content/types";
import { getMediaById } from "@/lib/content/media";

/** Hard cap on gallery size — enforced SERVER-SIDE (the client caps too, but a
 *  raw POST/PATCH must not be able to submit an unbounded array and cause
 *  unbounded write amplification). Mirrors the manager's HARD_CAP. */
export const MAX_GALLERY_SIZE = 100;
/** Length bounds on client-supplied free text (defense-in-depth vs unbounded
 *  TEXT). Generous — real captions/alts are far shorter. */
const MAX_CAPTION_LEN = 2000;
const MAX_ALT_LEN = 1000;

/** A media id must be a UUID; anything else can't reference a real media row and
 *  would blow up an `id = $1::uuid` cast, so we reject it as "not found". */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One gallery entry as it arrives on the wire (all fields untrusted). */
interface RawGalleryItem {
  mediaId?: unknown;
  caption?: unknown;
  alt?: unknown;
}

/**
 * Normalize an untrusted gallery array into GalleryInput[]. Drops entries with
 * no usable mediaId; coerces caption/alt to strings and BOUNDS their length.
 * Order is preserved (it IS the gallery order). Returns undefined when `raw` is
 * not an array, so the caller can distinguish "no gallery field sent" (leave
 * unchanged) from "empty gallery" (an explicit empty album). Size is NOT capped
 * here (that's a reject, not a silent truncate — see galleryTooLarge).
 */
export function normalizeGallery(raw: unknown): GalleryInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: GalleryInput[] = [];
  for (const item of raw as RawGalleryItem[]) {
    if (!item || typeof item !== "object") continue;
    const mediaId = typeof item.mediaId === "string" ? item.mediaId.trim() : "";
    if (!mediaId) continue;
    out.push({
      mediaId,
      caption:
        typeof item.caption === "string"
          ? item.caption.slice(0, MAX_CAPTION_LEN)
          : "",
      // alt is written through to the media row; only include when a string was
      // sent (undefined ⇒ leave the media row's stored alt untouched).
      ...(typeof item.alt === "string"
        ? { alt: item.alt.slice(0, MAX_ALT_LEN) }
        : {}),
    });
  }
  return out;
}

/** True when the gallery exceeds the server-side hard cap (→ reject with 400). */
export function galleryTooLarge(gallery: GalleryInput[] | undefined): boolean {
  return !!gallery && gallery.length > MAX_GALLERY_SIZE;
}

export interface GalleryMediaCheck {
  /** null when every referenced media exists and its id is well-formed. */
  error: string | null;
  /** mediaId → the media row's stored alt (for effective-alt resolution). */
  storedAlt: Map<string, string>;
}

/**
 * Verify every referenced media row EXISTS before we write post_media rows —
 * so a nonexistent / malformed media id returns a clean 4xx instead of throwing
 * an uncaught FK/cast error mid-write (a 500). Also returns each media's stored
 * alt so the caller can resolve the EFFECTIVE alt (payload alt else stored alt)
 * for the publish check without a second round of lookups.
 */
export async function checkGalleryMedia(
  db: Db,
  gallery: GalleryInput[],
): Promise<GalleryMediaCheck> {
  const storedAlt = new Map<string, string>();
  for (const g of gallery) {
    if (!UUID_RE.test(g.mediaId)) {
      return { error: "A photograph reference is not valid.", storedAlt: new Map() };
    }
    if (storedAlt.has(g.mediaId)) continue; // dedupe lookups
    const media = await getMediaById(db, g.mediaId);
    if (!media) {
      return {
        error: "A referenced photograph is no longer in the media library.",
        storedAlt: new Map(),
      };
    }
    storedAlt.set(g.mediaId, media.alt);
  }
  return { error: null, storedAlt };
}

/**
 * Resolve each entry's EFFECTIVE alt = the payload alt when supplied, else the
 * media row's stored alt. This is what the publish check must judge: omitting
 * alt in the payload doesn't clear it, so validation must see the stored value.
 */
export function resolveEffectiveAlt(
  gallery: GalleryInput[],
  storedAlt: Map<string, string>,
): GalleryInput[] {
  return gallery.map((g) => ({
    mediaId: g.mediaId,
    caption: g.caption,
    alt: g.alt ?? storedAlt.get(g.mediaId) ?? "",
  }));
}

/**
 * The alt-on-publish AA rule (WCAG 1.1.1, spec §2.2/§5): every gallery image
 * must carry alt to Publish or Schedule. Save-draft is exempt (work isn't lost).
 * Returns a human message naming the count of images missing alt, or null when
 * publishable. Judge EFFECTIVE alt (resolveEffectiveAlt) and EFFECTIVE status
 * (the resulting status, which on a PATCH is body.status ?? the stored status) —
 * NOT gated on `status` being present in the request, so editing an already-
 * published gallery can't slip a missing-alt image past the check.
 */
export function galleryPublishAltError(
  status: ContentStatus,
  isGallery: boolean,
  gallery: GalleryInput[] | undefined,
): string | null {
  if (!isGallery) return null;
  if (status !== "published" && status !== "scheduled") return null;
  if (!gallery) return null; // caller supplies the effective gallery when relevant
  if (gallery.length === 0) {
    return "A gallery needs at least one photograph before it can be published.";
  }
  const missing = gallery.filter((g) => (g.alt ?? "").trim() === "").length;
  if (missing > 0) {
    return `${missing} photograph${missing === 1 ? "" : "s"} still need alt text. Add alt to every image (or Save draft) before publishing.`;
  }
  return null;
}

/** An alt-bearing gallery item as the PATCH decision judges it. */
export interface EffectiveGalleryItem {
  mediaId: string;
  alt: string;
}

/**
 * The PATCH alt-on-publish decision, computed on the EFFECTIVE result — NOT
 * gated on `bodyStatus` being present in the request. This is the fix for the
 * raw-API bypass: editing an already-published gallery while omitting `status`
 * must still enforce alt.
 *
 *  - effective isGallery = bodyIsGallery ?? existingIsGallery
 *  - effective status    = bodyStatus    ?? existingStatus   (the RESULT status)
 *  - effective gallery   = writtenGallery when the PATCH writes one, else the
 *    stored gallery (both carry resolved alt)
 */
export function effectivePublishAltError(input: {
  bodyStatus?: ContentStatus;
  bodyIsGallery?: boolean;
  existingStatus?: ContentStatus;
  existingIsGallery?: boolean;
  /** Resolved-alt items when this PATCH writes a gallery; null when it doesn't. */
  writtenGallery: EffectiveGalleryItem[] | null;
  /** The stored gallery's resolved-alt items (used when writtenGallery is null). */
  storedGallery: EffectiveGalleryItem[];
}): string | null {
  const isGallery = input.bodyIsGallery ?? input.existingIsGallery ?? false;
  const status = input.bodyStatus ?? input.existingStatus;
  if (!isGallery || !status) return null;
  const effective = input.writtenGallery ?? input.storedGallery;
  return galleryPublishAltError(status, true, effective);
}

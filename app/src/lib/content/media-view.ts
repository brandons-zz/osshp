// The media DTO the admin media API returns (issue 037 §1.1). One shape shared
// by the list (GET), alt-edit (PATCH), and replace (POST) responses so the
// client renders every media item identically. `responsiveSizes` is included so
// the client can pick the smallest variant for a card thumbnail and the ~800px
// variant for the detail preview (design §2.2/§2.3) without a second request.

import type { MediaRef, ResponsiveSize } from "./types";

export interface MediaListItem {
  id: string;
  /** Public URL of the primary (largest) variant — what content links to. */
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  createdAt: string;
  exifStripped: boolean;
  responsiveSizes: ResponsiveSize[];
  /** Number of posts+pages referencing this upload (§5 scan). */
  usageCount: number;
}

export function toMediaListItem(
  media: MediaRef,
  usageCount: number,
): MediaListItem {
  return {
    id: media.id,
    url: `/media/${media.storageKey}`,
    alt: media.alt,
    width: media.width,
    height: media.height,
    mimeType: media.mimeType,
    createdAt: media.createdAt,
    exifStripped: media.exifStripped,
    responsiveSizes: media.responsiveSizes,
    usageCount,
  };
}

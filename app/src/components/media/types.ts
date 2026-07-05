// Client-side shape of a media item (mirrors lib/content/media-view MediaListItem,
// the DTO the admin media API returns). Kept here so client components do not
// import server modules.

export interface ResponsiveSize {
  width: number;
  height: number;
  key: string;
}

export interface MediaItem {
  id: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  createdAt: string;
  exifStripped: boolean;
  responsiveSizes: ResponsiveSize[];
  usageCount: number;
}

export interface MediaUsageRef {
  type: "post" | "page";
  id: string;
  title: string;
  slug: string;
  field: "cover" | "body";
  adminHref: string;
}

/** Smallest responsive variant for a card thumbnail; falls back to the primary. */
export function thumbUrl(item: MediaItem): string {
  if (item.responsiveSizes.length === 0) return item.url;
  const smallest = item.responsiveSizes.reduce((a, b) =>
    b.width < a.width ? b : a,
  );
  return `/media/${smallest.key}`;
}

/** ~800px variant for the detail preview; falls back to the primary. */
export function previewUrl(item: MediaItem): string {
  if (item.responsiveSizes.length === 0) return item.url;
  // Prefer the variant closest to 800px (design §2.3), else the largest.
  const sorted = [...item.responsiveSizes].sort(
    (a, b) => Math.abs(a.width - 800) - Math.abs(b.width - 800),
  );
  return `/media/${sorted[0].key}`;
}

/** Accessible name for a card button — alt (or fallback) + dimensions + usage. */
export function cardAccessibleName(item: MediaItem): string {
  const name = item.alt.trim() || "Untitled image";
  const dims =
    item.width && item.height ? `, ${item.width} by ${item.height} pixels` : "";
  const usage =
    item.usageCount > 0
      ? `, used by ${item.usageCount} ${item.usageCount === 1 ? "item" : "items"}`
      : ", unused";
  return `${name}${dims}${usage}`;
}

"use client";

// PhotoMediaCleanupOption — the "Also delete the N photos in this post?" opt-in
// shown inside the photo-post delete ConfirmDialog (issue 056). Deleting a photo
// post used to leave its images orphaned in the library (a chore for a 26-image
// gallery); this offers to remove them in the same action.
//
// Honest by construction: it reads the server preview (GET …/[id]/media), which
// is usage-aware, and shows how many photos are deletable vs shared. Media used
// by ANOTHER post/page (cover, body, or another gallery) is counted as "kept" and
// never deleted. When every photo is shared, no checkbox is offered — there is
// nothing safe to delete.
//
// Accessible: a native checkbox with a real <label> association (keyboard-operable
// inside the dialog's focus trap; name/role/value via the checkbox + label).

import { useEffect, useState } from "react";

export interface PhotoMediaPreview {
  /** Photos the post owns (gallery members + resolved single cover). */
  total: number;
  /** Owned photos referenced only by this post → deletable with it. */
  deletable: number;
  /** Owned photos also used elsewhere → kept. */
  shared: number;
}

/** Fetch the media-cleanup preview only while `active` (the dialog is open), so
 *  a list of rows does not each fire a request on page load. */
export function usePhotoMediaPreview(
  endpoint: string,
  active: boolean,
): { preview: PhotoMediaPreview | null; loading: boolean } {
  const [preview, setPreview] = useState<PhotoMediaPreview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`${endpoint}/media`);
        if (!res.ok) return;
        const data = (await res.json()) as PhotoMediaPreview;
        if (!cancelled) setPreview(data);
      } catch {
        // Non-fatal — the delete still works; we just omit the media offer.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, active]);

  return { preview, loading };
}

function noun(n: number): string {
  return n === 1 ? "photo" : "photos";
}

export function PhotoMediaCleanupOption({
  preview,
  loading,
  checked,
  onChange,
}: {
  preview: PhotoMediaPreview | null;
  loading: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (loading) {
    return (
      <p className="muted" role="status">
        Checking the post's photos…
      </p>
    );
  }
  if (!preview || preview.total === 0) return null;

  const { total, deletable, shared } = preview;

  // Nothing safe to delete — every owned photo is used elsewhere. Inform, no opt-in.
  if (deletable === 0) {
    return (
      <p className="muted media-cleanup-note">
        All {total} {noun(total)} in this post are also used elsewhere and will be
        kept.
      </p>
    );
  }

  const lead =
    deletable === total
      ? `Also delete the ${total} ${noun(total)} in this post`
      : `Also delete ${deletable} of ${total} ${noun(total)}`;

  return (
    <label className="media-cleanup-option">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {lead}
        {shared > 0
          ? ` — ${shared} shared with ${
              shared === 1 ? "another post" : "other posts"
            } will be kept.`
          : "."}
      </span>
    </label>
  );
}

"use client";

// MediaLibrary — the client half of /admin/media (issue 037 §2; multiselect 057).
// Renders the responsive card grid (MediaGrid), the header Upload affordance, the
// count line, and the calm empty state. Per-item actions (edit alt, replace,
// usage, delete) live in the MediaDetail dialog — opened by activating a card.
//
// Multiselect (issue 057): the grid supports a selection set distinct from the
// card's open action (Space or a corner checkbox selects; Enter/click opens
// detail). When anything is selected a bulk-action bar appears with select-all /
// clear, a usage-aware Bulk delete, and a step-through Edit alt workflow. Bulk
// delete reuses the 037 gate: in-use images require an explicit "delete anyway"
// (force) pass that lists what is referenced — nothing is silently orphaned.

import { useCallback, useMemo, useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";
import { MediaGrid } from "@/components/media/MediaGrid";
import { MediaPicker } from "@/components/media/MediaPicker";
import type { MediaItem, MediaUsageRef } from "@/components/media/types";
import { MediaDetail } from "./MediaDetail";
import { BatchAltEditor } from "./BatchAltEditor";

interface BulkDeleteItem {
  id: string;
  status: "deleted" | "in_use" | "not_found" | "error";
  usage?: MediaUsageRef[];
  error?: string;
}
interface BulkDeleteResponse {
  results: BulkDeleteItem[];
  deleted: number;
  inUse: number;
}

export function MediaLibrary({ initialItems }: { initialItems: MediaItem[] }) {
  const [items, setItems] = useState<MediaItem[]>(initialItems);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Selection (issue 057). A Set for O(1) membership; the grid is caller-owned.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(
    () => items.filter((i) => selectedSet.has(i.id)),
    [items, selectedSet],
  );

  const [bulkStatus, setBulkStatus] = useState(""); // aria-live announcements
  const [bulkBusy, setBulkBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // In-use items surfaced by the first (no-force) bulk pass → the force gate.
  const [inUseItems, setInUseItems] = useState<BulkDeleteItem[]>([]);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [altEditorOpen, setAltEditorOpen] = useState(false);

  const detailItem = items.find((i) => i.id === detailId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/media");
      if (!res.ok) return;
      const data = (await res.json()) as { items: MediaItem[] };
      setItems(data.items);
    } catch {
      // Transient — keep the last good list.
    }
  }, []);

  const toggleSelect = useCallback((item: MediaItem) => {
    setSelectedIds((prev) =>
      prev.includes(item.id)
        ? prev.filter((id) => id !== item.id)
        : [...prev, item.id],
    );
  }, []);
  const selectAll = useCallback(() => setSelectedIds(items.map((i) => i.id)), [items]);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  /** POST the selected ids to the bulk-delete endpoint. */
  async function postBulkDelete(
    ids: string[],
    force: boolean,
  ): Promise<BulkDeleteResponse | null> {
    try {
      const res = await fetch("/api/admin/media/bulk-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, force }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Bulk delete failed.");
      }
      return (await res.json()) as BulkDeleteResponse;
    } catch (e) {
      setBulkStatus(e instanceof Error ? e.message : "Bulk delete failed.");
      return null;
    }
  }

  function announceOutcome(deleted: number, kept: number) {
    const parts: string[] = [];
    if (deleted > 0) parts.push(`${deleted} deleted`);
    if (kept > 0) parts.push(`${kept} kept (in use)`);
    setBulkStatus(parts.length ? parts.join(", ") + "." : "Nothing deleted.");
  }

  // First pass: delete the free items, discover the in-use ones (no force).
  async function confirmBulkDelete() {
    setDeleteConfirmOpen(false);
    setBulkBusy(true);
    setBulkStatus("Deleting…");
    const out = await postBulkDelete(selectedIds, false);
    setBulkBusy(false);
    if (!out) return;
    const stillInUse = out.results.filter((r) => r.status === "in_use");
    // Drop the successfully-deleted ids from the selection immediately.
    const deletedIds = new Set(
      out.results.filter((r) => r.status === "deleted").map((r) => r.id),
    );
    setSelectedIds((prev) => prev.filter((id) => !deletedIds.has(id)));
    await refresh();
    if (stillInUse.length > 0) {
      setInUseItems(stillInUse);
      setForceConfirmOpen(true);
    } else {
      announceOutcome(out.deleted, 0);
      clearSelection();
    }
  }

  // Second pass: force-delete the in-use items the user chose to remove anyway.
  async function confirmForceDelete() {
    setForceConfirmOpen(false);
    setBulkBusy(true);
    setBulkStatus("Deleting…");
    const ids = inUseItems.map((r) => r.id);
    const out = await postBulkDelete(ids, true);
    setBulkBusy(false);
    setInUseItems([]);
    if (!out) return;
    await refresh();
    announceOutcome(out.deleted, 0);
    clearSelection();
  }

  const inUseSummary = inUseItems
    .flatMap((r) => (r.usage ?? []).map((u) => u.title || u.slug))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const allSelected = items.length > 0 && selectedIds.length === items.length;

  return (
    <div className="stack">
      <div className="row row-between">
        <h1>Media</h1>
        <Button type="button" onClick={() => setPickerOpen(true)}>
          Upload
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="media-empty">
          <h2>No media yet</h2>
          <p className="muted">
            Upload an image to reuse it across posts, pages, and photos.
          </p>
          <Button type="button" onClick={() => setPickerOpen(true)}>
            Upload
          </Button>
        </div>
      ) : (
        <>
          <div className="media-toolbar">
            <p className="media-count">
              {items.length} {items.length === 1 ? "image" : "images"}
            </p>
            {/* Bulk-action bar — appears when a selection exists. role=toolbar so
                AT announces it as a group of actions; the count is announced via
                the polite live region. */}
            {selectedIds.length > 0 ? (
              <div
                className="media-bulkbar"
                role="toolbar"
                aria-label="Bulk actions for selected images"
              >
                <span className="media-bulkbar__count">
                  {selectedIds.length} selected
                </span>
                <Button
                  type="button"
                  onClick={selectAll}
                  disabled={allSelected || bulkBusy}
                >
                  Select all
                </Button>
                <Button type="button" onClick={clearSelection} disabled={bulkBusy}>
                  Clear
                </Button>
                <Button
                  type="button"
                  onClick={() => setAltEditorOpen(true)}
                  disabled={bulkBusy}
                >
                  Edit alt text
                </Button>
                <Button
                  type="button"
                  className="osshp-button--danger"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={bulkBusy}
                >
                  {bulkBusy ? "Deleting…" : "Delete"}
                </Button>
              </div>
            ) : null}
          </div>

          {/* Live region: selection + bulk-operation outcomes for screen readers. */}
          <span className="sr-only" role="status" aria-live="polite">
            {bulkStatus ||
              (selectedIds.length > 0
                ? `${selectedIds.length} of ${items.length} selected`
                : "")}
          </span>

          <MediaGrid
            items={items}
            selectionEnabled
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onActivate={(item) => setDetailId(item.id)}
            ariaLabel="Media library"
          />
        </>
      )}

      {detailItem ? (
        <MediaDetail
          item={detailItem}
          onClose={() => setDetailId(null)}
          onUpdated={(updated) => {
            setItems((prev) =>
              prev.map((i) => (i.id === updated.id ? updated : i)),
            );
          }}
          onDeleted={(id) => {
            setItems((prev) => prev.filter((i) => i.id !== id));
            setSelectedIds((prev) => prev.filter((sid) => sid !== id));
            setDetailId(null);
          }}
        />
      ) : null}

      {/* First bulk-delete gate. */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title={`Delete ${selectedIds.length} ${
          selectedIds.length === 1 ? "image" : "images"
        }?`}
        description="Images in use by a post or page are not deleted here — you will be asked again for those. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void confirmBulkDelete()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

      {/* Second gate — force-delete the in-use items the user chose to remove. */}
      <ConfirmDialog
        open={forceConfirmOpen}
        title={`Delete ${inUseItems.length} image${
          inUseItems.length === 1 ? "" : "s"
        } still in use?`}
        description={`These images are used by other content${
          inUseSummary ? ` (${inUseSummary})` : ""
        } — deleting removes them from those pages. This cannot be undone.`}
        confirmLabel="Delete anyway"
        cancelLabel="Keep them"
        danger
        onConfirm={() => void confirmForceDelete()}
        onCancel={() => {
          setForceConfirmOpen(false);
          setInUseItems([]);
          clearSelection();
        }}
      />

      {altEditorOpen && selectedItems.length > 0 ? (
        <BatchAltEditor
          items={selectedItems}
          onUpdated={(updated) =>
            setItems((prev) =>
              prev.map((i) => (i.id === updated.id ? updated : i)),
            )
          }
          onClose={() => setAltEditorOpen(false)}
        />
      ) : null}

      <MediaPicker
        open={pickerOpen}
        title="Upload media"
        primaryLabel="Done"
        onSelect={() => {
          setPickerOpen(false);
          void refresh();
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

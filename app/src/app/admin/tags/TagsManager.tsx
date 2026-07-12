"use client";

// TagsManager — the /admin/tags client interaction: rename, merge, delete.
//
// Data-integrity approach: rename updates the affected row in place (it can't
// change any post count); merge and delete both change post counts in ways
// that are easiest to get right by re-fetching the authoritative list from
// the server afterward, rather than computing a client-side delta (a post
// tagged with BOTH the merge source and target must not be double-counted,
// and getting that arithmetic right client-side is exactly the kind of thing
// worth pushing back onto the one source of truth).

import { useCallback, useMemo, useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";

interface TagRow {
  id: string;
  name: string;
  slug: string;
  count: number;
}

// Mirrors content/tags.ts's TAG_NAME_MAX_LENGTH for early client-side
// feedback; the server re-validates authoritatively regardless (defense in
// depth — this is just so a too-long name doesn't round-trip to learn that).
const TAG_NAME_MAX_LENGTH = 60;

async function fetchTags(): Promise<TagRow[]> {
  const res = await fetch("/api/admin/tags");
  if (!res.ok) throw new Error("Failed to load tags.");
  const data = (await res.json()) as { tags: TagRow[] };
  return data.tags;
}

export function TagsManager({ initialTags }: { initialTags: TagRow[] }) {
  const [tags, setTags] = useState(initialTags);
  const [error, setError] = useState("");

  // ── Rename ──────────────────────────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");

  function startRename(tag: TagRow) {
    setRenamingId(tag.id);
    setRenameValue(tag.name);
    setRenameError("");
  }
  function cancelRename() {
    setRenamingId(null);
    setRenameError("");
  }
  async function saveRename(tag: TagRow) {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setRenameError("Tag name is required.");
      return;
    }
    if (trimmed.length > TAG_NAME_MAX_LENGTH) {
      setRenameError(`Tag name must be ${TAG_NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }
    setRenameBusy(true);
    setRenameError("");
    try {
      const res = await fetch(`/api/admin/tags/${tag.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        tag?: TagRow;
        error?: string;
      };
      if (!res.ok) {
        // 409 collision: a clear, actionable message — merge is the intended
        // path when the operator really did mean to combine two tags.
        setRenameError(data.error ?? "Rename failed.");
        return;
      }
      setTags((prev) =>
        prev
          .map((t) => (t.id === tag.id ? { ...t, ...data.tag! } : t))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setRenamingId(null);
    } catch {
      setRenameError("Rename failed. Check your connection and try again.");
    } finally {
      setRenameBusy(false);
    }
  }

  // ── Merge ───────────────────────────────────────────────────────────────
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<Record<string, string>>({});
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);

  const mergeSource = useMemo(
    () => tags.find((t) => t.id === mergeSourceId) ?? null,
    [tags, mergeSourceId],
  );
  const mergeTarget = useMemo(() => {
    if (!mergeSourceId) return null;
    const targetId = mergeTargetId[mergeSourceId];
    return targetId ? (tags.find((t) => t.id === targetId) ?? null) : null;
  }, [tags, mergeSourceId, mergeTargetId]);

  function requestMerge(sourceId: string) {
    const targetId = mergeTargetId[sourceId];
    if (!targetId) return;
    setMergeSourceId(sourceId);
    setMergeConfirmOpen(true);
  }

  async function confirmMerge() {
    if (!mergeSource || !mergeTarget) return;
    setMergeBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/tags/${mergeSource.id}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: mergeTarget.id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Merge failed.");
      }
      const fresh = await fetchTags();
      setTags(fresh);
      setMergeConfirmOpen(false);
      setMergeSourceId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed.");
      setMergeConfirmOpen(false);
    } finally {
      setMergeBusy(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteTarget = useMemo(
    () => tags.find((t) => t.id === deleteId) ?? null,
    [tags, deleteId],
  );

  const deleteTag = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/tags/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Delete failed.");
      }
      setTags((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget]);

  return (
    <div className="stack">
      <h1>Tags</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tags.length === 0 ? (
        <p className="muted">No tags yet. Tags are created from the post editor.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Posts</th>
              <th>Merge into</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => {
              const otherTags = tags.filter((t) => t.id !== tag.id);
              const selectedTargetId = mergeTargetId[tag.id] ?? "";
              return (
                <tr key={tag.id}>
                  <td>
                    {renamingId === tag.id ? (
                      <div className="row row-gap">
                        <input
                          aria-label={`Rename tag ${tag.name}`}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveRename(tag);
                            if (e.key === "Escape") cancelRename();
                          }}
                          disabled={renameBusy}
                          autoFocus
                        />
                        <Button
                          type="button"
                          disabled={renameBusy}
                          onClick={() => void saveRename(tag)}
                        >
                          {renameBusy ? "Saving…" : "Save"}
                        </Button>
                        <Button type="button" disabled={renameBusy} onClick={cancelRename}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      tag.name
                    )}
                    {renamingId === tag.id && renameError && (
                      <p className="error" role="alert">
                        {renameError}
                      </p>
                    )}
                  </td>
                  <td>
                    <code>{tag.slug}</code>
                  </td>
                  <td>{tag.count}</td>
                  <td>
                    <div className="row row-gap">
                      <select
                        className="tag-merge-select"
                        aria-label={`Merge ${tag.name} into`}
                        value={selectedTargetId}
                        onChange={(e) =>
                          setMergeTargetId((prev) => ({ ...prev, [tag.id]: e.target.value }))
                        }
                        disabled={otherTags.length === 0}
                      >
                        <option value="">Choose a tag…</option>
                        {otherTags.map((other) => (
                          <option key={other.id} value={other.id}>
                            {other.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        disabled={!selectedTargetId}
                        onClick={() => requestMerge(tag.id)}
                      >
                        Merge
                      </Button>
                    </div>
                  </td>
                  <td className="row row-gap">
                    {renamingId !== tag.id && (
                      <Button type="button" onClick={() => startRename(tag)}>
                        Rename
                      </Button>
                    )}
                    <Button
                      type="button"
                      className="osshp-button--danger"
                      onClick={() => setDeleteId(tag.id)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={mergeConfirmOpen && mergeSource !== null && mergeTarget !== null}
        title={`Merge "${mergeSource?.name ?? ""}" into "${mergeTarget?.name ?? ""}"?`}
        description={
          mergeSource
            ? `${mergeSource.count} post${mergeSource.count === 1 ? "" : "s"} tagged "${mergeSource.name}" will be re-tagged "${mergeTarget?.name ?? ""}", and "${mergeSource.name}" will be removed. This cannot be undone.`
            : ""
        }
        confirmLabel={mergeBusy ? "Merging…" : "Merge"}
        cancelLabel="Cancel"
        danger
        onConfirm={() => void confirmMerge()}
        onCancel={() => {
          setMergeConfirmOpen(false);
          setMergeSourceId(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description={
          deleteTarget
            ? `Removed from ${deleteTarget.count} post${deleteTarget.count === 1 ? "" : "s"}. The posts themselves are not deleted. This cannot be undone.`
            : ""
        }
        confirmLabel={deleteBusy ? "Deleting…" : "Delete"}
        cancelLabel="Cancel"
        danger
        onConfirm={() => void deleteTag()}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}

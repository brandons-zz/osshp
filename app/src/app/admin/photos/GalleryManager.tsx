"use client";

// GalleryManager — the authoring surface for a GALLERY photo post (issue 047).
//
// A responsive thumbnail grid of the images in the gallery plus a bulk-add
// dropzone. Per thumbnail: a cover radio (one per gallery), an optional caption,
// a REQUIRED alt (empty alt is flagged and blocks Publish, but not Save-draft),
// keyboard-accessible reorder (← / → move buttons) AND drag-to-reorder, and a
// remove button (drops the reference; the media stays in the library).
//
// Bulk upload is the hard part (closes issue 046): a multi-file / folder drop or
// OS multi-select is uploaded SEQUENTIALLY WITH SMALL CONCURRENCY (3 in flight)
// to the SHIPPED POST /api/admin/media route (reusing the HEIC/large-file
// pipeline unchanged), each file showing its own progress and, on failure, its
// own inline RETRY — one bad file never fails the batch. A "Choose from library"
// button opens the shared MediaPicker in its multi-select variant.
//
// This component owns the working set and notifies the parent editor via onChange
// with the persistable gallery + resolved cover so the editor can build the save
// payload and gate Publish on missing alt / in-flight uploads.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ImageDropzone } from "@/components/ui";
import { MediaPicker } from "@/components/media/MediaPicker";
import type { MediaItem } from "@/components/media/types";
import { uploadImage, MAX_UPLOAD_BYTES } from "@/lib/client/upload-image";

/** Small concurrency window for the bulk upload (spec §6 recommended default). */
const CONCURRENCY = 3;
/** Soft-warn threshold and hard cap per gallery (spec §7 decision 7). */
const SOFT_WARN = 50;
const HARD_CAP = 100;

type EntryStatus = "queued" | "uploading" | "ready" | "failed";

export interface GalleryEntry {
  /** Stable local key (survives before a mediaId is assigned). */
  key: string;
  /** The media row id — null until the upload completes. */
  mediaId: string | null;
  /** Preview URL: an object URL while uploading, the /media/<key> URL once ready. */
  src: string;
  alt: string;
  caption: string;
  status: EntryStatus;
  error?: string;
}

/** The snapshot the parent editor consumes to build the payload + gate publish. */
export interface GallerySnapshot {
  entries: GalleryEntry[];
  /** Resolved cover media id (chosen, else the first ready image, else null). */
  coverMediaId: string | null;
}

let seq = 0;
function nextKey(): string {
  seq += 1;
  return `g-${Date.now()}-${seq}`;
}

/** HEIC/HEIF often arrive with a blank or octet-stream MIME (issue 048). */
function looksLikeImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(heic|heif)$/i.test(file.name);
}

export function GalleryManager({
  initial,
  initialCoverMediaId,
  onChange,
}: {
  initial: GalleryEntry[];
  initialCoverMediaId: string | null;
  onChange: (snap: GallerySnapshot) => void;
}) {
  const [entries, setEntries] = useState<GalleryEntry[]>(initial);
  const [coverKey, setCoverKey] = useState<string | null>(() => {
    if (!initialCoverMediaId) return initial[0]?.key ?? null;
    return (
      initial.find((e) => e.mediaId === initialCoverMediaId)?.key ??
      initial[0]?.key ??
      null
    );
  });
  const [warning, setWarning] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Upload orchestration state kept in refs so the pump is stable across renders.
  const filesRef = useRef<Map<string, File>>(new Map());
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(0);
  const dragIndexRef = useRef<number | null>(null);
  // Mirror of entries so enqueue can read the current length WITHOUT doing its
  // ref side effects inside a setEntries updater (updaters double-run in React
  // StrictMode dev, which would double-enqueue uploads).
  const entriesRef = useRef<GalleryEntry[]>(initial);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const patchEntry = useCallback(
    (key: string, patch: Partial<GalleryEntry>) => {
      setEntries((prev) =>
        prev.map((e) => (e.key === key ? { ...e, ...patch } : e)),
      );
    },
    [],
  );

  // The concurrency-limited pump: keep up to CONCURRENCY uploads in flight.
  const pump = useCallback(() => {
    while (runningRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const key = queueRef.current.shift();
      if (!key) break;
      const file = filesRef.current.get(key);
      if (!file) continue;
      runningRef.current += 1;
      patchEntry(key, { status: "uploading", error: undefined });
      uploadImage(file, "")
        .then((up) => {
          // Keep any alt the author already typed (they fill it in the manager);
          // just wire the media id + the stored /media URL.
          patchEntry(key, { status: "ready", mediaId: up.id, src: up.url });
          filesRef.current.delete(key);
        })
        .catch((err: unknown) => {
          patchEntry(key, {
            status: "failed",
            error: err instanceof Error ? err.message : "Upload failed.",
          });
        })
        .finally(() => {
          runningRef.current -= 1;
          pump();
        });
    }
  }, [patchEntry]);

  const enqueue = useCallback(
    (files: File[]) => {
      setWarning("");
      const images = files.filter(looksLikeImage);
      if (images.length === 0) return;

      // Read current length from the ref (not a setState updater) so the ref
      // side effects below run exactly once, even under StrictMode.
      const current = entriesRef.current;
      const room = HARD_CAP - current.length;
      if (room <= 0) {
        setWarning(
          `A gallery holds at most ${HARD_CAP} photographs. Remove some before adding more.`,
        );
        return;
      }
      const accepted = images.slice(0, room);

      const newEntries: GalleryEntry[] = accepted.map((file) => {
        const key = nextKey();
        const url = URL.createObjectURL(file);
        objectUrlsRef.current.add(url);
        if (file.size > MAX_UPLOAD_BYTES) {
          const mb = (file.size / (1024 * 1024)).toFixed(1);
          const max = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
          return {
            key,
            mediaId: null,
            src: url,
            alt: "",
            caption: "",
            status: "failed",
            error: `${mb} MB exceeds the ${max} MB limit — choose a smaller file.`,
          };
        }
        filesRef.current.set(key, file);
        queueRef.current.push(key);
        return { key, mediaId: null, src: url, alt: "", caption: "", status: "queued" };
      });

      setEntries((prev) => [...prev, ...newEntries]);

      const projectedCount = current.length + accepted.length;
      if (accepted.length < images.length) {
        setWarning(
          `Only ${accepted.length} added — a gallery holds at most ${HARD_CAP} photographs.`,
        );
      } else if (projectedCount > SOFT_WARN) {
        setWarning(
          `That's a big gallery (${projectedCount}). It will still render fine — images lazy-load — but consider splitting very large sets.`,
        );
      }
      // Kick the pump after the queue is populated.
      queueMicrotask(pump);
    },
    [pump],
  );

  const retry = useCallback(
    (key: string) => {
      const file = filesRef.current.get(key);
      if (!file) return; // oversize/no-file failures can't be retried
      patchEntry(key, { status: "queued", error: undefined });
      queueRef.current.push(key);
      pump();
    },
    [patchEntry, pump],
  );

  const remove = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
    filesRef.current.delete(key);
    queueRef.current = queueRef.current.filter((k) => k !== key);
  }, []);

  const move = useCallback((index: number, dir: -1 | 1) => {
    setEntries((prev) => {
      const to = index + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }, []);

  const addFromLibrary = useCallback((picked: MediaItem[]) => {
    setPickerOpen(false);
    setEntries((prev) => {
      const have = new Set(prev.map((e) => e.mediaId).filter(Boolean));
      const additions: GalleryEntry[] = picked
        .filter((m) => !have.has(m.id))
        .map((m) => ({
          key: nextKey(),
          mediaId: m.id,
          src: m.url,
          alt: m.alt,
          caption: "",
          status: "ready" as const,
        }));
      return [...prev, ...additions];
    });
  }, []);

  // Resolve the cover: the chosen key if it still exists AND is ready, else the
  // first ready image (so a cover always exists — removing the cover promotes the
  // new first image, spec §2.2).
  const readyEntries = entries.filter((e) => e.status === "ready" && e.mediaId);
  const resolvedCover =
    entries.find((e) => e.key === coverKey && e.status === "ready") ??
    readyEntries[0] ??
    null;

  // Notify the parent on every change (payload + publish-gating source of truth).
  useEffect(() => {
    onChange({ entries, coverMediaId: resolvedCover?.mediaId ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, coverKey]);

  // Revoke object URLs on unmount (avoid leaking blob: URLs).
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  const total = entries.length;
  const uploading = entries.filter(
    (e) => e.status === "queued" || e.status === "uploading",
  ).length;
  const missingAlt = readyEntries.filter((e) => e.alt.trim() === "").length;

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) enqueue(files);
  }

  return (
    <div className="field gallery-manager">
      <div className="man-head">
        <span className="count" aria-live="polite">
          {total} {total === 1 ? "photograph" : "photographs"}
          {uploading > 0 ? ` · ${uploading} uploading` : ""}
          {missingAlt > 0 ? ` · ${missingAlt} need alt` : ""}
        </span>
        <Button type="button" onClick={() => setPickerOpen(true)}>
          Choose from library
        </Button>
      </div>

      {warning ? (
        <p className="field-hint gallery-warn" role="status">
          {warning}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="man-grid" aria-label="Gallery photographs">
          {entries.map((entry, index) => {
            const missing = entry.status === "ready" && entry.alt.trim() === "";
            const isCover = resolvedCover?.key === entry.key;
            return (
              <li
                key={entry.key}
                className={`thumb${isCover ? " is-cover" : ""}`}
                draggable
                onDragStart={() => {
                  dragIndexRef.current = index;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndexRef.current;
                  if (from === null || from === index) return;
                  setEntries((prev) => {
                    const next = [...prev];
                    const [moved] = next.splice(from, 1);
                    next.splice(index, 0, moved);
                    return next;
                  });
                  dragIndexRef.current = null;
                }}
              >
                <div className="im">
                  <span className="plno">
                    Pl. {String(index + 1).padStart(2, "0")}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entry.src} alt="" />
                  {entry.status === "uploading" || entry.status === "queued" ? (
                    <span className="up-state" aria-hidden="true">
                      Uploading…
                    </span>
                  ) : null}
                </div>
                <div className="body">
                  {entry.status === "failed" ? (
                    <p className="warn" role="alert">
                      {entry.error ?? "Upload failed."}
                    </p>
                  ) : null}
                  <input
                    type="text"
                    value={entry.caption}
                    aria-label={`Caption for photograph ${index + 1}`}
                    placeholder="Caption (optional)"
                    onChange={(e) =>
                      patchEntry(entry.key, { caption: e.target.value })
                    }
                  />
                  <input
                    type="text"
                    className={missing ? "altwarn" : ""}
                    value={entry.alt}
                    aria-label={`Alt text for photograph ${index + 1} (required)`}
                    aria-invalid={missing || undefined}
                    placeholder="Alt text (required)"
                    onChange={(e) =>
                      patchEntry(entry.key, { alt: e.target.value })
                    }
                  />
                  {missing ? (
                    <p className="warn">Alt required to publish</p>
                  ) : null}
                  <div className="ctl">
                    <button
                      type="button"
                      aria-label={`Move photograph ${index + 1} earlier`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={`Move photograph ${index + 1} later`}
                      disabled={index === entries.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      →
                    </button>
                    {entry.status === "failed" &&
                    filesRef.current.has(entry.key) ? (
                      <button
                        type="button"
                        aria-label={`Retry upload of photograph ${index + 1}`}
                        onClick={() => retry(entry.key)}
                      >
                        Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Remove photograph ${index + 1}`}
                      onClick={() => remove(entry.key)}
                    >
                      Remove
                    </button>
                    <label className="cover">
                      <input
                        type="radio"
                        name="gallery-cover"
                        checked={isCover}
                        disabled={entry.status !== "ready"}
                        onChange={() => setCoverKey(entry.key)}
                      />
                      <span>Cover</span>
                    </label>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Bulk-add dropzone: multi-file / folder drop + OS multi-select. */}
      <div
        className="dropzone gallery-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <ImageDropzone
          id="gallery-bulk-file"
          multiple
          onFiles={(files) => enqueue(files)}
          dropLabel="Drag photographs (or a folder) here, or"
        />
        <p className="hint">
          Up to {HARD_CAP} per gallery · HEIC and large phone photos supported ·
          each uploads on its own, so one bad file won't fail the batch.
        </p>
      </div>

      <MediaPicker
        open={pickerOpen}
        title="Add photographs from the library"
        primaryLabel="Add"
        multiple
        onSelect={() => {}}
        onSelectMany={addFromLibrary}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

"use client";

// TagCombobox — the post editor's tag input (issue: admin tag management).
//
// Replaces the old free-text "comma-separated tags" input, which let an
// operator accidentally create near-duplicate tags (`self-hosting` vs
// `selfhosting`) because they never saw what already existed. This is a
// WAI-ARIA 1.2 "combobox with a list popup, editable, list autocomplete with
// automatic selection" pattern: a text input owns `role="combobox"`; a
// sibling `role="listbox"` holds the suggestions; the input's
// `aria-activedescendant` tracks the highlighted option so a screen reader
// announces it without moving DOM focus off the input (2.1.1 keyboard,
// 4.1.2 name/role/value).
//
// Selected tags render as chips ABOVE the input (each independently
// removable); typing searches existing tags via GET /api/admin/tags?q=; an
// exact-name match is never duplicated, and a query with no exact match
// always offers a stable "Create tag "<query>"" option so authoring a
// genuinely new tag is still one keystroke away.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { slugify } from "@/lib/slug";

export interface TagOption {
  name: string;
  slug: string;
}

interface RemoteTag {
  id: string;
  name: string;
  slug: string;
}

const DEBOUNCE_MS = 200;
const MAX_SUGGESTIONS = 8;

export function TagCombobox({
  id,
  value,
  onChange,
  placeholder = "Add a tag…",
}: {
  /** id for the visible text input (so an outer <label htmlFor> keeps working). */
  id?: string;
  value: TagOption[];
  onChange: (next: TagOption[]) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<RemoteTag[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedSlugs = useMemo(
    () => new Set(value.map((t) => t.slug)),
    [value],
  );

  // Debounced remote search, scoped to the query. Cancels the in-flight
  // request on the next keystroke/unmount so a slow response can never clobber
  // a newer, faster one (out-of-order network responses).
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch(`/api/admin/tags?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : { tags: [] }))
        .then((data: { tags?: RemoteTag[] }) => {
          setSuggestions(data.tags ?? []);
        })
        .catch(() => {
          // A failed/aborted lookup degrades to create-only mode — never crash
          // the editor over a flaky suggestions fetch.
          setSuggestions([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = query.trim();
  const querySlug = trimmedQuery ? slugify(trimmedQuery) : "";
  // Existing tags matching the query, minus ones already selected.
  const options: RemoteTag[] = suggestions
    .filter((t) => !selectedSlugs.has(t.slug))
    .slice(0, MAX_SUGGESTIONS);
  // Offer "create new" whenever the query doesn't exactly match an existing
  // option (by slug) — covers both "brand new tag" and "not selected yet but
  // no exact hit in the current suggestion page".
  const exactMatch = options.find((t) => t.slug === querySlug);
  const showCreateOption =
    trimmedQuery.length > 0 && !exactMatch && !selectedSlugs.has(querySlug);

  // Flat list actually rendered, so keyboard index math stays in one place.
  const rows: Array<{ kind: "existing"; tag: RemoteTag } | { kind: "create" }> =
    [
      ...options.map((tag) => ({ kind: "existing" as const, tag })),
      ...(showCreateOption ? [{ kind: "create" as const }] : []),
    ];

  const closeList = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const addTag = useCallback(
    (tag: TagOption) => {
      if (selectedSlugs.has(tag.slug)) return;
      onChange([...value, tag]);
      setQuery("");
      setSuggestions([]);
      closeList();
    },
    [value, onChange, selectedSlugs, closeList],
  );

  const removeTag = useCallback(
    (slug: string) => {
      onChange(value.filter((t) => t.slug !== slug));
    },
    [value, onChange],
  );

  function selectRow(row: (typeof rows)[number]) {
    if (row.kind === "existing") {
      addTag({ name: row.tag.name, slug: row.tag.slug });
    } else {
      addTag({ name: trimmedQuery, slug: querySlug });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(rows.length > 0 ? 0 : -1);
        return;
      }
      setActiveIndex((i) => (rows.length === 0 ? -1 : (i + 1) % rows.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open || rows.length === 0) return;
      setActiveIndex((i) => (i <= 0 ? rows.length - 1 : i - 1));
      return;
    }
    if (e.key === "Enter") {
      // Context-gated: only consume Enter when a highlighted option exists —
      // otherwise let it fall through (the surrounding <form> has no Enter
      // submit handler on this field, but a nested widget must never assume
      // that; this keeps the contract explicit).
      if (open && activeIndex >= 0 && activeIndex < rows.length) {
        e.preventDefault();
        selectRow(rows[activeIndex]!);
        return;
      }
      if (showCreateOption) {
        e.preventDefault();
        addTag({ name: trimmedQuery, slug: querySlug });
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        closeList();
      }
      return;
    }
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      // Backspace on an empty field removes the last chip — the standard
      // "chip input" affordance, still fully keyboard-driven.
      removeTag(value[value.length - 1]!.slug);
    }
  }

  const activeOptionId =
    open && activeIndex >= 0 && activeIndex < rows.length
      ? `${listboxId}-opt-${activeIndex}`
      : undefined;

  return (
    <div className="tag-combobox">
      {value.length > 0 && (
        <ul className="tag-chip-list plain-list" aria-label="Selected tags">
          {value.map((t) => (
            <li key={t.slug} className="tag-chip">
              <span>{t.name}</span>
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`Remove tag ${t.name}`}
                onClick={() => removeTag(t.slug)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="tag-combobox-input-wrap">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open && rows.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            if (query.trim().length > 0) setOpen(true);
          }}
          onBlur={() => {
            // Deferred so a click on an option (which blurs the input first)
            // still registers before the listbox unmounts.
            setTimeout(closeList, 100);
          }}
          onKeyDown={handleKeyDown}
        />
        {open && rows.length > 0 && (
          <ul id={listboxId} role="listbox" className="tag-listbox" aria-label="Tag suggestions">
            {rows.map((row, i) => {
              const optId = `${listboxId}-opt-${i}`;
              const active = i === activeIndex;
              const label =
                row.kind === "existing" ? row.tag.name : `Create tag "${trimmedQuery}"`;
              return (
                <li
                  key={row.kind === "existing" ? row.tag.id : "__create__"}
                  id={optId}
                  role="option"
                  aria-selected={active}
                  className="tag-option"
                  data-active={active ? "" : undefined}
                  data-create={row.kind === "create" ? "" : undefined}
                  // onMouseDown (not onClick) fires before the input's onBlur,
                  // so the selection lands before the listbox closes.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectRow(row);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  {label}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

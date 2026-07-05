"use client";

// MediaGrid — the shared responsive thumbnail grid used by the /admin/media
// library and the in-editor MediaPicker (issue 037 §2.2/§3.3).
//
// Accessibility (design §8):
//   - Roving tabindex composite: ONE tab stop enters the grid; Arrow keys move
//     focus cell-to-cell (Left/Right and, by measured column count, Up/Down),
//     Home/End jump to the ends. Enter/Space activate the focused cell (native
//     <button> behavior).
//   - Picker mode (selectable): role="listbox" + role="option" + aria-selected —
//     single-select semantics carry to assistive tech. Selection is never
//     color-only: an accent ring pairs with a ✓ badge (CSS) and aria-selected.
//   - Library mode: a plain list of buttons; activating one opens its detail
//     dialog. Each card button's accessible name = alt + dimensions + usage, so a
//     screen-reader user hears the context the visual chips convey.
//   - 2.4.7 focus visible: the global :focus-visible ring covers the focused cell.

import { useRef, useState } from "react";
import {
  type MediaItem,
  thumbUrl,
  cardAccessibleName,
} from "./types";

export interface MediaGridProps {
  items: MediaItem[];
  /** Picker single-select mode (role=listbox/option + aria-selected). */
  selectable?: boolean;
  selectedId?: string | null;
  /**
   * Multi-select mode (issue 047 gallery bulk-add): when provided, the grid is an
   * aria-multiselectable listbox and each card's aria-selected reflects set
   * membership; onActivate toggles a card in/out (the caller owns the set). Takes
   * precedence over the single-select selectedId for the aria-selected state.
   */
  multiSelectedIds?: readonly string[];
  /**
   * Library multiselect mode (issue 057): the grid stays a roving-tabindex list
   * whose cards OPEN detail on activate (Enter/click), AND supports a separate
   * selection set for bulk actions. Selection is toggled by Space (keyboard) or a
   * corner checkbox affordance (pointer) — distinct from the card's open action,
   * so single-item open still works. When enabled the grid is an
   * aria-multiselectable listbox and each card is role=option + aria-selected.
   */
  selectionEnabled?: boolean;
  /** The selected set (caller-owned) when selectionEnabled. */
  selectedIds?: readonly string[];
  /** Toggle a card in/out of the selection (Space or the corner checkbox). */
  onToggleSelect?: (item: MediaItem) => void;
  /** Library: open detail. Picker: select the card. Multi: toggle the card. */
  onActivate: (item: MediaItem) => void;
  /** Accessible name of the grid/listbox. */
  ariaLabel: string;
}

/** Count the cards sharing the first card's top edge = the grid's column count. */
function columnCount(container: HTMLElement): number {
  const cells = Array.from(
    container.querySelectorAll<HTMLElement>("[data-media-cell]"),
  );
  if (cells.length === 0) return 1;
  const firstTop = cells[0].offsetTop;
  let cols = 0;
  for (const cell of cells) {
    if (cell.offsetTop === firstTop) cols += 1;
    else break;
  }
  return Math.max(1, cols);
}

export function MediaGrid({
  items,
  selectable = false,
  selectedId = null,
  multiSelectedIds,
  selectionEnabled = false,
  selectedIds,
  onToggleSelect,
  onActivate,
  ariaLabel,
}: MediaGridProps) {
  const multi = multiSelectedIds !== undefined;
  const multiSet = multi ? new Set(multiSelectedIds) : null;
  const librarySelectSet =
    selectionEnabled ? new Set(selectedIds ?? []) : null;
  const listRef = useRef<HTMLUListElement>(null);
  // The roving tab stop FOLLOWS the focused cell (ARIA APG roving-tabindex).
  // Tracking it in state — not just calling .focus() imperatively — is what makes
  // Tab-out-and-back return to the LAST-focused card, not always card 0
  // (QA finding 4). onFocus keeps it synced when focus enters via Tab or click.
  const [focusedIndex, setFocusedIndex] = useState(0);
  const activeIndex =
    items.length === 0 ? 0 : Math.min(focusedIndex, items.length - 1);

  function moveFocus(next: number) {
    if (next < 0 || next >= items.length) return;
    setFocusedIndex(next);
    const cells = listRef.current?.querySelectorAll<HTMLButtonElement>(
      "[data-media-cell] button",
    );
    cells?.[next]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const container = listRef.current;
    if (!container) return;
    // Library multiselect: Space toggles selection (preventDefault stops the
    // button's default activate-on-Space); Enter still opens detail via onClick.
    if (selectionEnabled && (e.key === " " || e.key === "Spacebar")) {
      e.preventDefault();
      onToggleSelect?.(items[index]);
      return;
    }
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowLeft":
        next = index - 1;
        break;
      case "ArrowDown":
        next = index + columnCount(container);
        break;
      case "ArrowUp":
        next = index - columnCount(container);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    if (next === null) return;
    e.preventDefault();
    moveFocus(next);
  }

  return (
    <ul
      ref={listRef}
      className={selectionEnabled ? "media-grid media-grid--select" : "media-grid"}
      role={selectable || selectionEnabled ? "listbox" : undefined}
      aria-multiselectable={multi || selectionEnabled ? true : undefined}
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const selected = librarySelectSet
          ? librarySelectSet.has(item.id)
          : multiSet
            ? multiSet.has(item.id)
            : selectable && selectedId === item.id;
        // Roving tabindex: exactly one cell (the focused one) is tabbable; the
        // rest are -1 and reached via Arrow keys. aria-selected (picker/library)
        // is independent of the tab stop — selection ≠ focus.
        const optionRole = selectable || selectionEnabled;
        const emptyAlt = item.alt.trim() === "";
        return (
          <li key={item.id} className="media-card" data-media-cell="">
            {selectionEnabled ? (
              // Pointer selection affordance: a checkbox distinct from the card's
              // open action. tabIndex=-1 + aria-hidden — keyboard/AT users select
              // via Space on the option (authoritative aria-selected below); this
              // is a mouse target that mirrors the state. stopPropagation so a
              // click here selects without also opening the detail dialog.
              <button
                type="button"
                className="media-card__select"
                tabIndex={-1}
                aria-hidden="true"
                data-checked={selected ? "true" : "false"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect?.(item);
                }}
              >
                <span aria-hidden="true">✓</span>
              </button>
            ) : null}
            <button
              type="button"
              className="media-card__button"
              role={optionRole ? "option" : undefined}
              aria-selected={optionRole ? selected : undefined}
              aria-label={
                selectionEnabled
                  ? `${cardAccessibleName(item)}${selected ? " (selected)" : ""}`
                  : cardAccessibleName(item)
              }
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setFocusedIndex(index)}
              onClick={() => onActivate(item)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              <span className="media-card__thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbUrl(item)} alt="" loading="lazy" />
                <span className="media-card__check" aria-hidden="true">
                  ✓
                </span>
              </span>
              <span
                className={
                  emptyAlt
                    ? "media-card__alt media-card__alt--empty"
                    : "media-card__alt"
                }
                aria-hidden="true"
              >
                {emptyAlt ? "No description" : item.alt}
              </span>
              <span className="media-card__meta" aria-hidden="true">
                {item.width && item.height ? (
                  <span className="media-card__dims">
                    {item.width}×{item.height}
                  </span>
                ) : null}
                {item.usageCount > 0 ? (
                  <span className="status-pill" data-status="published">
                    Used ·{item.usageCount}
                  </span>
                ) : (
                  <span className="muted">Unused</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

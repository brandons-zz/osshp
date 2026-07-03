import { describe, expect, test } from "bun:test";
import {
  collectSlots,
  createThemeRegistry,
  emptySlots,
  selectActiveTheme,
  type SlotContribution,
} from "../registry";
import { THEME_SLOT_IDS, type SanitizedHtml } from "../types";
import { testTheme } from "./test-theme";

describe("theme registry (swap seam, §4)", () => {
  test("register / get / has / list", () => {
    const r = createThemeRegistry();
    expect(r.has("test-theme")).toBe(false);
    r.register(testTheme);
    expect(r.has("test-theme")).toBe(true);
    expect(r.get("test-theme")?.name).toBe("Test Theme");
    expect(r.list().map((t) => t.id)).toEqual(["test-theme"]);
  });

  test("selectActiveTheme resolves the active id, falling back to the first", () => {
    const r = createThemeRegistry([testTheme]);
    expect(selectActiveTheme(r, "test-theme")?.id).toBe("test-theme");
    // A stale active id falls back so the site still renders.
    expect(selectActiveTheme(r, "does-not-exist")?.id).toBe("test-theme");
    expect(selectActiveTheme(r, undefined)?.id).toBe("test-theme");
  });
});

describe("slot registry (module seam, §8)", () => {
  test("emptySlots keys every ThemeSlotId to an empty array", () => {
    const slots = emptySlots();
    for (const id of THEME_SLOT_IDS) {
      expect(slots[id]).toEqual([]);
    }
  });

  test("collectSlots groups by slot and orders deterministically by `order`", () => {
    const html = (s: string) => s as unknown as SanitizedHtml;
    const contributions: SlotContribution[] = [
      { slot: "head.meta", sourceModuleId: "b", order: 2, html: html("<b>") },
      { slot: "head.meta", sourceModuleId: "a", order: 1, html: html("<a>") },
      { slot: "footer.widgets", sourceModuleId: "f", order: 1, html: html("<f>") },
    ];
    const slots = collectSlots(contributions);
    expect(slots["head.meta"].map((s) => s.sourceModuleId)).toEqual(["a", "b"]);
    expect(slots["footer.widgets"]).toHaveLength(1);
    expect(slots["post.aside"]).toEqual([]);
  });
});

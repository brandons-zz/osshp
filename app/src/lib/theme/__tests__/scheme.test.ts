import { describe, expect, test } from "bun:test";
import { noFlashScript, resolveScheme, SCHEME_STORAGE_KEY } from "../scheme";

describe("resolveScheme (§6 resolution order)", () => {
  test("a valid visitor override beats the operator default", () => {
    expect(resolveScheme("dark", "light")).toBe("dark");
    expect(resolveScheme("light", "dark")).toBe("light");
  });

  test("an invalid/absent override falls through to the operator default", () => {
    expect(resolveScheme(null, "dark")).toBe("dark");
    expect(resolveScheme("garbage", "light")).toBe("light");
    expect(resolveScheme(undefined, "dark")).toBe("dark");
  });

  test("operator default 'auto' resolves via prefers-color-scheme", () => {
    expect(resolveScheme(null, "auto", true)).toBe("dark");
    expect(resolveScheme(null, "auto", false)).toBe("light");
    // a visitor override still wins over auto.
    expect(resolveScheme("light", "auto", true)).toBe("light");
  });
});

describe("noFlashScript (pre-paint hook, §6)", () => {
  const script = noFlashScript();

  test("is a self-contained IIFE wrapped in try/catch", () => {
    expect(script.startsWith("(function(){try{")).toBe(true);
    expect(script).toContain("catch(e)");
  });

  test("reads the persisted key and sets data-scheme + color-scheme before paint", () => {
    expect(script).toContain(JSON.stringify(SCHEME_STORAGE_KEY));
    expect(script).toContain("cookie");
    expect(script).toContain("localStorage");
    expect(script).toContain("setAttribute('data-scheme'");
    expect(script).toContain("colorScheme");
  });

  test("only acts on a valid light/dark override (no flash for default)", () => {
    expect(script).toContain("v==='light'||v==='dark'");
  });
});

// Issues 081 + 082 — admin shell chrome: the light/dark toggle and the
// running-build version footer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { nextScheme } from "../SchemeToggle";
import { OSSHP_VERSION } from "@/lib/version";

const LAYOUT = readFileSync(join(import.meta.dir, "..", "layout.tsx"), "utf8");
const PKG = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "package.json"), "utf8"),
) as { version: string };

test("082: the version shown is package.json's version, not a literal", () => {
  expect(OSSHP_VERSION).toBe(PKG.version);
  expect(OSSHP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  // Rendered from the constant — no hardcoded version string in the layout.
  expect(LAYOUT).toContain("v{OSSHP_VERSION}");
  expect(LAYOUT).not.toMatch(/v\d+\.\d+\.\d+/);
});

test("082: the version footer sits in the layout every admin page renders in", () => {
  expect(LAYOUT).toContain('className="shell-footer"');
});

test("081: the toggle is rendered in the admin nav", () => {
  expect(LAYOUT).toContain("<SchemeToggle />");
});

test("081: a click flips dark ↔ light (anything not dark becomes dark)", () => {
  expect(nextScheme("dark")).toBe("light");
  expect(nextScheme("light")).toBe("dark");
  expect(nextScheme(null)).toBe("dark");
});

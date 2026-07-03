// Regression guard for issue 027's "admin never locks itself out" acceptance
// criterion. AdminLayout.tsx renders two kinds of nav links: module-driven
// (`caps.adminNav`, projected from the enabled-module set — the correct place
// for a disabled module to disappear) and core admin surfaces that are NOT
// owned by any module. If the four core surfaces below were ever folded into
// the module-driven `nav.map()` block, disabling every module would strand the
// operator with no way back into Settings. A source-content scan (rather than a
// full render, which needs next/navigation + next/headers + a session) is
// enough to pin this invariant.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const SRC = readFileSync(join(import.meta.dir, "..", "layout.tsx"), "utf8");

const CORE_HREFS = [
  "/admin/settings",
  "/admin/account/security",
  "/admin/export",
  "/admin/import",
];

test("AdminLayout hardcodes Settings/Account/Export/Import as unconditional literal links", () => {
  for (const href of CORE_HREFS) {
    expect(SRC).toContain(`href="${href}"`);
  }
});

test("the core links live OUTSIDE the module-driven nav.map() block", () => {
  const mapStart = SRC.indexOf("{nav.map(");
  expect(mapStart).toBeGreaterThan(-1);
  const mapEnd = SRC.indexOf("))}", mapStart);
  expect(mapEnd).toBeGreaterThan(mapStart);
  const mapBlock = SRC.slice(mapStart, mapEnd);
  for (const href of CORE_HREFS) {
    expect(mapBlock).not.toContain(href);
  }
});

// The Tiptap Cloud/Pro exclusion guard (library audit FLAG-2) must FAIL the build
// when any proprietary Cloud/Pro tier package is imported, and PASS on a clean
// tree. This drives the real shell script the pre-push gate runs.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "../../../../scripts/check-tiptap-cloud.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tiptap-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runGuard(scanRoot: string): number {
  const proc = Bun.spawnSync(["bash", GUARD, scanRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode ?? -1;
}

test("PASSES (exit 0) on a tree using only MIT TipTap packages", () => {
  writeFileSync(
    join(dir, "editor.ts"),
    `import StarterKit from "@tiptap/starter-kit";\nimport { useEditor } from "@tiptap/react";\nexport const e = StarterKit;\n`,
  );
  expect(runGuard(dir)).toBe(0);
});

test("FAILS (non-zero) on a planted @tiptap-pro import", () => {
  writeFileSync(
    join(dir, "bad.ts"),
    `import { Ai } from "@tiptap-pro/extension-ai";\nexport const a = Ai;\n`,
  );
  expect(runGuard(dir)).not.toBe(0);
});

test("FAILS on a planted collaboration extension (Cloud-tier)", () => {
  writeFileSync(
    join(dir, "collab.ts"),
    `import Collaboration from "@tiptap/extension-collaboration";\nexport const c = Collaboration;\n`,
  );
  expect(runGuard(dir)).not.toBe(0);
});

test("FAILS on a planted Cloud dependency declared in package.json", () => {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@hocuspocus/server": "^2.0.0" } }, null, 2),
  );
  expect(runGuard(dir)).not.toBe(0);
});

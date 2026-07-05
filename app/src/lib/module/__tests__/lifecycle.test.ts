import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { getSetting, setSetting } from "@/lib/content/settings";
import type { SanitizedHtml } from "@/lib/theme/types";
import { createModuleRegistry } from "../registry";
import {
  ENABLED_MODULES_KEY,
  collectModuleSlots,
  disableModule,
  enableModule,
  getActiveCapabilities,
  getEnabledModuleIds,
  isEnabled,
  setEnabledModules,
} from "../lifecycle";
import type { ModuleManifest, ModuleSlotContext } from "../types";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb({ seed: true });
  db = h.db;
});
afterEach(() => h.close());

// Test-only slot context: the real sanitizer is the app's (theme-contract §9);
// the wiring under test does not depend on its internals.
const slotCtx: ModuleSlotContext = {
  sanitize: (raw) => raw as unknown as SanitizedHtml,
};

// A module whose onEnable writes a piece of data we can later prove survives a
// disable. Throwaway fixture — the real modules are M1.8/M2.
function demoManifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    id: "demo",
    name: "Demo",
    description: "Demo module.",
    version: "1.0.0",
    routes: [{ path: "/demo", access: "public", render: "post-list" }],
    themeHooks: [
      {
        slot: "post.aside",
        render: (ctx) => ({
          sourceModuleId: "demo",
          order: 1,
          html: ctx.sanitize("<p>demo aside</p>"),
        }),
      },
    ],
    lifecycle: {
      onEnable: async ({ db }) => {
        await setSetting(db, "demo.installed", true, "admin");
      },
    },
    ...overrides,
  };
}

test("enableModule writes the single toggle (site.enabledModules) and runs onEnable", async () => {
  const reg = createModuleRegistry([demoManifest()]);
  await enableModule(db, reg, "demo");

  const ids = await getEnabledModuleIds(db);
  expect(ids).toContain("demo");
  expect(isEnabled(ids, "demo")).toBe(true);
  // It wrote via the SAME settings key the seed declares.
  expect(await getSetting(db, ENABLED_MODULES_KEY)).toEqual(["demo"]);
  // onEnable ran.
  expect(await getSetting(db, "demo.installed")).toBe(true);
});

test("enable is idempotent — re-enabling does not duplicate the id", async () => {
  const reg = createModuleRegistry([demoManifest()]);
  await enableModule(db, reg, "demo");
  await enableModule(db, reg, "demo");
  expect(await getEnabledModuleIds(db)).toEqual(["demo"]);
});

test("disabling a module removes the toggle but PRESERVES its data (reversible)", async () => {
  const reg = createModuleRegistry([demoManifest()]);
  await enableModule(db, reg, "demo");
  // Simulate real module-owned content/settings written while enabled.
  await setSetting(db, "demo.postsPerPage", 42, "admin");
  expect(await getSetting(db, "demo.installed")).toBe(true);

  await disableModule(db, reg, "demo");

  // The toggle no longer lists it...
  expect(await getEnabledModuleIds(db)).not.toContain("demo");
  // ...but NONE of its data was deleted — disable is a deactivation, not a destroy.
  expect(await getSetting(db, "demo.installed")).toBe(true);
  expect(await getSetting(db, "demo.postsPerPage")).toBe(42);

  // And re-enabling brings it back live with its data intact.
  await enableModule(db, reg, "demo");
  expect(await getEnabledModuleIds(db)).toContain("demo");
  expect(await getSetting(db, "demo.postsPerPage")).toBe(42);
});

test("a disabled module's capabilities are inert; an enabled module's are live", async () => {
  const reg = createModuleRegistry([demoManifest()]);

  // Before enabling, nothing is mounted.
  let active = getActiveCapabilities(reg, await getEnabledModuleIds(db));
  expect(active.routes.find((r) => r.moduleId === "demo")).toBeUndefined();

  await enableModule(db, reg, "demo");
  active = getActiveCapabilities(reg, await getEnabledModuleIds(db));
  expect(active.routes.find((r) => r.path === "/demo")?.moduleId).toBe("demo");

  await disableModule(db, reg, "demo");
  active = getActiveCapabilities(reg, await getEnabledModuleIds(db));
  expect(active.routes.find((r) => r.moduleId === "demo")).toBeUndefined();
});

test("theme hooks plug into the EXISTING slot registry (collectSlots) — enabled only", async () => {
  const reg = createModuleRegistry([demoManifest()]);

  // Disabled → no contribution in any slot.
  let slots = collectModuleSlots(reg, await getEnabledModuleIds(db), slotCtx);
  expect(slots["post.aside"]).toHaveLength(0);
  // The map is fully keyed by ThemeSlotId (proof it is the M1.4 registry shape).
  expect(slots["head.meta"]).toEqual([]);
  expect(Object.keys(slots).sort()).toEqual(
    ["footer.widgets", "head.meta", "header.nav", "home.section", "post.aside", "post.belowBody"].sort(),
  );

  // Enabled → the contribution appears under its declared ThemeSlotId.
  await enableModule(db, reg, "demo");
  slots = collectModuleSlots(reg, await getEnabledModuleIds(db), slotCtx);
  expect(slots["post.aside"]).toHaveLength(1);
  expect(slots["post.aside"][0].sourceModuleId).toBe("demo");
  expect(slots["post.aside"][0].html).toBe("<p>demo aside</p>");
});

test("enableModule refuses an invalid module — it never mounts", async () => {
  const reg = createModuleRegistry([demoManifest({ id: "BAD_ID" })]);
  expect(enableModule(db, reg, "BAD_ID")).rejects.toThrow(/invalid module/);
  expect(await getEnabledModuleIds(db)).not.toContain("BAD_ID");
});

test("enableModule refuses an unknown module", async () => {
  const reg = createModuleRegistry();
  expect(enableModule(db, reg, "ghost")).rejects.toThrow(/unknown module/);
});

// ── setEnabledModules — the admin module-toggle write path (issue 027) ────────

// A second demo module whose onEnable/onDisable each count their own calls, so
// a test can prove "unchanged ids are left untouched" (no redundant hook runs).
function countingManifest(id: string): {
  manifest: ModuleManifest;
  enableCalls: () => number;
  disableCalls: () => number;
} {
  let enableCalls = 0;
  let disableCalls = 0;
  return {
    manifest: {
      id,
      name: id,
      description: `${id} module.`,
      version: "1.0.0",
      lifecycle: {
        onEnable: async () => {
          enableCalls += 1;
        },
        onDisable: async () => {
          disableCalls += 1;
        },
      },
    },
    enableCalls: () => enableCalls,
    disableCalls: () => disableCalls,
  };
}

test("setEnabledModules rejects an unknown id and writes NOTHING", async () => {
  const reg = createModuleRegistry([demoManifest()]);
  const result = await setEnabledModules(db, reg, ["demo", "ghost"]);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/unknown module id: ghost/);
  // The whole request is rejected — "demo" was NOT enabled either.
  expect(await getEnabledModuleIds(db)).not.toContain("demo");
});

test("setEnabledModules rejects an invalid (registered-but-broken) module id", async () => {
  const reg = createModuleRegistry([demoManifest({ id: "BAD_ID" })]);
  const result = await setEnabledModules(db, reg, ["BAD_ID"]);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/unknown module id: BAD_ID/);
});

test("setEnabledModules enables newly-requested ids and disables dropped ids", async () => {
  const a = countingManifest("mod-a");
  const b = countingManifest("mod-b");
  const reg = createModuleRegistry([a.manifest, b.manifest]);

  let result = await setEnabledModules(db, reg, ["mod-a"]);
  expect(result.ok).toBe(true);
  expect(result.enabled.sort()).toEqual(["mod-a"]);
  expect(a.enableCalls()).toBe(1);
  expect(b.enableCalls()).toBe(0);

  // Swap which module is enabled in one call.
  result = await setEnabledModules(db, reg, ["mod-b"]);
  expect(result.ok).toBe(true);
  expect(result.enabled.sort()).toEqual(["mod-b"]);
  expect(a.disableCalls()).toBe(1);
  expect(b.enableCalls()).toBe(1);
});

test("setEnabledModules leaves an already-enabled id untouched (no redundant hook run)", async () => {
  const a = countingManifest("mod-a");
  const reg = createModuleRegistry([a.manifest]);

  await setEnabledModules(db, reg, ["mod-a"]);
  expect(a.enableCalls()).toBe(1);

  // Calling again with the SAME desired set must not re-run onEnable.
  await setEnabledModules(db, reg, ["mod-a"]);
  expect(a.enableCalls()).toBe(1);
  expect(a.disableCalls()).toBe(0);
});

test("setEnabledModules can disable every module — the write path never errors on an empty set", async () => {
  const a = countingManifest("mod-a");
  const b = countingManifest("mod-b");
  const reg = createModuleRegistry([a.manifest, b.manifest]);

  await setEnabledModules(db, reg, ["mod-a", "mod-b"]);
  const result = await setEnabledModules(db, reg, []);
  expect(result.ok).toBe(true);
  expect(result.enabled).toEqual([]);
  expect(a.disableCalls()).toBe(1);
  expect(b.disableCalls()).toBe(1);
});

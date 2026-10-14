// Issue 081 — the app shell (admin/login/setup) participates in the scheme
// system. appShellSchemeScript() is executed against a minimal fake DOM (bun
// test has no jsdom in this repo) so its real behavior is asserted, not its
// source text.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appShellSchemeScript,
  firstCookieValue,
  resolveAppShellScheme,
  SCHEME_STORAGE_KEY,
} from "../scheme";

interface FakeEnv {
  cookie?: string;
  stored?: string | null;
  ssr?: string; // data-scheme the server emitted on <html>
  prefersDark?: boolean;
  storageThrows?: boolean;
}

function run(env: FakeEnv) {
  const attrs = new Map<string, string>();
  if (env.ssr) attrs.set("data-scheme", env.ssr);
  const style: { colorScheme?: string } = {};
  let changeListener: ((ev: { matches: boolean }) => void) | null = null;
  const documentElement = {
    style,
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    hasAttribute: (n: string) => attrs.has(n),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
  const document = { cookie: env.cookie ?? "", documentElement };
  const localStorage = {
    getItem: (k: string) => {
      if (env.storageThrows) throw new Error("SecurityError");
      return k === SCHEME_STORAGE_KEY ? (env.stored ?? null) : null;
    },
  };
  const window = {
    matchMedia: () => ({
      matches: !!env.prefersDark,
      addEventListener: (_: string, fn: (ev: { matches: boolean }) => void) => {
        changeListener = fn;
      },
    }),
  };
  new Function("document", "localStorage", "window", appShellSchemeScript())(
    document,
    localStorage,
    window,
  );
  return {
    scheme: () => attrs.get("data-scheme") ?? null,
    auto: () => attrs.has("data-scheme-auto"),
    colorScheme: () => style.colorScheme,
    osChange: (matches: boolean) => changeListener?.({ matches }),
    pick: (v: string) => {
      // what SchemeToggle does on click
      attrs.set("data-scheme", v);
      attrs.delete("data-scheme-auto");
    },
  };
}

describe("appShellSchemeScript (pre-paint, issue 081)", () => {
  test("a persisted cookie choice wins over the server-emitted default", () => {
    const r = run({ cookie: `${SCHEME_STORAGE_KEY}=dark`, ssr: "light" });
    expect(r.scheme()).toBe("dark");
    expect(r.colorScheme()).toBe("dark");
    expect(r.auto()).toBe(false);
  });

  test("a localStorage-only choice wins over the server-emitted default", () => {
    const r = run({ stored: "light", ssr: "dark", prefersDark: true });
    expect(r.scheme()).toBe("light");
  });

  test("an explicit operator default (SSR'd) is kept regardless of the OS", () => {
    expect(run({ ssr: "dark", prefersDark: false }).scheme()).toBe("dark");
    expect(run({ ssr: "light", prefersDark: true }).scheme()).toBe("light");
  });

  test("auto with no override follows the OS preference", () => {
    const dark = run({ prefersDark: true });
    expect(dark.scheme()).toBe("dark");
    expect(dark.auto()).toBe(true);
    expect(run({ prefersDark: false }).scheme()).toBe("light");
  });

  test("auto keeps following live OS changes until the user picks", () => {
    const r = run({ prefersDark: false });
    r.osChange(true);
    expect(r.scheme()).toBe("dark");
    r.pick("light");
    r.osChange(true);
    expect(r.scheme()).toBe("light"); // explicit choice is not overridden
  });

  test("garbage / malformed values never throw and fall through", () => {
    expect(run({ cookie: `${SCHEME_STORAGE_KEY}=%`, prefersDark: true }).scheme()).toBe("dark");
    expect(run({ cookie: `${SCHEME_STORAGE_KEY}=purple`, ssr: "light" }).scheme()).toBe("light");
    expect(run({ storageThrows: true, ssr: "dark" }).scheme()).toBe("dark");
  });
});

describe("resolveAppShellScheme (server half, issue 081)", () => {
  test("persisted override, then explicit operator default", () => {
    expect(resolveAppShellScheme("dark", "light")).toBe("dark");
    expect(resolveAppShellScheme(undefined, "dark")).toBe("dark");
    expect(resolveAppShellScheme("bogus", "light")).toBe("light");
  });

  test("auto / unknown / missing defaults defer to the client (null)", () => {
    expect(resolveAppShellScheme(undefined, "auto")).toBeNull();
    expect(resolveAppShellScheme(null, undefined)).toBeNull();
    expect(resolveAppShellScheme(null, 42)).toBeNull();
  });
});

describe("shell.css keys dark tokens on data-scheme (issue 081)", () => {
  const css = readFileSync(
    join(import.meta.dir, "..", "..", "..", "styles", "shell.css"),
    "utf8",
  );

  test("no prefers-color-scheme media query gates the shell palette any more", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, ""); // ignore comments
    expect(code).not.toContain("prefers-color-scheme");
  });

  test("the dark block is keyed on [data-scheme=\"dark\"] and keeps the audited nav accent", () => {
    const start = css.indexOf(':root[data-scheme="dark"] {');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}\n", start));
    expect(block).toContain("--bg: #131417;");
    // v0.5.2 durable-contrast token (7.48:1 on --nav-active-bg) must survive.
    expect(block).toContain("--nav-accent-bar: #9bb6ff;");
    expect(block).toContain("--nav-active-bg: #1a2740;");
  });
});

describe("firstCookieValue (issue 081: server/client cookie parity)", () => {
  test("returns the FIRST match, like the pre-paint regex", () => {
    expect(firstCookieValue("osshp-scheme=dark; osshp-scheme=light", "osshp-scheme")).toBe("dark");
    expect(firstCookieValue("a=1; osshp-scheme=light", "osshp-scheme")).toBe("light");
  });
  test("missing, empty or malformed → null, never throws", () => {
    expect(firstCookieValue(null, "osshp-scheme")).toBeNull();
    expect(firstCookieValue("", "osshp-scheme")).toBeNull();
    expect(firstCookieValue("other=1", "osshp-scheme")).toBeNull();
    expect(firstCookieValue("osshp-scheme=%", "osshp-scheme")).toBeNull();
  });
  test("does not match a cookie whose name merely ends with the key", () => {
    expect(firstCookieValue("xosshp-scheme=dark", "osshp-scheme")).toBeNull();
  });
});

// Issue 081: the app shell's operator-scheme read is time-bounded, and a
// timeout/error falls back to the last value read rather than "auto".

import { beforeEach, expect, test } from "bun:test";
import { readOperatorScheme, resetOperatorSchemeCache } from "../operator-scheme";

const never = () => new Promise<never>(() => {});
beforeEach(() => resetOperatorSchemeCache());

test("returns the value when the read answers in time", async () => {
  expect(await readOperatorScheme(async () => "dark", 50)).toBe("dark");
});

test("a hung read is cut off and falls back to auto when nothing is known yet", async () => {
  const t0 = Date.now();
  expect(await readOperatorScheme(never, 30)).toBe("auto");
  expect(Date.now() - t0).toBeLessThan(500);
});

test("after a successful read, a timeout returns the last known value (not auto)", async () => {
  await readOperatorScheme(async () => "dark", 50);
  expect(await readOperatorScheme(never, 30)).toBe("dark");
});

test("after a successful read, an error returns the last known value", async () => {
  await readOperatorScheme(async () => "light", 50);
  expect(
    await readOperatorScheme(async () => {
      throw new Error("db down");
    }, 50),
  ).toBe("light");
});

test("a later successful read replaces the remembered value", async () => {
  await readOperatorScheme(async () => "dark", 50);
  await readOperatorScheme(async () => "auto", 50);
  expect(await readOperatorScheme(never, 30)).toBe("auto");
});

test("a read rejecting after the timeout won is handled (no unhandled rejection)", async () => {
  let rejectLate!: (e: Error) => void;
  const late = new Promise<never>((_, r) => (rejectLate = r));
  expect(await readOperatorScheme(() => late, 20)).toBe("auto");
  rejectLate(new Error("late"));
  await new Promise((r) => setTimeout(r, 10));
});

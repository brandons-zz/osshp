// Visitor-hash + daily-salt-rotation unit tests (issue 029 acceptance evidence: the
// unlinkability property the privacy posture depends on).

import { beforeEach, expect, test } from "bun:test";
import { hashVisitor, utcDayString } from "../hash";
import { _resetDaySaltCacheForTests } from "../salt";

beforeEach(() => {
  _resetDaySaltCacheForTests();
});

test("the same (ip, ua, day) hashes identically within the same day (exact same-day dedup)", () => {
  const a = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  const b = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  expect(a).toBe(b);
});

test("the same visitor on two different days produces two UNRELATED hashes (unlinkable across days)", () => {
  const day1 = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  // Force a fresh salt for the new day the way a real day-rollover would (the
  // cache key is the day string itself, so passing a different day already
  // rotates the salt — this call does NOT need the manual reset).
  const day2 = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-05");
  expect(day1).not.toBe(day2);
});

test("a process restart mid-day (cache reset) also changes the hash — no persisted salt to recover", () => {
  const before = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  _resetDaySaltCacheForTests();
  const after = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  expect(before).not.toBe(after);
});

test("different visitors on the same day produce different hashes", () => {
  const a = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  const b = hashVisitor("203.0.113.6", "Mozilla/5.0 Test", "2026-07-04");
  const c = hashVisitor("203.0.113.5", "Mozilla/5.0 Other", "2026-07-04");
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
});

test("the hash never contains the raw ip/ua (defensive substring check)", () => {
  const h = hashVisitor("203.0.113.5", "Mozilla/5.0 Test", "2026-07-04");
  expect(h).not.toContain("203.0.113.5");
  expect(h.toLowerCase()).not.toContain("mozilla");
  expect(h).toMatch(/^[0-9a-f]{64}$/); // hex sha256 digest, nothing else
});

test("utcDayString formats as YYYY-MM-DD in UTC", () => {
  expect(utcDayString(new Date("2026-07-04T23:59:59.000Z"))).toBe("2026-07-04");
  expect(utcDayString(new Date("2026-07-05T00:00:00.000Z"))).toBe("2026-07-05");
});

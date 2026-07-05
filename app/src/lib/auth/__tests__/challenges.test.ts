// WebAuthn challenge store: single-use + TTL (auth-security-assessment W1).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import {
  consumeChallenge,
  consumeLoginChallenge,
  newCeremonyId,
  storeChallenge,
  storeLoginChallenge,
} from "../challenges";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("a stored challenge is consumed exactly once (no replay, W1)", async () => {
  await storeChallenge(db, "registration", "challenge-abc");
  expect(await consumeChallenge(db, "registration")).toBe("challenge-abc");
  // Second consume of the same challenge must fail — it was deleted on first use.
  expect(await consumeChallenge(db, "registration")).toBeNull();
});

test("consuming an absent challenge returns null", async () => {
  expect(await consumeChallenge(db, "authentication")).toBeNull();
});

test("storing again overwrites the in-flight challenge for that type", async () => {
  await storeChallenge(db, "registration", "first");
  await storeChallenge(db, "registration", "second");
  expect(await consumeChallenge(db, "registration")).toBe("second");
});

test("an expired challenge does not authenticate and is still consumed", async () => {
  await storeChallenge(db, "authentication", "stale", -1000);
  expect(await consumeChallenge(db, "authentication")).toBeNull();
  // It was deleted even though expired — cannot be resurrected.
  expect(await consumeChallenge(db, "authentication")).toBeNull();
});

test("registration and authentication challenges are independent", async () => {
  await storeChallenge(db, "registration", "reg");
  await storeChallenge(db, "authentication", "auth");
  expect(await consumeChallenge(db, "registration")).toBe("reg");
  expect(await consumeChallenge(db, "authentication")).toBe("auth");
});

// ── Login-lane ceremony scoping (issue 075) ──────────────────────────────────
//
// The regression this whole block guards against: an unauthenticated caller
// clobbering the admin's in-flight login challenge by calling
// POST /api/auth/login/options concurrently. Pre-fix, storeChallenge(db,
// "authentication", ...) shared ONE row keyed on the literal "authentication" —
// a second caller's store silently overwrote the first caller's challenge, so
// the first caller's later (correctly-signed, but now stale) verify failed.

test("a login ceremony's challenge is scoped to its own ceremony id and single-use", async () => {
  const ceremonyId = newCeremonyId();
  await storeLoginChallenge(db, ceremonyId, "challenge-abc");
  expect(await consumeLoginChallenge(db, ceremonyId)).toBe("challenge-abc");
  // Second consume of the same ceremony must fail — deleted on first use (W1).
  expect(await consumeLoginChallenge(db, ceremonyId)).toBeNull();
});

test("two concurrent login ceremonies do NOT clobber each other (issue 075 core fix)", async () => {
  // Simulates: admin loads /login and gets a challenge (ceremony A) — before
  // they complete the passkey prompt, an unrelated caller (attacker) also
  // calls /login/options (ceremony B). Pre-fix, B's store would have
  // overwritten A's shared row; post-fix, each has its own row.
  const ceremonyA = newCeremonyId();
  const ceremonyB = newCeremonyId();
  await storeLoginChallenge(db, ceremonyA, "admin-challenge");
  await storeLoginChallenge(db, ceremonyB, "attacker-challenge");

  // Ceremony ids are themselves unique (no accidental collision in the fixture).
  expect(ceremonyA).not.toBe(ceremonyB);

  // A's (the admin's) challenge is exactly what A was issued — NOT clobbered
  // by B's later store. This is the literal AC: "caller A's verify does not
  // fail because caller B also requested options in the meantime."
  expect(await consumeLoginChallenge(db, ceremonyA)).toBe("admin-challenge");
  // B's own challenge is independently retrievable too.
  expect(await consumeLoginChallenge(db, ceremonyB)).toBe("attacker-challenge");
});

test("consuming a stale/foreign ceremony id returns null (verify must reject it)", async () => {
  const ceremonyA = newCeremonyId();
  await storeLoginChallenge(db, ceremonyA, "admin-challenge");
  // A foreign id that was never stored (e.g. a forged/guessed cookie value).
  expect(await consumeLoginChallenge(db, newCeremonyId())).toBeNull();
  // No ceremony id at all (no login-ceremony cookie on the request).
  expect(await consumeLoginChallenge(db, undefined)).toBeNull();
  // The real ceremony is untouched by those failed lookups.
  expect(await consumeLoginChallenge(db, ceremonyA)).toBe("admin-challenge");
});

test("an expired login ceremony does not authenticate and is still consumed", async () => {
  const ceremonyId = newCeremonyId();
  await storeLoginChallenge(db, ceremonyId, "stale", -1000);
  expect(await consumeLoginChallenge(db, ceremonyId)).toBeNull();
  // Deleted even though expired — cannot be resurrected by a second attempt.
  expect(await consumeLoginChallenge(db, ceremonyId)).toBeNull();
});

test("newCeremonyId is high-entropy (matches the session id floor, S1)", () => {
  // 256-bit id => 64 hex chars, same floor sessions.ts uses.
  const id = newCeremonyId();
  expect(id.length).toBe(64);
  expect(/^[0-9a-f]{64}$/.test(id)).toBe(true);
  // Two calls never collide in practice.
  expect(newCeremonyId()).not.toBe(id);
});

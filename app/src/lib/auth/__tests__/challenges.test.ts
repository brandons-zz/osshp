// WebAuthn challenge store: single-use + TTL (auth-security-assessment W1).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { consumeChallenge, storeChallenge } from "../challenges";

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

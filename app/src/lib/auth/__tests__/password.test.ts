// Password lane: argon2id hashing, constant-time verify, per-call salting (B1/R7).

import { expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../password";

// Obviously-fake test password — never a real credential.
const PW = "correct horse battery staple 42";

test("hashPassword produces an argon2id PHC string", async () => {
  const hash = await hashPassword(PW);
  expect(hash.startsWith("$argon2id$")).toBe(true);
});

test("verifyPassword accepts the right password and rejects a wrong one", async () => {
  const hash = await hashPassword(PW);
  expect(await verifyPassword(PW, hash)).toBe(true);
  expect(await verifyPassword("not the password", hash)).toBe(false);
});

test("two hashes of the same password differ (per-call salt)", async () => {
  const a = await hashPassword(PW);
  const b = await hashPassword(PW);
  expect(a).not.toBe(b);
  // Both still verify the original.
  expect(await verifyPassword(PW, a)).toBe(true);
  expect(await verifyPassword(PW, b)).toBe(true);
});

test("verifyPassword returns false for a null/empty/garbage hash, never throws", async () => {
  expect(await verifyPassword(PW, null)).toBe(false);
  expect(await verifyPassword(PW, "")).toBe(false);
  expect(await verifyPassword(PW, "not-a-phc-string")).toBe(false);
});

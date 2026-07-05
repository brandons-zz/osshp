// TOTP-secret-at-rest encryption: round-trip, non-plaintext storage (T1/NO-GO #6),
// tamper detection, and the absent-key = clear error (never silent plaintext) rule.

process.env.OSSHP_ENCRYPTION_KEY =
  "test-encryption-key-do-not-use-in-prod-0123456789abcdef";

import { afterEach, expect, test } from "bun:test";
import { decryptSecret, encryptSecret, isBoxed } from "../secret-box";

const KEY = process.env.OSSHP_ENCRYPTION_KEY!;
// Obviously-fake stand-in for a TOTP secret.
const PLAINTEXT = "JBSWY3DPEHPK3PXPFAKEFAKEFAKE";

afterEach(() => {
  process.env.OSSHP_ENCRYPTION_KEY = KEY;
});

test("encrypt → decrypt round-trips", () => {
  const boxed = encryptSecret(PLAINTEXT);
  expect(decryptSecret(boxed)).toBe(PLAINTEXT);
});

test("the boxed form does NOT contain the plaintext (non-plaintext at rest)", () => {
  const boxed = encryptSecret(PLAINTEXT);
  expect(boxed.includes(PLAINTEXT)).toBe(false);
  expect(isBoxed(boxed)).toBe(true);
  expect(isBoxed(PLAINTEXT)).toBe(false);
});

test("encrypting the same plaintext twice yields different ciphertext (random IV)", () => {
  expect(encryptSecret(PLAINTEXT)).not.toBe(encryptSecret(PLAINTEXT));
});

test("a tampered ciphertext fails the auth tag (integrity)", () => {
  const boxed = encryptSecret(PLAINTEXT);
  const parts = boxed.split(":");
  // Flip the last hex char of the ciphertext.
  const ct = parts[3];
  const flipped = ct.slice(0, -1) + (ct.at(-1) === "0" ? "1" : "0");
  const tampered = [parts[0], parts[1], parts[2], flipped].join(":");
  expect(() => decryptSecret(tampered)).toThrow();
});

test("a malformed box is rejected", () => {
  expect(() => decryptSecret("not-a-box")).toThrow();
  expect(() => decryptSecret("v9:aa:bb:cc")).toThrow();
});

test("an absent encryption key is a CLEAR config error, never silent plaintext", () => {
  delete process.env.OSSHP_ENCRYPTION_KEY;
  expect(() => encryptSecret(PLAINTEXT)).toThrow(/OSSHP_ENCRYPTION_KEY/);
});

// Recovery codes: CSPRNG/high-entropy, hashed-at-rest, single-use, display-once.

import { expect, test } from "bun:test";
import {
  generateRecoveryCodes,
  normalizeCode,
  verifyAndConsumeRecoveryCode,
} from "../recovery-codes";

test("generates 10 codes; plaintext is high-entropy and NOT the stored form", () => {
  const { plaintext, hashed } = generateRecoveryCodes();
  expect(plaintext.length).toBe(10);
  expect(hashed.length).toBe(10);
  // Each code carries ~100 bits across 20 base32 chars (grouped with dashes).
  expect(normalizeCode(plaintext[0]).length).toBe(20);
  // Stored form is a salted hash, never the plaintext (R2).
  for (let i = 0; i < plaintext.length; i++) {
    expect(hashed[i].includes(normalizeCode(plaintext[i]))).toBe(false);
    expect(hashed[i]).toContain(":"); // salt:hash shape
  }
});

test("all codes are distinct (CSPRNG)", () => {
  const { plaintext } = generateRecoveryCodes();
  expect(new Set(plaintext).size).toBe(plaintext.length);
});

test("a valid code verifies and is consumed (single-use, R3)", () => {
  const { plaintext, hashed } = generateRecoveryCodes();
  const first = verifyAndConsumeRecoveryCode(plaintext[0], hashed);
  expect(first.matched).toBe(true);
  expect(first.remaining.length).toBe(hashed.length - 1);
  // The same code no longer matches against the reduced set.
  const second = verifyAndConsumeRecoveryCode(plaintext[0], first.remaining);
  expect(second.matched).toBe(false);
  expect(second.remaining.length).toBe(first.remaining.length);
});

test("matching is dash/case insensitive (operator transcription tolerance)", () => {
  const { plaintext, hashed } = generateRecoveryCodes();
  const messy = plaintext[0].replace(/-/g, "").toLowerCase();
  expect(verifyAndConsumeRecoveryCode(messy, hashed).matched).toBe(true);
});

test("a wrong code never matches and leaves the set intact", () => {
  const { hashed } = generateRecoveryCodes();
  const result = verifyAndConsumeRecoveryCode("00000-00000-00000-00000", hashed);
  expect(result.matched).toBe(false);
  expect(result.remaining.length).toBe(hashed.length);
});

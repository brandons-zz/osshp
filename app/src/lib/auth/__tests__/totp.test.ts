// TOTP lane: ≥160-bit secret, ±1-step window (T4), step tracking for one-time
// -per-step (T2), wrong-code rejection.

import { expect, test } from "bun:test";
import {
  currentTotpToken,
  generateTotpSecret,
  verifyTotp,
} from "../totp";

const PERIOD = 30;
const EPOCH = 1_700_000_000; // fixed reference time (seconds)

test("generateTotpSecret returns a >=160-bit base32 secret (T1)", () => {
  const secret = generateTotpSecret();
  // 20 bytes / 160 bits → 32 base32 chars.
  expect(secret.length).toBeGreaterThanOrEqual(32);
});

test("a current code verifies and reports its step (T2)", async () => {
  const secret = generateTotpSecret();
  const token = await currentTotpToken(secret, { epoch: EPOCH });
  const result = await verifyTotp(secret, token, { epoch: EPOCH });
  expect(result.valid).toBe(true);
  expect(result.step).toBe(Math.floor(EPOCH / PERIOD));
});

test("a wrong code is rejected", async () => {
  const secret = generateTotpSecret();
  const result = await verifyTotp(secret, "000000", { epoch: EPOCH });
  expect(result.valid).toBe(false);
  expect(result.step).toBeNull();
});

test("the previous step's code is accepted within the ±1 window (T4)", async () => {
  const secret = generateTotpSecret();
  const prev = await currentTotpToken(secret, { epoch: EPOCH - PERIOD });
  const result = await verifyTotp(secret, prev, { epoch: EPOCH });
  expect(result.valid).toBe(true);
  expect(result.step).toBe(Math.floor((EPOCH - PERIOD) / PERIOD));
});

test("a code two steps away is OUTSIDE the window and rejected (window never > ±1)", async () => {
  const secret = generateTotpSecret();
  const far = await currentTotpToken(secret, { epoch: EPOCH - 2 * PERIOD });
  const result = await verifyTotp(secret, far, { epoch: EPOCH });
  expect(result.valid).toBe(false);
});

test("a code from a different secret is rejected", async () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  const tokenForA = await currentTotpToken(a, { epoch: EPOCH });
  expect((await verifyTotp(b, tokenForA, { epoch: EPOCH })).valid).toBe(false);
});

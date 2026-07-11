// SESSION_SECRET / OSSHP_ENCRYPTION_KEY strength floor (owasp-audit A02-G1;
// security-review NB-1): a weak secret must fail loud, but the documented
// `openssl rand -hex 32` output must pass.

import { expect, test } from "bun:test";
import {
  assertEncryptionKeyStrength,
  assertSessionSecretStrength,
  assessEncryptionKeyStrength,
  assessSessionSecret,
  MIN_SECRET_LENGTH,
} from "../secret-strength";

test("rejects empty / unset secret", () => {
  expect(assessSessionSecret(undefined).ok).toBe(false);
  expect(assessSessionSecret("").ok).toBe(false);
});

test("rejects the canonical weak literal `changeme`", () => {
  expect(assessSessionSecret("changeme").ok).toBe(false);
  expect(assessSessionSecret("CHANGEME").ok).toBe(false);
});

// The deny-list previously covered `changeme` /
// `change-me` but not the underscore variant `change_me`. `change_me` is only
// 9 chars, so `.ok` alone can't discriminate the fix (the length floor
// rejects it either way, pre- or post-fix) — assert the REASON is the
// weak-literal branch, not the too-short branch, to prove the deny-list
// itself now matches it.
test("rejects `change_me` (underscore variant) as a known weak value, not merely as too-short", () => {
  const result = assessSessionSecret("change_me");
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/known weak value/);
  // Case-insensitive, same as the other weak literals.
  expect(assessSessionSecret("CHANGE_ME").reason).toMatch(/known weak value/);
  expect(assessSessionSecret("Change_Me").reason).toMatch(/known weak value/);
});

test("rejects a too-short secret", () => {
  const short = "a1b2c3"; // well under the floor
  expect(short.length).toBeLessThan(MIN_SECRET_LENGTH);
  expect(assessSessionSecret(short).ok).toBe(false);
});

test("rejects a long-but-low-entropy secret (repeated characters)", () => {
  expect(assessSessionSecret("a".repeat(64)).ok).toBe(false);
  // A long repeated word also fails the distinct-char floor.
  expect(assessSessionSecret("changeme".repeat(8)).ok).toBe(false);
});

test("accepts a real `openssl rand -hex 32` style secret (64 hex chars)", () => {
  const real =
    "3f8a1c9e7b2d4056f1a8c3e9b7d20465f8a1c9e7b2d4056f1a8c3e9b7d204651";
  expect(real.length).toBe(64);
  expect(assessSessionSecret(real).ok).toBe(true);
});

test("assertSessionSecretStrength throws loud on a weak secret, passes on a strong one", () => {
  expect(() => assertSessionSecretStrength("changeme")).toThrow(
    /Refusing to start/,
  );
  const real =
    "3f8a1c9e7b2d4056f1a8c3e9b7d20465f8a1c9e7b2d4056f1a8c3e9b7d204651";
  expect(() => assertSessionSecretStrength(real)).not.toThrow();
});

// OSSHP_ENCRYPTION_KEY (issue 021 / security-review NB-1): unlike SESSION_SECRET,
// an UNSET key is not itself a strength failure — it is optional at boot and
// fails closed at first TOTP use (config.encryptionKey / secret-box.ts). Only a
// weak-but-PRESENT key must fail boot.

test("does not reject an unset/empty encryption key (optional at boot, fails closed at use)", () => {
  expect(assessEncryptionKeyStrength(undefined).ok).toBe(true);
  expect(assessEncryptionKeyStrength(null).ok).toBe(true);
  expect(assessEncryptionKeyStrength("").ok).toBe(true);
});

test("rejects the canonical weak literal `changeme` as an encryption key", () => {
  expect(assessEncryptionKeyStrength("changeme").ok).toBe(false);
  expect(assessEncryptionKeyStrength("CHANGEME").ok).toBe(false);
});

// Same underscore-variant gap, same wrapper (both
// SESSION_SECRET and OSSHP_ENCRYPTION_KEY delegate to the shared
// assessPresentSecret() weak-literal deny-list).
test("rejects `change_me` (underscore variant) as an encryption key, via the weak-literal branch", () => {
  const result = assessEncryptionKeyStrength("change_me");
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/known weak value/);
});

test("rejects a too-short encryption key", () => {
  const short = "a1b2c3"; // well under the floor
  expect(short.length).toBeLessThan(MIN_SECRET_LENGTH);
  expect(assessEncryptionKeyStrength(short).ok).toBe(false);
});

test("rejects a long-but-low-entropy encryption key (repeated characters)", () => {
  expect(assessEncryptionKeyStrength("a".repeat(64)).ok).toBe(false);
  expect(assessEncryptionKeyStrength("changeme".repeat(8)).ok).toBe(false);
});

test("accepts a real `openssl rand -hex 32` style encryption key (64 hex chars)", () => {
  const real =
    "9c1a4f7e2b8d5063f4a2c8e0b6d1795af0e6c2b9d5178f34a2c9e6b0d17953a2";
  expect(real.length).toBe(64);
  expect(assessEncryptionKeyStrength(real).ok).toBe(true);
});

test("assertEncryptionKeyStrength does not throw when unset (fails closed at use instead)", () => {
  expect(() => assertEncryptionKeyStrength(undefined)).not.toThrow();
  expect(() => assertEncryptionKeyStrength(null)).not.toThrow();
  expect(() => assertEncryptionKeyStrength("")).not.toThrow();
});

test("assertEncryptionKeyStrength throws loud on a weak-but-present key, passes on a strong one", () => {
  expect(() => assertEncryptionKeyStrength("changeme")).toThrow(
    /Refusing to start/,
  );
  expect(() => assertEncryptionKeyStrength("changeme")).toThrow(
    /OSSHP_ENCRYPTION_KEY/,
  );
  const real =
    "9c1a4f7e2b8d5063f4a2c8e0b6d1795af0e6c2b9d5178f34a2c9e6b0d17953a2";
  expect(() => assertEncryptionKeyStrength(real)).not.toThrow();
});

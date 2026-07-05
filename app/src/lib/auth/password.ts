// Password hashing for the recovery fallback lane (auth-security-assessment B1 / R7).
//
// The fallback lane is password AND TOTP — password alone NEVER authenticates
// (NO-GO #3). This module owns only the password half: an argon2id hash, verified
// in constant time by the hasher.
//
// argon2id is provided by the Bun runtime (`Bun.password`), which the production
// artifact (`bun server.js`) and the test runner (`bun test`) both run under — so
// there is no native argon2 dependency to compile into the standalone build. The
// hash is salted per-call (a fresh salt is embedded in the PHC string), so two
// hashes of the same password differ. Node-only path: never imported by the Edge
// middleware.

type BunPassword = {
  hash(input: string, opts?: { algorithm?: string }): Promise<string>;
  verify(input: string, hash: string): Promise<boolean>;
};

function bunPassword(): BunPassword {
  const b = (globalThis as { Bun?: { password?: BunPassword } }).Bun;
  if (!b?.password) {
    // Fail loud: the fallback lane cannot be safe without a real hasher. This
    // never happens under `bun server.js` / `bun test`; the guard catches a
    // misconfigured runtime rather than silently degrading.
    throw new Error(
      "Password hashing requires the Bun runtime (Bun.password). The osshp " +
        "production artifact runs `bun server.js`; ensure the server runs under Bun.",
    );
  }
  return b.password;
}

/** Hash a plaintext password with argon2id (salted; PHC-string output). */
export async function hashPassword(plaintext: string): Promise<string> {
  return bunPassword().hash(plaintext, { algorithm: "argon2id" });
}

/**
 * Verify a plaintext password against a stored argon2id hash. Returns false for a
 * non-match or a malformed/empty hash; never throws on a bad input pair.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bunPassword().verify(plaintext, hash);
  } catch {
    return false;
  }
}

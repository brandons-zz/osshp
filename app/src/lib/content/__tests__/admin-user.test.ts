import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser, getAdminUser, updateAdminUser } from "../admin-user";

let h: TestDb;
let db: Db;

beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("no admin exists before provisioning", async () => {
  expect(await getAdminUser(db)).toBeNull();
});

test("round-trips the admin record fields (auth fields modeled, not exercised)", async () => {
  const created = await createAdminUser(db, {
    passkeyCredentials: [
      { credentialId: "cred1", publicKey: "pk", counter: 0, transports: ["internal"] },
    ],
    passwordHash: "argon2id$placeholder",
    totpSecret: "ENCRYPTED_PLACEHOLDER",
    recoveryCodes: ["hash1", "hash2"],
  });

  const fetched = await getAdminUser(db);
  expect(fetched!.id).toBe(created.id);
  expect(fetched!.passkeyCredentials[0].credentialId).toBe("cred1");
  expect(fetched!.passwordHash).toBe("argon2id$placeholder");
  expect(fetched!.totpSecret).toBe("ENCRYPTED_PLACEHOLDER");
  expect(fetched!.recoveryCodes).toEqual(["hash1", "hash2"]);
});

test("only one admin can exist (single-identity model)", async () => {
  await createAdminUser(db);
  await expect(createAdminUser(db)).rejects.toThrow();
});

test("updateAdminUser patches credential fields", async () => {
  await createAdminUser(db);
  await updateAdminUser(db, { passwordHash: "newhash", recoveryCodes: ["a"] });
  const fetched = await getAdminUser(db);
  expect(fetched!.passwordHash).toBe("newhash");
  expect(fetched!.recoveryCodes).toEqual(["a"]);
});

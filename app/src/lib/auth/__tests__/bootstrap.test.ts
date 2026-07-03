// Single-use bootstrap gate: the wizard cannot be re-run after the admin exists.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";
import { createAdminUser } from "@/lib/content/admin-user";
import {
  isBootstrapAvailable,
  RegistrationForbiddenError,
  resolveRegistrationMode,
} from "../bootstrap";

let h: TestDb;
let db: Db;
beforeEach(async () => {
  h = await createTestDb();
  db = h.db;
});
afterEach(() => h.close());

test("bootstrap is available only until the admin is provisioned (NO-GO #1)", async () => {
  expect(await isBootstrapAvailable(db)).toBe(true);
  await createAdminUser(db);
  expect(await isBootstrapAvailable(db)).toBe(false);
});

test("registration mode is bootstrap while no admin exists", async () => {
  // Even an unauthenticated caller gets the bootstrap lane (first run).
  expect(await resolveRegistrationMode(db, { authenticated: false })).toBe(
    "bootstrap",
  );
});

test("after provisioning, the wizard cannot be re-run by an anonymous caller (NO-GO #1/#2)", async () => {
  await createAdminUser(db);
  await expect(
    resolveRegistrationMode(db, { authenticated: false }),
  ).rejects.toBeInstanceOf(RegistrationForbiddenError);
});

test("after provisioning, enrollment requires an authenticated session (step-up, NO-GO #2)", async () => {
  await createAdminUser(db);
  expect(await resolveRegistrationMode(db, { authenticated: true })).toBe(
    "step-up",
  );
});

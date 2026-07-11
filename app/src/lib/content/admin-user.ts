// Single admin-user store (spec §8).
//
// This persists the admin record FIELDS only — passkey credentials, password
// hash, TOTP secret, recovery codes. The auth behavior that fills and verifies
// them (WebAuthn ceremony, argon2id hashing, TOTP, recovery) is M1.6/M2.1. The
// admin_user table's lock_col guarantees at most one admin row.
//
// SECURITY: nothing here is part of the public/theme surface. The theme render
// context (theme-rendering-contract §3.1) has no field that can reach this
// record — it is admin-only by construction.

import type { Db } from "@/lib/db/types";
import type { AdminUser, AdminUserUpdate, NewAdminUser } from "./types";
import { toIso } from "./util";

interface AdminUserRow {
  id: string;
  passkey_credentials: AdminUser["passkeyCredentials"];
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_last_step: unknown;
  recovery_codes: string[];
  recovery_codes_generated_at: unknown;
  created_at: unknown;
}

const COLUMNS = `id, passkey_credentials, password_hash, totp_secret, totp_enabled, totp_last_step, recovery_codes, recovery_codes_generated_at, created_at`;

function mapAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    passkeyCredentials: row.passkey_credentials ?? [],
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpEnabled: row.totp_enabled ?? false,
    totpLastStep: Number(row.totp_last_step ?? 0),
    recoveryCodes: row.recovery_codes ?? [],
    recoveryCodesGeneratedAt: row.recovery_codes_generated_at
      ? toIso(row.recovery_codes_generated_at)
      : null,
    createdAt: toIso(row.created_at),
  };
}

export async function getAdminUser(db: Db): Promise<AdminUser | null> {
  const rows = await db.query<AdminUserRow>(
    `SELECT ${COLUMNS} FROM admin_user WHERE lock_col = 'X'`,
  );
  return rows[0] ? mapAdminUser(rows[0]) : null;
}

/**
 * Provision the single admin record (M1.6 bootstrap). Throws if an admin
 * already exists — the lock_col UNIQUE constraint enforces single-admin.
 */
export async function createAdminUser(
  db: Db,
  input: NewAdminUser = {},
): Promise<AdminUser> {
  const rows = await db.query<AdminUserRow>(
    `INSERT INTO admin_user
       (passkey_credentials, password_hash, totp_secret, recovery_codes)
     VALUES ($1::jsonb, $2, $3, $4::jsonb)
     RETURNING ${COLUMNS}`,
    [
      JSON.stringify(input.passkeyCredentials ?? []),
      input.passwordHash ?? null,
      input.totpSecret ?? null,
      JSON.stringify(input.recoveryCodes ?? []),
    ],
  );
  return mapAdminUser(rows[0]);
}

/** Update the admin record's credential fields (auth flows fill these later). */
export async function updateAdminUser(
  db: Db,
  patch: AdminUserUpdate,
): Promise<AdminUser | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown, jsonb = false) => {
    params.push(value);
    sets.push(`${column} = $${params.length}${jsonb ? "::jsonb" : ""}`);
  };

  if (patch.passkeyCredentials !== undefined) {
    set("passkey_credentials", JSON.stringify(patch.passkeyCredentials), true);
  }
  if (patch.passwordHash !== undefined) set("password_hash", patch.passwordHash);
  if (patch.totpSecret !== undefined) set("totp_secret", patch.totpSecret);
  if (patch.totpEnabled !== undefined) set("totp_enabled", patch.totpEnabled);
  if (patch.totpLastStep !== undefined) set("totp_last_step", patch.totpLastStep);
  if (patch.recoveryCodes !== undefined) {
    set("recovery_codes", JSON.stringify(patch.recoveryCodes), true);
  }
  if (patch.recoveryCodesGeneratedAt !== undefined) {
    set("recovery_codes_generated_at", patch.recoveryCodesGeneratedAt);
  }

  if (sets.length === 0) return getAdminUser(db);

  const rows = await db.query<AdminUserRow>(
    `UPDATE admin_user SET ${sets.join(", ")} WHERE lock_col = 'X'
     RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? mapAdminUser(rows[0]) : null;
}

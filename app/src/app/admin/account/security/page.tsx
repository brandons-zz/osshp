// /admin/account/security — credential management for the single admin.
//
// Lets the operator set/change their password, enroll TOTP (verify-before-enable),
// and generate recovery codes. The auth layout already enforces a valid session;
// this page reads only the credential *status* (not the secrets themselves) to
// pre-fill the form. All mutations flow through the existing
// /api/admin/account/* routes which re-validate the session + CSRF-guard.

import { getDb } from "@/lib/db/client";
import { getAdminUser } from "@/lib/content/admin-user";
import { AccountSecurityForm } from "./AccountSecurityForm";

export default async function AccountSecurityPage() {
  const admin = await getAdminUser(getDb());

  return (
    <div className="stack">
      <h1>Account security</h1>
      <p className="muted">
        Manage the fallback credentials used when your passkey is unavailable.
        Set all three — password&nbsp;+&nbsp;TOTP, and recovery codes — before
        relying on them.
      </p>
      <AccountSecurityForm
        hasPassword={!!admin?.passwordHash}
        totpEnabled={!!admin?.totpEnabled}
        recoveryCodesRemaining={admin?.recoveryCodes?.length ?? 0}
      />
    </div>
  );
}

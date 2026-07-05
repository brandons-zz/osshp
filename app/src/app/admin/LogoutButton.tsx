"use client";

// Logout control for the admin shell — revokes the server session and returns to
// the public site. A client control (not a bare form) so it can drive the JSON
// logout endpoint and then navigate.

import { Button } from "@/components/ui";

export function LogoutButton() {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/");
  }
  return (
    <Button onClick={signOut} aria-label="Sign out">
      Sign out
    </Button>
  );
}

// /setup — server-side guard + first-run wizard entry point.
//
// SECURITY (OWASP A05): this route returns 404 when the site is already
// configured. A redirect to /login would confirm the path existed and that an
// admin is present (information leak); 404 leaks nothing. Two independent
// conditions trigger 404:
//   - isBootstrapAvailable(db) === false  (admin exists → bootstrap permanently closed)
//   - site.setupComplete === true         (operator finished the wizard)
//
// This guard is Layer 2. Layer 1 is the removal of /setup from PUBLIC_EXACT in
// src/lib/auth/access.ts — unauthenticated requests are blocked by the middleware
// before reaching this handler. Both layers are required: Layer 1 blocks
// unauthenticated reach; Layer 2 blocks authenticated reach post-config.

import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { isBootstrapAvailable } from "@/lib/auth/bootstrap";
import { getSetting } from "@/lib/content/settings";
import SetupWizard from "./SetupWizard";

// Always render at request time — this page must read live DB state to decide
// whether to 404 or serve the wizard. Static prerender would lack DATABASE_URL.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const db = getDb();
  const [bootstrapAvailable, setupComplete] = await Promise.all([
    isBootstrapAvailable(db),
    getSetting<boolean>(db, "site.setupComplete"),
  ]);

  if (!bootstrapAvailable || setupComplete === true) {
    notFound();
  }

  return <SetupWizard />;
}

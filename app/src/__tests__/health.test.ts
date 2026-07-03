import { expect, test } from "bun:test";

// Skeleton test — expand in M1.3+ as real modules are built.
// This file ensures `bun test` exits 0 so the pre-push gate works.

test("health route handler returns ok status", async () => {
  // Import the handler dynamically to avoid Next.js environment requirements.
  // When the app grows, replace with integration tests against the real server.
  const { GET } = await import("../app/api/health/route");
  const response = await GET();
  const body = await response.json();
  expect(body).toEqual({ status: "ok" });
});

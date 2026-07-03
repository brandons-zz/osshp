// Health check endpoint — used by container health checks and smoke tests.
// Returns 200 OK with a JSON payload when the app is running.

export function GET() {
  return Response.json({ status: "ok" });
}

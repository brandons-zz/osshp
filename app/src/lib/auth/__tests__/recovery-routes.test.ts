// Recovery route wiring: every new mutating route is guardMutation-wrapped (a
// cross-site POST is rejected with 403 + no-store BEFORE the handler runs), the
// break-glass reset has NO HTTP route (NO-GO #5), and the recovery lanes are
// rate-limited as account lockout (B4) on a trusted-proxy-aware key.

process.env.OSSHP_ORIGIN = "https://osshp.example.com";
process.env.OSSHP_TRUSTED_PROXY_HOPS = "1";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { clientKey, createRateLimiter } from "@/lib/auth";

// The new mutating recovery + account routes.
const ROUTE_MODULES = [
  "@/app/api/auth/recovery/password-totp/route",
  "@/app/api/auth/recovery/code/route",
  "@/app/api/admin/account/password/route",
  "@/app/api/admin/account/recovery-codes/route",
];

function crossSitePost(path: string): Request {
  return new Request(`https://osshp.example.com${path}`, {
    method: "POST",
    headers: { origin: "https://evil.example.com", "content-type": "application/json" },
    body: "{}",
  });
}

test("every new mutating route rejects a cross-site POST with 403 + no-store (guardMutation)", async () => {
  for (const mod of ROUTE_MODULES) {
    const { POST } = (await import(mod)) as {
      POST: (r: Request) => Promise<Response>;
    };
    const res = await POST(crossSitePost("/x"));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
});

test("the TOTP route's PUT (confirm) is also guardMutation-wrapped", async () => {
  const { PUT } = (await import("@/app/api/admin/account/totp/route")) as {
    PUT: (r: Request) => Promise<Response>;
  };
  const res = await PUT(crossSitePost("/api/admin/account/totp"));
  expect(res.status).toBe(403);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("break-glass has NO HTTP route — no file under src/app references it (NO-GO #5)", () => {
  const appDir = join(import.meta.dir, "../../../app");
  const offenders: string[] = [];
  for (const file of readdirSync(appDir, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const text = readFileSync(join(appDir, file), "utf8");
    if (/breakGlass|break-glass|admin:reset/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("recovery lanes lock after N failures on a trusted-proxy-aware key, reset on success (B4)", () => {
  // Mirror the recovery limiters' shape; assert the lockout semantics.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5, globalMax: 20 });
  // The key is the trusted-proxy-aware client IP (rightmost trusted hop), NOT a
  // client-rotatable leftmost XFF token.
  const req = new Request("https://osshp.example.com/api/auth/recovery/code", {
    method: "POST",
    headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, // attacker, trusted-proxy
  });
  const key = clientKey("recovery-code", req);
  expect(key).toBe("recovery-code:10.0.0.1"); // trusted (rightmost) entry, not 9.9.9.9

  // N=5 attempts allowed, the 6th is locked.
  for (let i = 0; i < 5; i++) expect(limiter.check(key).allowed).toBe(true);
  expect(limiter.check(key).allowed).toBe(false);

  // A success resets the counter (consecutive-failure semantics).
  limiter.reset(key);
  expect(limiter.check(key).allowed).toBe(true);
});

test("an attacker rotating the leftmost XFF token cannot evade the lockout key", () => {
  const k1 = clientKey(
    "recovery-code",
    new Request("https://x/", { headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" } }),
  );
  const k2 = clientKey(
    "recovery-code",
    new Request("https://x/", { headers: { "x-forwarded-for": "2.2.2.2, 10.0.0.1" } }),
  );
  // Both collapse to the same trusted key — the rotation buys nothing.
  expect(k1).toBe(k2);
});

// Durable, bounded auth-audit persistence (Security Center Slice 2, §5).
//
// The store persists the SAME post-redaction record recordAuthEvent already emits
// to stdout, best-effort (never throws into the auth path), and bounded by age AND
// row count (sweep-on-write). These tests run against PGlite — real PostgreSQL
// compiled to WASM, in-process — so the exact production SQL is exercised in the
// pre-push gate.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  AUDIT_MAX_ROWS,
  AUDIT_RETENTION_DAYS,
  buildAuditRecord,
  persistAuditEvent,
  recordAuthEvent,
  setAuditSink,
  type AuthAuditRecord,
} from "../index";
import { createTestDb, type TestDb } from "@/lib/db/test-support";
import type { Db } from "@/lib/db/types";

let _h: TestDb;
let _db: Db;

beforeEach(async () => {
  _h = await createTestDb();
  _db = _h.db;
});

afterEach(async () => {
  await _h.close();
});

async function allEvents(db: Db): Promise<AuthAuditRecord[]> {
  return db.query<AuthAuditRecord>(
    `SELECT ts, event, outcome, ip, details
       FROM auth_audit_events ORDER BY ts DESC, id DESC`,
  );
}

async function count(db: Db): Promise<number> {
  const rows = await db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM auth_audit_events`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ── a credential/recovery event is retrievable after it occurs, is pruned
//    past the retention bound, and carries no secret-bearing field ──────────────

test("a persisted credential event is retrievable from durable storage", async () => {
  const rec = buildAuditRecord("recovery.success", "success", {
    details: { lane: "recovery-code", mode: "fallback" },
  });
  await persistAuditEvent(_db, rec);

  const rows = await allEvents(_db);
  expect(rows).toHaveLength(1);
  expect(rows[0].event).toBe("recovery.success");
  expect(rows[0].outcome).toBe("success");
  // The record's OWN ts is stored (same-object dual-sink), not a fresh DEFAULT.
  expect(new Date(rows[0].ts as unknown as string).toISOString()).toBe(rec.ts);
  expect(rows[0].details).toEqual({ lane: "recovery-code", mode: "fallback" });
});

test("recovery event with hostile detail keys stores NO secret-bearing field", async () => {
  // buildAuditRecord is the single redaction point; the store persists that
  // already-redacted record verbatim. A hostile call site cannot smuggle a
  // secret into the durable row.
  const rec = buildAuditRecord("recovery.success", "success", {
    details: {
      lane: "recovery-code",
      recovery_code: "abcd-efgh-ijkl",
      totpSecret: "JBSWY3DPEHPK3PXP",
      nested: { sessionToken: "deadbeef.cafef00d", note: "fine" },
    },
  });
  await persistAuditEvent(_db, rec);

  const rows = await allEvents(_db);
  const details = rows[0].details as Record<string, unknown>;
  expect(details.lane).toBe("recovery-code");
  expect(details.recovery_code).toBe("[REDACTED]");
  expect(details.totpSecret).toBe("[REDACTED]");
  expect((details.nested as Record<string, unknown>).sessionToken).toBe("[REDACTED]");
  expect((details.nested as Record<string, unknown>).note).toBe("fine");
  // Belt-and-suspenders: the raw secret text is nowhere in the serialized row.
  const raw = JSON.stringify(rows[0]);
  expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
  expect(raw).not.toContain("abcd-efgh-ijkl");
  expect(raw).not.toContain("deadbeef.cafef00d");
});

test("rows older than the age bound are pruned on the next persist", async () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0); // fixed clock for determinism
  const oldTs = new Date(now - (AUDIT_RETENTION_DAYS + 5) * 86_400_000).toISOString();
  const freshTs = new Date(now - 1 * 86_400_000).toISOString();

  // Insert an over-age row and an in-window row directly (bypassing the sweep).
  await _db.query(
    `INSERT INTO auth_audit_events (ts, event, outcome, ip, details)
       VALUES ($1, 'login.failure', 'failure', NULL, NULL),
              ($2, 'login.failure', 'failure', NULL, NULL)`,
    [oldTs, freshTs],
  );
  expect(await count(_db)).toBe(2);

  // A new persist runs the age sweep with the injected clock → the over-age row
  // is deleted; the in-window row and the new row survive.
  const rec = buildAuditRecord("login.success", "success", {});
  await persistAuditEvent(_db, rec, { now });

  const rows = await allEvents(_db);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => new Date(r.ts as unknown as string).toISOString())).not.toContain(oldTs);
});

test("a persist past the row cap deletes oldest-first down to the cap", async () => {
  // Bounds are test-overridable (module constants in production, no env var).
  const cap = 3;
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  // Seed cap rows with strictly increasing timestamps.
  for (let i = 0; i < cap; i++) {
    const rec = buildAuditRecord("login.success", "success", {});
    // Force distinct, ordered ts so "oldest" is unambiguous.
    (rec as { ts: string }).ts = new Date(base + i * 1000).toISOString();
    await persistAuditEvent(_db, rec, { maxRows: cap });
  }
  expect(await count(_db)).toBe(cap);
  const oldest = new Date(base).toISOString();

  // One more persist pushes to cap+1 → the sweep deletes the single oldest row.
  const rec = buildAuditRecord("login.success", "success", {});
  (rec as { ts: string }).ts = new Date(base + cap * 1000).toISOString();
  await persistAuditEvent(_db, rec, { maxRows: cap });

  expect(await count(_db)).toBe(cap);
  const rows = await allEvents(_db);
  expect(rows.map((r) => new Date(r.ts as unknown as string).toISOString())).not.toContain(oldest);
});

test("production retention bounds are the design constants (365 days AND 20,000 rows)", () => {
  expect(AUDIT_RETENTION_DAYS).toBe(365);
  expect(AUDIT_MAX_ROWS).toBe(20_000);
});

// ── a forced store-write failure does NOT break the credential/auth flow ─

test("persistAuditEvent swallows a store failure and never throws", async () => {
  const failing: Db = {
    query: async () => {
      throw new Error("db down");
    },
  };
  const rec = buildAuditRecord("credential.change", "success", {
    details: { credential: "password" },
  });
  // Must resolve, not reject — the auth path awaits nothing, but even a direct
  // await must never surface the error.
  await expect(persistAuditEvent(failing, rec)).resolves.toBeUndefined();
});

test("recordAuthEvent with a failing db does NOT throw and still emits to stdout", async () => {
  const failing: Db = {
    query: async () => {
      throw new Error("db down");
    },
  };
  let captured: AuthAuditRecord | null = null;
  const restore = setAuditSink((r) => {
    captured = r;
  });
  try {
    // The auth route calls this synchronously; a store failure must not break it.
    expect(() =>
      recordAuthEvent("credential.change", "success", {
        db: failing,
        details: { credential: "password" },
      }),
    ).not.toThrow();
    // stdout sink still fired with the built record — durability failed, logging
    // did not.
    expect(captured).not.toBeNull();
    expect(captured!.event).toBe("credential.change");
    // Let the fire-and-forget rejection settle; it must not surface as unhandled.
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    setAuditSink(restore);
  }
});

// ── Dual-sink: recordAuthEvent persists the SAME post-redaction record it logs ──

test("recordAuthEvent dual-writes: the durable row equals the stdout record", async () => {
  let logged: AuthAuditRecord | null = null;
  const restore = setAuditSink((r) => {
    logged = r;
  });
  try {
    recordAuthEvent("passkey.enroll", "success", {
      db: _db,
      details: { credential: "passkey", totpSecret: "SHOULDNOTLAND" },
    });
    // Fire-and-forget: wait for the durable write to land.
    const stored = await waitForRow(_db);
    expect(logged).not.toBeNull();
    // Same object in both sinks: event/outcome/ip/details identical, ts identical.
    expect(stored.event).toBe(logged!.event);
    expect(stored.outcome).toBe(logged!.outcome);
    expect(stored.ip).toBe(logged!.ip ?? null);
    expect(new Date(stored.ts as unknown as string).toISOString()).toBe(logged!.ts);
    expect(stored.details).toEqual(logged!.details as Record<string, unknown>);
    // Redaction held on the way to durable storage.
    expect((stored.details as Record<string, unknown>).totpSecret).toBe("[REDACTED]");
  } finally {
    setAuditSink(restore);
  }
});

test("recordAuthEvent WITHOUT a db degrades to console-only (no durable row, no throw)", async () => {
  const restore = setAuditSink(() => {});
  try {
    expect(() =>
      recordAuthEvent("login.success", "success", { details: { lane: "login" } }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(await count(_db)).toBe(0);
  } finally {
    setAuditSink(restore);
  }
});

/** Poll until at least one durable row exists (fire-and-forget settle), or fail. */
async function waitForRow(db: Db): Promise<AuthAuditRecord> {
  for (let i = 0; i < 100; i++) {
    const rows = await allEvents(db);
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("durable audit row never appeared");
}

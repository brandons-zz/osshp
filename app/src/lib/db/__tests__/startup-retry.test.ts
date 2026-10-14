// Boot-time DB retry: a transient "database not reachable yet" failure during
// instrumentation must be retried, not cached as a permanent 500 by Next.js.
// Reproduces the field failure (SQLSTATE 57P03 on a host restart) with a fake
// clock so no test actually sleeps.

import { expect, test } from "bun:test";
import net from "node:net";
import postgres from "postgres";
import {
  isTransientDbError,
  retryTransient,
  StartupRetryExhaustedError,
} from "../startup-retry";

function pgError(code: string, message = `pg error ${code}`) {
  return Object.assign(new Error(message), { code });
}

/** A fake clock whose sleep() advances time instantly and records delays. */
function fakeClock() {
  let t = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => t,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
  };
}

test("classifies 'not reachable yet' errors as transient", () => {
  for (const code of [
    "57P03", // the database system is starting up — the field failure
    "57P01",
    "57P02",
    "53300",
    "08006",
    "08001",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
  ]) {
    expect(isTransientDbError(pgError(code))).toBe(true);
  }
});

test("classifies real failures as non-transient", () => {
  for (const code of [
    "28P01", // invalid_password — misconfiguration, retrying will not help
    "3D000", // invalid_catalog_name — database does not exist
    "42P01", // undefined_table
    "42601", // syntax_error (a broken migration)
    "23505", // unique_violation
  ]) {
    expect(isTransientDbError(pgError(code))).toBe(false);
  }
  expect(isTransientDbError(new Error("no code"))).toBe(false);
  expect(isTransientDbError("string")).toBe(false);
  expect(isTransientDbError(null)).toBe(false);
  expect(isTransientDbError({ code: 57 })).toBe(false);
});

test("retries 57P03 until the database comes up, then resolves", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await retryTransient(
    async () => {
      calls++;
      if (calls < 4) throw pgError("57P03", "the database system is starting up");
      return "ready";
    },
    { sleep: clock.sleep, now: clock.now },
  );
  expect(result).toBe("ready");
  expect(calls).toBe(4);
  expect(clock.delays).toEqual([500, 1000, 2000]);
});

test("backoff doubles and caps at maxDelayMs", async () => {
  const clock = fakeClock();
  let calls = 0;
  await retryTransient(
    async () => {
      if (++calls < 8) throw pgError("ECONNREFUSED");
    },
    { sleep: clock.sleep, now: clock.now },
  );
  expect(clock.delays).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
});

test("non-transient errors are rethrown immediately without retrying", async () => {
  const clock = fakeClock();
  let calls = 0;
  const err = pgError("42601", "syntax error in migration");
  await expect(
    retryTransient(
      async () => {
        calls++;
        throw err;
      },
      { sleep: clock.sleep, now: clock.now },
    ),
  ).rejects.toBe(err);
  expect(calls).toBe(1);
  expect(clock.delays).toEqual([]);
});

test("gives up with StartupRetryExhaustedError once the deadline would be passed", async () => {
  const clock = fakeClock();
  let calls = 0;
  const last = pgError("57P03", "the database system is starting up");
  let caught: unknown;
  try {
    await retryTransient(
      async () => {
        calls++;
        throw last;
      },
      { sleep: clock.sleep, now: clock.now, deadlineMs: 10_000 },
    );
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(StartupRetryExhaustedError);
  const exhausted = caught as StartupRetryExhaustedError;
  expect(exhausted.attempts).toBe(calls);
  expect(exhausted.cause).toBe(last);
  expect(exhausted.message).toContain("the database system is starting up");
  // Never sleeps past the deadline.
  expect(clock.now()).toBeLessThanOrEqual(10_000);
  expect(clock.delays).toEqual([500, 1000, 2000, 4000]);
});

test("reports each retry through onRetry", async () => {
  const clock = fakeClock();
  const seen: Array<{ attempt: number; delayMs: number }> = [];
  let calls = 0;
  await retryTransient(
    async () => {
      if (++calls < 3) throw pgError("57P03");
    },
    {
      sleep: clock.sleep,
      now: clock.now,
      onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
    },
  );
  expect(seen).toEqual([
    { attempt: 1, delayMs: 500 },
    { attempt: 2, delayMs: 1000 },
  ]);
});

test("a probe that never settles is bounded by the deadline", async () => {
  // postgres.js can leave a query pending forever (e.g. a proxy that accepts and
  // immediately closes connections). That must still end in exhaustion.
  let fnCalled = false;
  let caught: unknown;
  try {
    await retryTransient(
      async () => {
        fnCalled = true;
      },
      { deadlineMs: 50, probe: () => new Promise<never>(() => {}) },
    );
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(StartupRetryExhaustedError);
  expect((caught as Error).message).toContain("did not settle");
  expect(fnCalled).toBe(false);
});

test("once the probe succeeds, a slow fn (migration) is NOT cut off by the deadline", async () => {
  const result = await retryTransient(
    () => new Promise<string>((r) => setTimeout(() => r("migrated"), 150)),
    { deadlineMs: 50, probe: async () => 1 },
  );
  expect(result).toBe("migrated");
});

test("transient probe failures are retried like fn failures", async () => {
  const clock = fakeClock();
  let probes = 0;
  let fnCalls = 0;
  await retryTransient(
    async () => {
      fnCalls++;
    },
    {
      sleep: clock.sleep,
      now: clock.now,
      probe: async () => {
        if (++probes < 3) throw pgError("57P03");
      },
    },
  );
  expect(probes).toBe(3);
  expect(fnCalls).toBe(1);
  expect(clock.delays).toEqual([500, 1000]);
});

// --- real postgres.js errors ------------------------------------------------
// The tests above use synthetic { code } errors; these run the actual driver so
// the classifier is checked against what postgres.js really throws.


/** Frame a Postgres ErrorResponse ('E') with the given SQLSTATE and message. */
function errorResponse(code: string, message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`, "utf8"),
  ]);
  const len = Buffer.alloc(4);
  len.writeInt32BE(fields.length + 4);
  return Buffer.concat([Buffer.from("E"), len, fields]);
}

/** A TCP server that answers every startup packet with a FATAL error. */
async function fatalServer(code: string, message: string) {
  const server = net.createServer((sock) => {
    sock.once("data", () => sock.end(errorResponse(code, message)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function driverError(url: string): Promise<unknown> {
  const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return null;
  } catch (e) {
    return e;
  } finally {
    await sql.end({ timeout: 0 });
  }
}

test("real driver: 57P03 'starting up' from the server is transient", async () => {
  const srv = await fatalServer("57P03", "the database system is starting up");
  try {
    const err = await driverError(`postgres://u:p@127.0.0.1:${srv.port}/d`);
    expect((err as { code?: string }).code).toBe("57P03");
    expect(isTransientDbError(err)).toBe(true);
  } finally {
    await srv.close();
  }
});

test("real driver: 28P01 wrong password is NOT transient", async () => {
  const srv = await fatalServer("28P01", 'password authentication failed for user "u"');
  try {
    const err = await driverError(`postgres://u:p@127.0.0.1:${srv.port}/d`);
    expect((err as { code?: string }).code).toBe("28P01");
    expect(isTransientDbError(err)).toBe(false);
  } finally {
    await srv.close();
  }
});

test("real driver: nothing listening (ECONNREFUSED) is transient", async () => {
  // Grab a free port, then close it so nothing is listening there.
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  const err = await driverError(`postgres://u:p@127.0.0.1:${port}/d`);
  expect((err as { code?: string }).code).toBe("ECONNREFUSED");
  expect(isTransientDbError(err)).toBe(true);
});

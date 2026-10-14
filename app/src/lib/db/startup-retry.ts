// Boot-time retry for database initialization.
//
// instrumentation.register() runs initializeDatabase() exactly once, and Next.js
// caches a rejected register() for the life of the process: every request then
// awaits the same rejected promise and 500s, and nothing ever retries. So a
// single transient failure at boot — most commonly Postgres still replaying WAL
// after a host or Docker daemon restart (SQLSTATE 57P03 "the database system is
// starting up"), where the restart policy starts app and db together and
// depends_on is NOT honored — wedged the instance until a human restarted it.
//
// retryTransient() retries only errors that mean "the database is not reachable
// yet". Anything else (a failing migration, a constraint violation, bad
// credentials) is rethrown immediately so it fails loud exactly as before.

/** SQLSTATEs that mean the server is not (yet) accepting work. */
const TRANSIENT_SQLSTATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — "the database system is starting up"
  "53300", // too_many_connections
]);

/** Socket / DNS / postgres.js connection-level error codes. */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND", // db container not up yet: its service name does not resolve
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** True when `err` means the database is not reachable yet (worth retrying). */
export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  // SQLSTATE class 08 — connection_exception (08000, 08001, 08006, …).
  if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_ERROR_CODES.has(code);
}

/** Thrown when transient failures persist past the retry deadline. */
export class StartupRetryExhaustedError extends Error {
  readonly attempts: number;
  constructor(attempts: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `database still unreachable after ${attempts} attempts: ${detail}`,
      { cause },
    );
    this.name = "StartupRetryExhaustedError";
    this.attempts = attempts;
  }
}

export interface RetryOptions {
  /** Give up once this much time has passed since the first attempt. */
  deadlineMs?: number;
  /** First backoff delay; doubles each attempt up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Cheap reachability check (e.g. `select 1`) run before `fn` on each attempt.
   * Only the probe is raced against the deadline: once it succeeds the database
   * is reachable and `fn` (migrations) runs unbounded, so a legitimately slow
   * migration or a lock wait is never killed mid-way.
   */
  probe?: () => Promise<unknown>;
  /** Seams for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bound a reachability probe by the time left before the deadline. postgres.js can
 * keep a query pending forever without ever rejecting — e.g. when something
 * (docker-proxy, a TCP load balancer) accepts the connection and then closes it
 * with no Postgres error, it reconnects in a tight loop and CONNECT_TIMEOUT
 * never fires. Without this bound such a probe would outlive the deadline and
 * the instance would hang instead of exiting.
 */
function withinDeadline<T>(
  attempt: Promise<T>,
  remainingMs: number,
  attemptNo: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new StartupRetryExhaustedError(
            attemptNo,
            new Error(`connection attempt did not settle before the ${remainingMs}ms deadline`),
          ),
        ),
      Math.max(0, remainingMs),
    );
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run `fn`, retrying with capped exponential backoff while it (or `probe`)
 * fails with a transient database error. Non-transient errors are rethrown
 * immediately. Throws StartupRetryExhaustedError if transient failures outlast
 * the deadline, or if a probe is still pending when the deadline is reached.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  {
    deadlineMs = 120_000,
    initialDelayMs = 500,
    maxDelayMs = 5_000,
    sleep = defaultSleep,
    now = Date.now,
    onRetry,
    probe,
  }: RetryOptions = {},
): Promise<T> {
  const start = now();
  let delayMs = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      if (probe) {
        await withinDeadline(probe(), deadlineMs - (now() - start), attempt);
      }
      return await fn();
    } catch (error) {
      if (error instanceof StartupRetryExhaustedError) throw error;
      if (!isTransientDbError(error)) throw error;
      if (now() - start + delayMs > deadlineMs) {
        throw new StartupRetryExhaustedError(attempt, error);
      }
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

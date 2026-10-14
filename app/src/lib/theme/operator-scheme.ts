// Bounded read of the operator's default scheme for the app shell (issue 081).
//
// The root layout needs branding.defaultScheme on every app-shell page (login,
// recovery, setup, admin). Those pages did not depend on the database answering
// before 081, so the read is capped: a hung database must not hang login. On a
// timeout or error the LAST successfully read value is used (not "auto"), so a
// burst of concurrent renders queuing behind the connection pool does not flip
// an operator's explicit light/dark back to the OS preference. "auto" is only
// the answer when nothing has been read yet in this process.

/** Longest the app shell waits on the operator scheme before using a fallback. */
export const OPERATOR_SCHEME_TIMEOUT_MS = 250;

let lastKnown: unknown = "auto";

export async function readOperatorScheme(
  read: () => Promise<unknown>,
  timeoutMs: number = OPERATOR_SCHEME_TIMEOUT_MS,
): Promise<unknown> {
  const TIMED_OUT = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const value = await Promise.race([read(), timeout]);
    if (value === TIMED_OUT) return lastKnown;
    lastKnown = value;
    return value;
  } catch {
    return lastKnown;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget the remembered value. */
export function resetOperatorSchemeCache(): void {
  lastKnown = "auto";
}

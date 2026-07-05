// SSRF boundary (issue 077): the single choke point every caller that
// resolves a hostname to a connectable IP must run through — the initial
// request AND every redirect hop.
//
// osshp had ZERO server-side fetch-by-URL before issue 077 (upload.ts's own
// header notes this explicitly). Auto-importing external inline images is the
// first one, so this module is deliberately narrow, pure, and exhaustively
// tested: it does no I/O of its own beyond an injectable DNS lookup.
//
// Blocked by IP (not by hostname string) — a hostname can resolve to a
// private address regardless of what it looks like:
//   IPv4: 127.0.0.0/8 (loopback), 10/8, 172.16/12, 192.168/16 (RFC1918),
//         169.254/16 (link-local, incl. the 169.254.169.254 cloud metadata
//         address), 0.0.0.0/8 ("this network").
//   IPv6: :: (unspecified), ::1 (loopback), fc00::/7 (unique-local),
//         fe80::/10 (link-local), and — checked by parsing to bytes, so ALL
//         textual forms are caught (dotted AND hex) — IPv4-mapped
//         (::ffff:0:0/96), IPv4-compatible (::a.b.c.d), and NAT64
//         (64:ff9b::/96) embeddings of every blocked IPv4 range above.
// Anything unparseable/unrecognized is blocked — fail closed, never open.

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

export interface ResolvedHost {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver — production uses the real `dns.lookup`; tests
 *  supply a fake to simulate resolution deterministically (no live network,
 *  no flakiness) for hostname-resolves-to-private and rebind-shaped cases. */
export type LookupFn = (hostname: string) => Promise<ResolvedHost[]>;

/** IPv4 dotted-quad -> 32-bit integer. Returns null for anything malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidr(ipInt: number, base: string, prefixBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True for loopback/RFC1918/link-local(+metadata)/"this network" IPv4. */
export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable => fail closed
  return (
    inCidr(n, "127.0.0.0", 8) ||
    inCidr(n, "10.0.0.0", 8) ||
    inCidr(n, "172.16.0.0", 12) ||
    inCidr(n, "192.168.0.0", 16) ||
    inCidr(n, "169.254.0.0", 16) || // includes 169.254.169.254 (cloud metadata)
    inCidr(n, "0.0.0.0", 8)
  );
}

/**
 * Parse an IPv6 textual address to its 16 bytes, or null when it is not a
 * valid IPv6 literal. Handles `::` zero-compression (once), a `%zone` suffix,
 * an embedded IPv4 dotted tail (`::ffff:1.2.3.4`), and case/compression
 * variants — so the byte-level range checks below are on canonical bytes,
 * never on a fragile string form. Pure; no I/O.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let s = ip.trim();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // strip scope id (fe80::1%eth0)
  if (s.length === 0) return null;

  // At most one "::".
  const dbl = s.indexOf("::");
  if (dbl >= 0 && s.indexOf("::", dbl + 1) !== -1) return null;

  const head = dbl >= 0 ? s.slice(0, dbl) : s;
  const tail = dbl >= 0 ? s.slice(dbl + 2) : "";

  // Parse one side (":"-separated) to a list of 16-bit groups; the last part
  // may be an embedded IPv4 dotted quad, which expands to two groups.
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.includes(".")) {
        if (i !== parts.length - 1) return null; // dotted quad only as the tail
        const v4 = ipv4ToInt(p);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
        out.push(parseInt(p, 16));
      }
    }
    return out;
  };

  const headGroups = parseSide(head);
  const tailGroups = parseSide(tail);
  if (headGroups === null || tailGroups === null) return null;

  let groups: number[];
  if (dbl >= 0) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null; // "::" must stand for >=1 zero group
    groups = [...headGroups, ...new Array(missing).fill(0), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/**
 * True for loopback/unspecified/unique-local/link-local IPv6, AND — checked by
 * BYTES, not string form — every IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-compatible (`::a.b.c.d`), and NAT64 (`64:ff9b::/96`) form whose
 * embedded IPv4 is itself private. This catches the hex textual forms
 * (`::ffff:a9fe:a9fe` = 169.254.169.254, `::ffff:7f00:1` = 127.0.0.1,
 * `::ffff:0a00:0001` = 10.0.0.1) that a dotted-only regex misses. Unparseable
 * input fails closed.
 */
export function isPrivateIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (b === null) return true; // unparseable => fail closed

  const allZero = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) if (b[i] !== 0) return false;
    return true;
  };
  const embeddedV4 = (): string => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;

  // :: (unspecified / all-zeros)
  if (allZero(0, 16)) return true;
  // ::1 (loopback)
  if (allZero(0, 15) && b[15] === 1) return true;
  // fc00::/7 (unique-local) — first byte 0xfc or 0xfd
  if ((b[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local) — 0xfe + top two bits of the second byte = 10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;

  // IPv4-mapped ::ffff:0:0/96 — bytes 0..9 == 0, bytes 10,11 == 0xff
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4(embeddedV4());
  }
  // NAT64 64:ff9b::/96 — 00 64 ff 9b, then bytes 4..11 == 0
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) {
    return isPrivateIPv4(embeddedV4());
  }
  // Deprecated IPv4-compatible ::a.b.c.d — bytes 0..11 == 0 (loopback/unspecified
  // already handled above; anything else here carries an embedded v4).
  if (allZero(0, 12)) {
    return isPrivateIPv4(embeddedV4());
  }

  return false;
}

/**
 * The single predicate every fetch/redirect target's resolved IP is checked
 * against. Unrecognized input (not a valid v4/v6 literal) is blocked.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

export interface HostValidation {
  ok: boolean;
  address?: string;
  family?: 4 | 6;
  reason?: string;
}

async function defaultLookup(hostname: string): Promise<ResolvedHost[]> {
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  return addrs.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
}

/**
 * Resolve `hostname` to one connectable, validated IP.
 *
 * - A literal IP hostname is checked directly (no DNS).
 * - Otherwise every resolved address is checked — if ANY of them is blocked,
 *   the whole hostname is refused (a multi-A-record response is refused
 *   wholesale rather than cherry-picking the "good-looking" address; the
 *   attacker controls DNS, not us).
 * - `lookup`/`isBlockedIpFn` are injectable for tests only. Every production
 *   call site uses the defaults (real DNS, real isBlockedIp) — no caller in
 *   this codebase overrides them.
 *
 * This function performs exactly ONE DNS resolution per call. The caller
 * (externalFetch.ts) pins the connection to the address returned here via a
 * custom `lookup` on the HTTP(S) request itself, so the address that was
 * validated is *always* the address that gets connected to — closing the
 * classic DNS-rebinding gap where a second, later resolution could return a
 * different (private) address than the one that passed the check.
 */
export async function resolvePublicHost(
  hostname: string,
  opts: { lookup?: LookupFn; isBlockedIpFn?: (ip: string) => boolean } = {},
): Promise<HostValidation> {
  const isBlocked = opts.isBlockedIpFn ?? isBlockedIp;

  // A URL's `hostname` for an IPv6 literal is bracketed (`[::1]`). Strip the
  // brackets so the address is recognized as a literal and validated by the
  // predicate here — robust by construction, not reliant on the bracketed
  // form incidentally failing isIP and falling through to a fail-closed DNS
  // path (which is where the earlier hex-mapped-IPv6 gap hid).
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isBlocked(host)) {
      return {
        ok: false,
        reason: `refuses to fetch a private/internal address (${host})`,
      };
    }
    return { ok: true, address: host, family: literalFamily as 4 | 6 };
  }

  const lookup = opts.lookup ?? defaultLookup;
  let addrs: ResolvedHost[];
  try {
    addrs = await lookup(host);
  } catch {
    return { ok: false, reason: `could not resolve host "${host}"` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: `host "${hostname}" did not resolve to any address` };
  }
  for (const a of addrs) {
    if (isBlocked(a.address)) {
      return {
        ok: false,
        reason: `"${hostname}" resolves to a private/internal address — refusing to fetch it`,
      };
    }
  }
  return { ok: true, address: addrs[0].address, family: addrs[0].family };
}

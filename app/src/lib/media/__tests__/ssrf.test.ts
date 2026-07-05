// SSRF boundary tests (issue 077) — the mandatory core.
//
// This is osshp's FIRST server-side fetch-by-URL. These tests exhaustively
// prove the boundary every hop of externalFetch.ts must pass through:
//   - every required blocked IPv4/IPv6 range is refused
//   - a hostname that RESOLVES to a blocked address is refused (not just a
//     blocked literal)
//   - DNS resolution happens exactly once per hostname (the mechanical
//     precondition for the DNS-rebind defense — see externalFetch.test.ts for
//     the end-to-end proof that the pinned connection never re-resolves)
//   - unrecognized/unparseable input fails closed (never open)

import { describe, expect, test } from "bun:test";
import {
  isBlockedIp,
  isPrivateIPv4,
  isPrivateIPv6,
  resolvePublicHost,
} from "../ssrf";

describe("isBlockedIp — IPv4 ranges", () => {
  test("127.0.0.0/8 — loopback", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.255.255.254")).toBe(true);
  });
  test("10.0.0.0/8 — RFC1918", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
  });
  test("172.16.0.0/12 — RFC1918", () => {
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    // Boundary: 172.15.x/172.32.x are OUTSIDE the /12 and must NOT be blocked.
    expect(isBlockedIp("172.15.255.255")).toBe(false);
    expect(isBlockedIp("172.32.0.0")).toBe(false);
  });
  test("192.168.0.0/16 — RFC1918", () => {
    expect(isBlockedIp("192.168.0.1")).toBe(true);
    expect(isBlockedIp("192.168.255.255")).toBe(true);
  });
  test("169.254.0.0/16 — link-local, INCLUDING the 169.254.169.254 cloud metadata address", () => {
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata
  });
  test("0.0.0.0/8 — \"this network\"", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("0.1.2.3")).toBe(true);
  });
  test("ordinary public IPv4 addresses are NOT blocked", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
  });
});

describe("isBlockedIp — IPv6 ranges", () => {
  test("::1 — loopback", () => {
    expect(isBlockedIp("::1")).toBe(true);
  });
  test("fc00::/7 — unique-local (fc00.. through fdff..)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
  });
  test("fe80::/10 — link-local", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fe80::abcd:1234")).toBe(true);
  });
  test("IPv4-mapped IPv6 forms (DOTTED tail) of blocked IPv4 ranges", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true); // loopback
    expect(isBlockedIp("::ffff:10.0.0.5")).toBe(true); // RFC1918
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true); // metadata
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
  });
  // The gate-caught gap: the canonical/normalized IPv4-mapped form is HEX, and
  // a dotted-only regex missed every one of these. Parsing to bytes catches
  // them by construction.
  test("IPv4-mapped IPv6 forms (HEX tail) of blocked IPv4 ranges are blocked", () => {
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 cloud metadata
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true); // 127.0.0.1 loopback
    expect(isBlockedIp("::ffff:7f00:0001")).toBe(true); // 127.0.0.1, zero-padded
    expect(isBlockedIp("::ffff:0a00:1")).toBe(true); // 10.0.0.1 RFC1918
    expect(isBlockedIp("::ffff:0a00:0001")).toBe(true); // 10.0.0.1, zero-padded
    expect(isBlockedIp("::ffff:c0a8:0101")).toBe(true); // 192.168.1.1
    expect(isBlockedIp("::ffff:ac10:0001")).toBe(true); // 172.16.0.1
  });
  test("HEX IPv4-mapped forms are case-insensitive and compression-variant", () => {
    expect(isBlockedIp("::FFFF:A9FE:A9FE")).toBe(true); // uppercase
    expect(isBlockedIp("0:0:0:0:0:ffff:a9fe:a9fe")).toBe(true); // fully expanded
  });
  test("HEX IPv4-mapped form of a PUBLIC address is NOT blocked", () => {
    expect(isBlockedIp("::ffff:0808:0808")).toBe(false); // 8.8.8.8
  });
  test("IPv4-mapped IPv6 form (dotted) of a PUBLIC address is NOT blocked", () => {
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });
  test(":: (unspecified / all-zeros) is blocked", () => {
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:0")).toBe(true);
  });
  test("deprecated IPv4-compatible ::a.b.c.d embedding a private v4 is blocked", () => {
    expect(isBlockedIp("::127.0.0.1")).toBe(true); // loopback
    expect(isBlockedIp("::0a00:0001")).toBe(true); // 10.0.0.1 (hex form)
    expect(isBlockedIp("::169.254.169.254")).toBe(true); // metadata
  });
  test("NAT64 64:ff9b::/96 embedding a private v4 is blocked (recommended hardening)", () => {
    expect(isBlockedIp("64:ff9b::169.254.169.254")).toBe(true); // metadata via NAT64
    expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true); // same, hex tail
    expect(isBlockedIp("64:ff9b::0a00:0001")).toBe(true); // 10.0.0.1 via NAT64
  });
  test("NAT64 embedding a PUBLIC v4 is NOT blocked", () => {
    expect(isBlockedIp("64:ff9b::8.8.8.8")).toBe(false);
  });
  test("ordinary public IPv6 addresses are NOT blocked", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
  });
  test("a malformed IPv6-looking string fails closed (blocked)", () => {
    // Not a valid literal — isIP rejects it, so isBlockedIp blocks it; and if
    // it ever reached isPrivateIPv6 directly, the byte parser returns null =>
    // blocked either way.
    expect(isPrivateIPv6("::ffff:zzzz:1")).toBe(true);
    expect(isPrivateIPv6("1::2::3")).toBe(true); // two "::" — invalid
    expect(isPrivateIPv6("")).toBe(true);
  });
});

describe("isBlockedIp — fail closed on unrecognized input", () => {
  test("a non-IP string is blocked, not silently ignored", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
    expect(isBlockedIp("evil.internal")).toBe(true);
  });
});

describe("isPrivateIPv4 / isPrivateIPv6 — direct exports match isBlockedIp", () => {
  test("isPrivateIPv4 agrees with isBlockedIp for v4 literals", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
  });
  test("isPrivateIPv6 agrees with isBlockedIp for v6 literals", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("2606:4700:4700::1111")).toBe(false);
  });
});

describe("resolvePublicHost — literal IP hostnames", () => {
  test("refuses a literal private IPv4 address with no DNS lookup", async () => {
    let lookupCalls = 0;
    const result = await resolvePublicHost("127.0.0.1", {
      lookup: async () => {
        lookupCalls++;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("private/internal");
    expect(lookupCalls).toBe(0); // literal IP never needs DNS
  });

  test("refuses the literal cloud metadata address", async () => {
    const result = await resolvePublicHost("169.254.169.254");
    expect(result.ok).toBe(false);
  });

  test("accepts a literal public IP", async () => {
    const result = await resolvePublicHost("8.8.8.8");
    expect(result.ok).toBe(true);
    expect(result.address).toBe("8.8.8.8");
    expect(result.family).toBe(4);
  });
});

describe("resolvePublicHost — hostname resolving to a private address", () => {
  test("refuses a hostname whose ONLY resolved address is private", async () => {
    const result = await resolvePublicHost("attacker.example", {
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("private/internal");
  });

  test("refuses a hostname resolving to the cloud metadata address", async () => {
    const result = await resolvePublicHost("attacker.example", {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(result.ok).toBe(false);
  });

  test("refuses wholesale when ANY of multiple resolved addresses is private (does not cherry-pick the public-looking one)", async () => {
    const result = await resolvePublicHost("multi.example", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }, // attacker-controlled DNS could add this
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts a hostname whose every resolved address is public", async () => {
    const result = await resolvePublicHost("public.example", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.ok).toBe(true);
    expect(result.address).toBe("93.184.216.34");
  });

  test("refuses a hostname that fails to resolve at all", async () => {
    const result = await resolvePublicHost("nonexistent.example", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not resolve");
  });

  test("refuses a hostname that resolves to zero addresses", async () => {
    const result = await resolvePublicHost("empty.example", {
      lookup: async () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("did not resolve");
  });
});

describe("resolvePublicHost — DNS-rebind precondition: exactly one resolution per call", () => {
  test("calls the injected lookup exactly once — no re-resolution happens inside resolvePublicHost itself", async () => {
    let calls = 0;
    const result = await resolvePublicHost("rebind.example", {
      lookup: async () => {
        calls++;
        // Simulate an attacker's DNS server: this WOULD return a private
        // address on a hypothetical second call, proving that a second call
        // (which never happens) is the only way a rebind could succeed.
        return calls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.address).toBe("93.184.216.34");
  });
});

describe("resolvePublicHost — isBlockedIpFn is test-only wiring, never bypassed by default", () => {
  test("without an override, the REAL isBlockedIp always runs", async () => {
    const result = await resolvePublicHost("attacker.example", {
      lookup: async () => [{ address: "192.168.1.1", family: 4 }],
      // no isBlockedIpFn override — must use the real, strict predicate
    });
    expect(result.ok).toBe(false);
  });
});

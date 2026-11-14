import { expect, test } from "bun:test";
import { addressAllowed, addressKind, parseCidr } from "./net-address";

test("loopback, link-local, private network and CGNAT, on IPv4 and IPv6", () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["fe80::1%eth0", "link_local"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["fd00::5", "private"],
    ["fc12:3456::1", "private"],
    ["100.64.0.1", "shared"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["224.0.0.251", "multicast"],
    ["ff02::fb", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.10", "reserved"],
    ["2001:db8::1", "reserved"],
    ["8.8.8.8", "public"],
    ["172.32.0.1", "public"],
    ["2606:4700::1111", "public"],
  ];
  for (const [ip, kind] of cases) expect([ip, addressKind(ip)]).toEqual([ip, kind as never]);
});

test("IPv4 hidden inside IPv6 follows the IPv4 rule", () => {
  expect(addressKind("::ffff:127.0.0.1")).toBe("loopback");
  expect(addressKind("::ffff:7f00:1")).toBe("loopback");
  expect(addressKind("::ffff:169.254.169.254")).toBe("link_local");
  expect(addressKind("64:ff9b::a00:1")).toBe("private");
  expect(addressKind("2002:c0a8:0101::1")).toBe("private");
  // The rest of ::/16 (compatible, translated) stays out, like the integrations' `net.ts`.
  expect(addressKind("::10.0.0.1")).toBe("reserved");
  expect(addressKind("::ffff:0:10.0.0.5")).toBe("reserved");
  expect(addressKind("::ffff:0:8.8.8.8")).toBe("reserved");
  // Local-use NAT64, which leads to the person's network (adversarial review).
  expect(addressKind("64:ff9b:1::a00:5")).toBe("private");
  expect(addressAllowed("64:ff9b:1::a00:5", []).ok).toBe(false);
  // 2001::/23 (Teredo, benchmark): no site lives there.
  expect(addressKind("2001:2::1")).toBe("reserved");
  expect(addressKind("2001:0:4136:e378::1")).toBe("reserved");
  expect(addressKind("2001:200::1")).toBe("public");
  expect(addressKind("::ffff:8.8.8.8")).toBe("public");
});

test("what is not an IP stays out", () => {
  for (const t of [
    "example.com",
    "localhost",
    "1.2.3",
    "1.2.3.4.5",
    "256.0.0.1",
    "0177.0.0.1",
    "1::2::3",
    "",
  ])
    expect([t, addressKind(t)]).toEqual([t, null]);
});

test("an allowed range opens only what it covers, and never the unspecified or multicast address", () => {
  expect(addressAllowed("192.168.1.20", []).ok).toBe(false);
  expect(addressAllowed("192.168.1.20", ["192.168.1.0/24"]).ok).toBe(true);
  expect(addressAllowed("192.168.2.20", ["192.168.1.0/24"]).ok).toBe(false);
  expect(addressAllowed("127.0.0.2", ["127.0.0.2/32"]).ok).toBe(true);
  expect(addressAllowed("127.0.0.1", ["127.0.0.2/32"])).toEqual({ ok: false, kind: "loopback" });
  expect(addressAllowed("::ffff:127.0.0.2", ["127.0.0.2"]).ok).toBe(true);
  expect(addressAllowed("0.0.0.0", ["0.0.0.0/8"]).ok).toBe(false);
  expect(addressAllowed("224.0.0.1", ["224.0.0.0/8"]).ok).toBe(false);
  expect(addressAllowed("8.8.8.8", []).ok).toBe(true);
});

test("a range too wide or badly written is not valid", () => {
  expect(parseCidr("0.0.0.0/0")).toBeNull();
  expect(parseCidr("10.0.0.0/7")).toBeNull();
  expect(parseCidr("::/0")).toBeNull();
  expect(parseCidr("10.0.0.0/33")).toBeNull();
  expect(parseCidr("10.0.0.0/8/1")).toBeNull();
  expect(parseCidr("intranet")).toBeNull();
  expect(parseCidr("10.0.0.0/8")?.bits).toBe(8);
  expect(parseCidr("fd00::/8")).toBeNull();
  expect(parseCidr("fd00::/16")?.bits).toBe(16);
  expect(parseCidr("192.168.1.10")?.bits).toBe(32);
});

// IP addresses: what kind each one is (public, loopback, private network...) and whether it falls in a CIDR
// range. The proxy of the agent's browser decides with this after resolving the name, on the runner; the
// server uses it in its checks before sending the action. No Node dependency: the web app imports it too.

export type AddressKind =
  | "public"
  | "loopback"
  | "link_local"
  | "private"
  /** 100.64.0.0/10, the provider's network (CGNAT): it reaches hosts that are not on the internet. */
  | "shared"
  /** 0.0.0.0/8 and `::`: on Linux, connecting to it is connecting to the host itself. */
  | "unspecified"
  | "multicast"
  /** Documentation, benchmark, broadcast, Teredo, discard: nothing legitimate for a browser. */
  | "reserved";

/** Kinds that a range allowed by the owner can open. The others never open. */
const OPENABLE: ReadonlySet<AddressKind> = new Set(["loopback", "link_local", "private", "shared"]);

interface Ip {
  v: 4 | 6;
  bytes: Uint8Array;
}

function parseV4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i] ?? "";
    // Only the canonical decimal form: "0177.0.0.1" and "0x7f.1" are not IPs here (the browser's URL parser
    // already converts those forms before they reach the proxy or the rule).
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(text: string): Uint8Array | null {
  let s = text;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.length < 2) return null;
  let tail: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail = parseV4(s.slice(lastColon + 1));
    if (!tail) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const group = (part: string) => (part === "" ? [] : part.split(":"));
  const head = group(halves[0] ?? "");
  const rest = halves.length === 2 ? group(halves[1] ?? "") : [];
  const total = head.length + rest.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const words = [...head, ...Array(8 - total).fill("0"), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const w = words[i] ?? "";
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
    const n = Number.parseInt(w, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

/** IP literal (with or without brackets), or null if it is not an IP. */
export function parseIp(text: string): Ip | null {
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const v4 = parseV4(bare);
  if (v4) return { v: 4, bytes: v4 };
  const v6 = bare.includes(":") ? parseV6(bare) : null;
  return v6 ? { v: 6, bytes: v6 } : null;
}

function v4Kind(b: Uint8Array): AddressKind {
  const [a = 0, c = 0, d = 0] = [b[0], b[1], b[2]];
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "link_local";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 168) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "shared";
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return "reserved";
  if (a === 198 && (c === 18 || c === 19)) return "reserved";
  if (a === 198 && c === 51 && d === 100) return "reserved";
  if (a === 203 && c === 0 && d === 113) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

const startsWith = (b: Uint8Array, prefix: number[]) => prefix.every((x, i) => b[i] === x);
const zeros = (b: Uint8Array, from: number, to: number) => b.subarray(from, to).every((x) => x === 0);

function v6Kind(b: Uint8Array): AddressKind {
  if (zeros(b, 0, 16)) return "unspecified";
  if (zeros(b, 0, 15) && b[15] === 1) return "loopback";
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:AABB:CCDD::) resolve to
  // the IPv4 inside.
  if (zeros(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Kind(b.subarray(12));
  // The rest of ::/16 (IPv4-compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d) does not go out to the
  // internet: it stays out, whatever the IPv4 inside.
  if (b[0] === 0 && b[1] === 0) return "reserved";
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b]) && zeros(b, 4, 12)) return v4Kind(b.subarray(12));
  // Local-use NAT64 (64:ff9b:1::/48): the translator belongs to the person's network and the IPv4 may sit in
  // any position, depending on the prefix they chose. It counts as a whole private network.
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return "private";
  if (startsWith(b, [0x20, 0x02])) return v4Kind(b.subarray(2, 6));
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if (first === 0xff) return "multicast";
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link_local";
  if (first === 0xfe && (second & 0xc0) === 0xc0) return "private";
  if ((first & 0xfe) === 0xfc) return "private";
  if (startsWith(b, [0x20, 0x01, 0x0d, 0xb8])) return "reserved";
  // 2001::/23, IETF protocol addresses (Teredo, benchmark 2001:2::/48, ORCHID): no site.
  if (first === 0x20 && second === 0x01 && ((b[2] ?? 0) & 0xfe) === 0) return "reserved";
  if (startsWith(b, [0x01, 0x00]) && zeros(b, 2, 8)) return "reserved";
  return "public";
}

/** Kind of the address, or null if the text is not an IP. */
export function addressKind(text: string): AddressKind | null {
  const ip = parseIp(text);
  if (!ip) return null;
  return ip.v === 4 ? v4Kind(ip.bytes) : v6Kind(ip.bytes);
}

interface Cidr {
  v: 4 | 6;
  bytes: Uint8Array;
  bits: number;
}

/**
 * A CIDR range (`10.0.0.0/8`, `fd00::/8`) or a single IP. Ranges that are too wide (shorter than /8 on IPv4,
 * /16 on IPv6) are not valid: opening the whole internet this way makes no sense and would open everything at
 * once.
 */
export function parseCidr(text: string): Cidr | null {
  const [addr = "", bitsText, extra] = text.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const min = ip.v === 4 ? 8 : 16;
  if (bitsText !== undefined && !/^\d{1,3}$/.test(bitsText)) return null;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (bits < min || bits > max) return null;
  return { v: ip.v, bytes: ip.bytes, bits };
}

function inCidr(ip: Ip, cidr: Cidr): boolean {
  if (ip.v !== cidr.v) return false;
  for (let bit = 0; bit < cidr.bits; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((ip.bytes[byte] ?? 0) & mask) !== ((cidr.bytes[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** IPv4 inside a mapped IPv6, so that the range `127.0.0.1/32` also covers `::ffff:127.0.0.1`. */
function unwrap(ip: Ip): Ip {
  if (ip.v === 6 && zeros(ip.bytes, 0, 10) && ip.bytes[10] === 0xff && ip.bytes[11] === 0xff)
    return { v: 4, bytes: ip.bytes.slice(12) };
  return ip;
}

type AddressVerdict = { ok: true } | { ok: false; kind: AddressKind };

/**
 * The whole range is a network that can be allowed (loopback, link-local, private, CGNAT): its first and last
 * address fall in the same allowable kind. `8.8.8.0/24` (public, already open) and `10.0.0.0/7` (it takes
 * `11.0.0.0/8`, public) do not pass.
 */
export function rangeOpenable(text: string): boolean {
  const cidr = parseCidr(text);
  if (!cidr) return false;
  const first = new Uint8Array(cidr.bytes);
  const last = new Uint8Array(cidr.bytes);
  for (let bit = cidr.bits; bit < first.length * 8; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    first[byte] = (first[byte] ?? 0) & ~mask;
    last[byte] = (last[byte] ?? 0) | mask;
  }
  const kind = (b: Uint8Array) => (cidr.v === 4 ? v4Kind(b) : v6Kind(b));
  const a = kind(first);
  return OPENABLE.has(a) && kind(last) === a;
}

/**
 * May the browser connect to this IP? Public yes; loopback, link-local, private and CGNAT only if a range
 * allowed by the owner covers the address; the rest never.
 */
export function addressAllowed(text: string, ranges: readonly string[]): AddressVerdict {
  const ip = parseIp(text);
  if (!ip) return { ok: false, kind: "reserved" };
  const kind = ip.v === 4 ? v4Kind(ip.bytes) : v6Kind(ip.bytes);
  if (kind === "public") return { ok: true };
  if (!OPENABLE.has(kind)) return { ok: false, kind };
  const plain = unwrap(ip);
  for (const r of ranges) {
    const cidr = parseCidr(r);
    if (cidr && (inCidr(ip, cidr) || inCidr(plain, cidr))) return { ok: true };
  }
  return { ok: false, kind };
}

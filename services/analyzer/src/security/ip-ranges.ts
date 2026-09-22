import net from 'node:net';

export interface IpVerdict {
  /** null ise adres kullanılabilir. */
  blockedReason: string | null;
  /** 127.0.0.0/8 veya ::1 ise true (test bayrağıyla serbest bırakılabilir). */
  isLoopback: boolean;
}

function v4ToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

export function parseIPv4(value: string): [number, number, number, number] | null {
  if (!net.isIPv4(value)) return null;
  const parts = value.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/** IPv6 metnini 16 baytlık diziye çevirir; gömülü IPv4 gösterimini destekler. */
export function parseIPv6(value: string): Uint8Array | null {
  if (!net.isIPv6(value)) return null;
  let text = value;

  // Gömülü IPv4 (ör. ::ffff:127.0.0.1) → son 32 biti hex'e çevir.
  const embedded = /^(.*:)((\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (embedded) {
    const v4 = parseIPv4(embedded[2]!);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${embedded[1]}${hi}:${lo}`;
  }

  const [head, tail, ...rest] = text.split('::');
  if (rest.length > 0) return null;

  const toGroups = (s: string | undefined): number[] =>
    s === undefined || s === '' ? [] : s.split(':').map((g) => Number.parseInt(g, 16));

  const headGroups = toGroups(head);
  const tailGroups = tail === undefined ? [] : toGroups(tail);
  if (headGroups.some(Number.isNaN) || tailGroups.some(Number.isNaN)) return null;

  let groups: number[];
  if (tail === undefined) {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  } else {
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i]!;
    if (g < 0 || g > 0xffff) return null;
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

interface V4Range {
  cidr: string;
  reason: string;
  base: number;
  mask: number;
}

function range(cidr: string, reason: string): V4Range {
  const [addr, bitsRaw] = cidr.split('/');
  const parsed = parseIPv4(addr!)!;
  const bits = Number.parseInt(bitsRaw!, 10);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { cidr, reason, base: ((v4ToInt(...parsed) & mask) >>> 0), mask };
}

/** docs/design §2.3 — IPv4 engelli aralıklar. */
const BLOCKED_V4: V4Range[] = [
  range('0.0.0.0/8', 'this-network'),
  range('10.0.0.0/8', 'private'),
  range('100.64.0.0/10', 'carrier-grade-nat'),
  range('127.0.0.0/8', 'loopback'),
  range('169.254.0.0/16', 'link-local (cloud metadata)'),
  range('172.16.0.0/12', 'private'),
  range('192.0.0.0/24', 'ietf-protocol-assignments'),
  range('192.0.2.0/24', 'test-net-1'),
  range('192.88.99.0/24', '6to4-relay-anycast'),
  range('192.168.0.0/16', 'private'),
  range('198.18.0.0/15', 'benchmarking'),
  range('198.51.100.0/24', 'test-net-2'),
  range('203.0.113.0/24', 'test-net-3'),
  range('224.0.0.0/4', 'multicast'),
  range('240.0.0.0/4', 'reserved'),
];

export function checkIPv4(value: string): IpVerdict {
  const parsed = parseIPv4(value);
  if (!parsed) return { blockedReason: 'not a valid IPv4 address', isLoopback: false };
  const n = v4ToInt(...parsed);
  const isLoopback = (n & 0xff000000) >>> 0 === (127 << 24) >>> 0;
  for (const r of BLOCKED_V4) {
    if ((n & r.mask) >>> 0 === r.base) {
      return { blockedReason: `${r.cidr} (${r.reason})`, isLoopback };
    }
  }
  return { blockedReason: null, isLoopback };
}

function prefixMatches(bytes: Uint8Array, prefixHex: string, bits: number): boolean {
  const prefix = parseIPv6(prefixHex)!;
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

function bytesToV4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

export function checkIPv6(value: string): IpVerdict {
  const bytes = parseIPv6(value);
  if (!bytes) return { blockedReason: 'not a valid IPv6 address', isLoopback: false };

  const isAllZero = bytes.every((b) => b === 0);
  if (isAllZero) return { blockedReason: ':: (unspecified)', isLoopback: false };

  const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (isLoopback) return { blockedReason: '::1 (loopback)', isLoopback: true };

  // Gömülü IPv4 taşıyan biçimler: açıp IPv4 kurallarını tekrar uygula.
  if (prefixMatches(bytes, '::ffff:0:0', 96)) {
    const inner = checkIPv4(bytesToV4(bytes, 12));
    return {
      blockedReason: inner.blockedReason ? `ipv4-mapped → ${inner.blockedReason}` : null,
      isLoopback: inner.isLoopback,
    };
  }
  if (prefixMatches(bytes, '64:ff9b::', 96)) {
    const inner = checkIPv4(bytesToV4(bytes, 12));
    return {
      blockedReason: inner.blockedReason ? `nat64 → ${inner.blockedReason}` : null,
      isLoopback: inner.isLoopback,
    };
  }
  if (prefixMatches(bytes, '2002::', 16)) {
    const inner = checkIPv4(bytesToV4(bytes, 2));
    return {
      blockedReason: inner.blockedReason ? `6to4 → ${inner.blockedReason}` : null,
      isLoopback: inner.isLoopback,
    };
  }

  const blocks: Array<[string, number, string]> = [
    ['100::', 64, 'discard-only'],
    ['2001::', 32, 'teredo'],
    ['2001:db8::', 32, 'documentation'],
    ['fc00::', 7, 'unique-local'],
    ['fe80::', 10, 'link-local'],
    ['ff00::', 8, 'multicast'],
  ];
  for (const [prefix, bits, reason] of blocks) {
    if (prefixMatches(bytes, prefix, bits)) {
      return { blockedReason: `${prefix}/${bits} (${reason})`, isLoopback: false };
    }
  }
  return { blockedReason: null, isLoopback: false };
}

export function checkIp(value: string): IpVerdict {
  const family = net.isIP(value);
  if (family === 4) return checkIPv4(value);
  if (family === 6) return checkIPv6(value);
  return { blockedReason: 'not an IP address', isLoopback: false };
}

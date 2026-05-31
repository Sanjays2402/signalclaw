// Source-IP allowlist helpers for per-key CIDR enforcement.
//
// No external dependencies. Handles:
//   - bare IPv4 ("203.0.113.5") as /32
//   - IPv4 CIDR ("10.0.0.0/8")
//   - bare IPv6 ("2001:db8::1") as /128
//   - IPv6 CIDR ("2001:db8::/32")
//   - IPv4-mapped IPv6 ("::ffff:203.0.113.5") collapses to its IPv4 form so a
//     v4 CIDR still matches a request that arrived on a dual-stack socket
//
// Validation is strict: anything we cannot confidently parse is rejected at
// the API boundary, so we never silently treat a typo as "allow everything".

export type ParsedCidr =
  | { kind: "v4"; bits: number; value: bigint }
  | { kind: "v6"; bits: number; value: bigint };

const V4_MAX = 32;
const V6_MAX = 128;

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function parseV6(s: string): bigint | null {
  // Reject lone "::" with no surrounding context here is fine; "::" itself is valid.
  if (!s.includes(":")) return null;
  // Expand IPv4-mapped tail.
  let work = s;
  const lastColon = work.lastIndexOf(":");
  const tail = work.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    const hi = Number((v4 >> 16n) & 0xffffn);
    const lo = Number(v4 & 0xffffn);
    work = work.slice(0, lastColon + 1) + hi.toString(16) + ":" + lo.toString(16);
  }
  // Split on "::" for zero compression.
  let head: string[] = [];
  let tailGroups: string[] = [];
  if (work.includes("::")) {
    const halves = work.split("::");
    if (halves.length !== 2) return null;
    head = halves[0] === "" ? [] : halves[0].split(":");
    tailGroups = halves[1] === "" ? [] : halves[1].split(":");
    if (head.length + tailGroups.length > 8) return null;
  } else {
    head = work.split(":");
    if (head.length !== 8) return null;
  }
  const zeros = 8 - head.length - tailGroups.length;
  const groups = [...head, ...Array(zeros).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    acc = (acc << 16n) | BigInt(parseInt(g, 16));
  }
  return acc;
}

export function parseCidr(input: string): ParsedCidr | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  const addr = slash === -1 ? raw : raw.slice(0, slash);
  const bitsStr = slash === -1 ? null : raw.slice(slash + 1);

  if (addr.includes(":")) {
    const v = parseV6(addr);
    if (v === null) return null;
    let bits = V6_MAX;
    if (bitsStr !== null) {
      if (!/^\d{1,3}$/.test(bitsStr)) return null;
      bits = Number(bitsStr);
      if (bits < 0 || bits > V6_MAX) return null;
    }
    return { kind: "v6", bits, value: maskBig(v, bits, V6_MAX) };
  }
  const v = parseV4(addr);
  if (v === null) return null;
  let bits = V4_MAX;
  if (bitsStr !== null) {
    if (!/^\d{1,3}$/.test(bitsStr)) return null;
    bits = Number(bitsStr);
    if (bits < 0 || bits > V4_MAX) return null;
  }
  return { kind: "v4", bits, value: maskBig(v, bits, V4_MAX) };
}

function maskBig(v: bigint, bits: number, max: number): bigint {
  if (bits >= max) return v;
  if (bits <= 0) return 0n;
  const shift = BigInt(max - bits);
  return (v >> shift) << shift;
}

// Normalize an incoming IP (may be IPv4-mapped IPv6 like "::ffff:203.0.113.5",
// may include zone id, may be a raw v4) to its canonical compact form for
// comparison purposes. Returns null on parse failure.
export function normalizeIp(input: string): string | null {
  let s = (input || "").trim();
  if (!s) return null;
  // Strip wrapping brackets ("[::1]") and IPv6 zone identifier ("fe80::1%en0").
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  // IPv4-mapped IPv6 → IPv4.
  const mappedMatch = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedMatch) return mappedMatch[1];
  return s;
}

export function ipMatchesAny(ip: string, cidrs: ParsedCidr[]): boolean {
  const norm = normalizeIp(ip);
  if (norm === null) return false;
  if (norm.includes(":")) {
    const v = parseV6(norm);
    if (v === null) return false;
    for (const c of cidrs) {
      if (c.kind !== "v6") continue;
      if (maskBig(v, c.bits, V6_MAX) === c.value) return true;
    }
    return false;
  }
  const v = parseV4(norm);
  if (v === null) return false;
  for (const c of cidrs) {
    if (c.kind !== "v4") continue;
    if (maskBig(v, c.bits, V4_MAX) === c.value) return true;
  }
  return false;
}

// Validates and canonicalizes a user-submitted list. Returns the canonical
// string form (e.g. "10.0.0.0/8") for storage, deduped and trimmed. Throws
// with a structured error on the first bad entry so the API can 400 cleanly.
export const MAX_CIDR_ENTRIES = 64;

export function canonicalizeCidrList(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    throw Object.assign(new Error("ip_allowlist must be an array of strings"), {
      code: "bad_type",
    });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== "string") {
      throw Object.assign(new Error("ip_allowlist entries must be strings"), {
        code: "bad_type",
      });
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = parseCidr(trimmed);
    if (!parsed) {
      throw Object.assign(
        new Error(`invalid CIDR or IP literal: ${raw}`),
        { code: "bad_cidr" },
      );
    }
    const canon = cidrToString(parsed);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
    if (out.length > MAX_CIDR_ENTRIES) {
      throw Object.assign(
        new Error(`ip_allowlist exceeds maximum of ${MAX_CIDR_ENTRIES} entries`),
        { code: "too_many" },
      );
    }
  }
  return out;
}

function cidrToString(c: ParsedCidr): string {
  if (c.kind === "v4") {
    const v = c.value;
    const a = Number((v >> 24n) & 0xffn);
    const b = Number((v >> 16n) & 0xffn);
    const d = Number((v >> 8n) & 0xffn);
    const e = Number(v & 0xffn);
    return `${a}.${b}.${d}.${e}/${c.bits}`;
  }
  // v6: compact form with leading-zero stripping and one zero run collapsed.
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    const g = Number((c.value >> BigInt(i * 16)) & 0xffffn);
    groups.push(g.toString(16));
  }
  // Find longest run of "0" groups for "::" compression (RFC 5952-ish).
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  let addr: string;
  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).join(":");
    const tail = groups.slice(bestStart + bestLen).join(":");
    addr = `${head}::${tail}`;
  } else {
    addr = groups.join(":");
  }
  return `${addr}/${c.bits}`;
}

// Extract the client IP from a Next.js Request. Respects standard proxy
// headers, falling back to the platform's "x-real-ip" and finally to an
// empty string. Callers should treat empty as "unknown" and deny if the
// allowlist is non-empty.
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Leftmost is the originating client; the rest are proxies.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "";
}

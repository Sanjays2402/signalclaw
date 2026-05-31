// Outbound webhook egress policy.
//
// Procurement reality: every security review asks how we prevent the webhook
// system from being turned into an SSRF probe against the buyer's internal
// network (cloud metadata, RFC1918, link-local, etc). This module is the one
// place that answers that question.
//
// Two layers:
//
//   1. Default-deny on dangerous destinations (loopback, RFC1918, link-local,
//      CGNAT, multicast, unspecified, IPv6 ULA/link-local, IPv4-mapped v6).
//      Hostnames are DNS-resolved (lookup all=true) and EVERY resolved
//      address must pass. This is checked at create/update time and again
//      immediately before each delivery attempt, so a DNS rebind between
//      "save webhook" and "send event" cannot bypass the policy.
//
//   2. Optional per-deployment allowlist. When `policy.cidrs` is non-empty,
//      EVERY resolved address must also fall inside an allowed CIDR. Empty
//      list means layer 1 only.
//
// The policy can be flipped to `allow_private: true` for self-hosted dev
// loops, but the default off-the-shelf posture refuses to talk to any private
// destination, which is what enterprise IT expects from a SaaS callback.
//
// Persisted at <DATA_DIR>/egress-policy.json. Mutations are audited by the
// caller (admin route).

import { promises as fs } from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import {
  parseCidr,
  ipMatchesAny,
  canonicalizeCidrList,
  MAX_CIDR_ENTRIES,
  type ParsedCidr,
} from "./ipMatch.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "egress-policy.json");

export type EgressPolicy = {
  // When true, the RFC1918 / loopback / link-local blocklist is bypassed.
  // Defaults to false. Buyers should never need to enable this; it exists
  // for self-hosted dev where the webhook target is on the same host.
  allow_private: boolean;
  // Optional outbound CIDR allowlist. When non-empty, every resolved IP of a
  // webhook destination must match one of these CIDRs.
  cidrs: string[];
  updated_at: string | null;
  updated_by: string | null;
};

export const DEFAULT_POLICY: EgressPolicy = {
  allow_private: false,
  cidrs: [],
  updated_at: null,
  updated_by: null,
};

export type PolicyView = EgressPolicy & {
  max_cidrs: number;
};

export async function getPolicy(): Promise<EgressPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const j = JSON.parse(raw);
    return {
      allow_private: !!j.allow_private,
      cidrs: Array.isArray(j.cidrs) ? j.cidrs.filter((s: unknown) => typeof s === "string") : [],
      updated_at: typeof j.updated_at === "string" ? j.updated_at : null,
      updated_by: typeof j.updated_by === "string" ? j.updated_by : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ...DEFAULT_POLICY };
    return { ...DEFAULT_POLICY };
  }
}

export async function setPolicy(
  input: { allow_private?: unknown; cidrs?: unknown },
  actor: string | null,
): Promise<{ ok: true; policy: EgressPolicy; before: EgressPolicy } | { ok: false; error: string; code: string }> {
  const before = await getPolicy();
  const allow_private = typeof input.allow_private === "boolean" ? input.allow_private : before.allow_private;
  let cidrs: string[];
  try {
    cidrs = canonicalizeCidrList(input.cidrs ?? before.cidrs);
  } catch (e: any) {
    return { ok: false, code: "bad_cidr", error: String(e?.message || e || "invalid CIDR list") };
  }
  if (cidrs.length > MAX_CIDR_ENTRIES) {
    return { ok: false, code: "too_many_cidrs", error: `at most ${MAX_CIDR_ENTRIES} CIDR entries` };
  }
  const next: EgressPolicy = {
    allow_private,
    cidrs,
    updated_at: new Date().toISOString(),
    updated_by: actor,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, POLICY_FILE);
  return { ok: true, policy: next, before };
}

export function publicPolicy(p: EgressPolicy): PolicyView {
  return { ...p, max_cidrs: MAX_CIDR_ENTRIES };
}

// ---------------------------------------------------------------------------
// Destination evaluation
// ---------------------------------------------------------------------------

// IPv4 blocks that should never be the destination of an outbound webhook
// unless the operator has explicitly opted into allow_private.
//   0.0.0.0/8            "this network"
//   10.0.0.0/8           RFC1918
//   100.64.0.0/10        CGNAT
//   127.0.0.0/8          loopback
//   169.254.0.0/16       link-local (covers AWS/GCP metadata 169.254.169.254)
//   172.16.0.0/12        RFC1918
//   192.0.0.0/24         IETF protocol assignments
//   192.0.2.0/24         TEST-NET-1
//   192.168.0.0/16       RFC1918
//   198.18.0.0/15        benchmarking
//   198.51.100.0/24      TEST-NET-2
//   203.0.113.0/24       TEST-NET-3
//   224.0.0.0/4          multicast
//   240.0.0.0/4          reserved (covers 255.255.255.255)
const V4_DENY_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

// IPv6 blocks: unspecified, loopback, ULA (fc00::/7), link-local (fe80::/10),
// multicast (ff00::/8), discard-only (100::/64), 6to4 relay (2002::/16 not
// strictly private but a common rebind vector — we leave allowed), and
// IPv4-mapped (::ffff:0:0/96) which we also separately collapse to v4.
const V6_DENY_CIDRS = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "::ffff:0:0/96",
  "64:ff9b::/96", // NAT64
];

const PRIVATE_DENY: ParsedCidr[] = [
  ...V4_DENY_CIDRS.map((c) => parseCidr(c)!),
  ...V6_DENY_CIDRS.map((c) => parseCidr(c)!),
];

export type EvalResult =
  | { ok: true; resolved: string[] }
  | { ok: false; code: string; reason: string };

function parseAllowlist(policy: EgressPolicy): ParsedCidr[] {
  const out: ParsedCidr[] = [];
  for (const c of policy.cidrs) {
    const p = parseCidr(c);
    if (p) out.push(p);
  }
  return out;
}

// Test seam: allow tests to inject a fake resolver.
export type ResolveFn = (host: string) => Promise<string[]>;
const defaultResolver: ResolveFn = async (host) => {
  const recs = await dns.lookup(host, { all: true, verbatim: true });
  return recs.map((r) => r.address);
};

export async function evaluateUrl(
  url: string,
  policy: EgressPolicy,
  opts: { resolve?: ResolveFn } = {},
): Promise<EvalResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: "bad_url", reason: "URL is not valid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, code: "bad_scheme", reason: "URL must be http(s)" };
  }
  const host = u.hostname;
  if (!host) return { ok: false, code: "no_host", reason: "URL has no host" };

  // Reject userinfo (e.g. http://attacker@internal/) — it's almost always
  // an obfuscation attempt and never required for a real webhook.
  if (u.username || u.password) {
    return { ok: false, code: "userinfo", reason: "URL must not contain userinfo" };
  }

  // Resolve the host (or treat a literal IP as its own resolution).
  let addresses: string[];
  const literal = parseIpLiteral(host);
  if (literal) {
    addresses = [literal];
  } else {
    try {
      const resolve = opts.resolve ?? defaultResolver;
      addresses = await resolve(host);
      if (!addresses.length) {
        return { ok: false, code: "no_addresses", reason: `host ${host} did not resolve` };
      }
    } catch (e: any) {
      return {
        ok: false,
        code: "dns_failed",
        reason: `DNS lookup for ${host} failed: ${e?.code || e?.message || "error"}`,
      };
    }
  }

  for (const addr of addresses) {
    if (!policy.allow_private && ipMatchesAny(addr, PRIVATE_DENY)) {
      return {
        ok: false,
        code: "private_destination",
        reason: `resolved address ${addr} is in a blocked range (private/loopback/link-local/multicast)`,
      };
    }
  }

  const allow = parseAllowlist(policy);
  if (allow.length > 0) {
    for (const addr of addresses) {
      if (!ipMatchesAny(addr, allow)) {
        return {
          ok: false,
          code: "not_in_allowlist",
          reason: `resolved address ${addr} is not in the outbound allowlist`,
        };
      }
    }
  }

  return { ok: true, resolved: addresses };
}

function parseIpLiteral(host: string): string | null {
  // URL parser leaves IPv6 hosts wrapped in [] — strip those.
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Quick literal check: parseCidr accepts both bare IP and CIDR; bare IP
  // returns a /32 or /128.
  const p = parseCidr(h);
  if (!p) return null;
  return h;
}

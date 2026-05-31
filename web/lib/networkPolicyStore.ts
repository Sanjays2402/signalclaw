// Workspace-level network policy.
//
// Procurement reality: enterprise IT teams want to assert that only their
// corporate egress ranges can reach the SaaS surface at all. Per-API-key
// allowlists (keyIpPolicy) are great, but they don't gate the dashboard or
// keyless endpoints. This module is the workspace-wide allowlist that runs
// in front of v1 + admin routes.
//
// Persisted at <DATA_DIR>/network-policy.json. Mutations are audited by the
// caller (admin route). Loopback and health/metrics probes are *always*
// allowed even when enforcing, so liveness checks keep working.
//
// Safety: refusing to enable an empty allowlist prevents the obvious
// lock-out-everyone foot-gun. The admin route surfaces that as 400 and the
// settings UI surfaces it as a lockout warning before save.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseCidr,
  ipMatchesAny,
  canonicalizeCidrList,
  MAX_CIDR_ENTRIES,
  clientIpFromRequest,
  normalizeIp,
  type ParsedCidr,
} from "./ipMatch.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "network-policy.json");

export const MAX_CIDRS = MAX_CIDR_ENTRIES;

export type NetworkPolicy = {
  enabled: boolean;
  cidrs: string[];
  updated_at: string | null;
  updated_by: string | null;
};

const DEFAULT_POLICY: NetworkPolicy = {
  enabled: false,
  cidrs: [],
  updated_at: null,
  updated_by: null,
};

function clone(p: NetworkPolicy): NetworkPolicy {
  return {
    enabled: p.enabled,
    cidrs: [...p.cidrs],
    updated_at: p.updated_at,
    updated_by: p.updated_by,
  };
}

export async function getPolicy(): Promise<NetworkPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return clone(DEFAULT_POLICY);
    return {
      enabled: !!j.enabled,
      cidrs: Array.isArray(j.cidrs)
        ? j.cidrs.filter((c: unknown): c is string => typeof c === "string")
        : [],
      updated_at: typeof j.updated_at === "string" ? j.updated_at : null,
      updated_by: typeof j.updated_by === "string" ? j.updated_by : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return clone(DEFAULT_POLICY);
    throw e;
  }
}

export type UpdateInput = {
  enabled: boolean;
  cidrs: string[];
  actor?: string | null;
};

export type UpdateResult =
  | { ok: true; policy: NetworkPolicy; before: NetworkPolicy }
  | { ok: false; code: "bad_type" | "bad_cidr" | "too_many" | "empty_allowlist"; message: string };

export async function updatePolicy(input: UpdateInput): Promise<UpdateResult> {
  let canon: string[];
  try {
    canon = canonicalizeCidrList(input.cidrs);
  } catch (e: any) {
    const code = e?.code === "bad_type" || e?.code === "bad_cidr" || e?.code === "too_many"
      ? e.code
      : "bad_cidr";
    return { ok: false, code, message: String(e?.message || e) };
  }
  if (input.enabled && canon.length === 0) {
    return {
      ok: false,
      code: "empty_allowlist",
      message: "refusing to enable enforcement with an empty allowlist (lockout protection)",
    };
  }
  const before = await getPolicy();
  const next: NetworkPolicy = {
    enabled: !!input.enabled,
    cidrs: canon,
    updated_at: new Date().toISOString(),
    updated_by: input.actor ?? null,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, POLICY_FILE);
  return { ok: true, policy: next, before };
}

let cidrCache: { sig: string; parsed: ParsedCidr[] } | null = null;
function parsedCidrs(policy: NetworkPolicy): ParsedCidr[] {
  const sig = policy.cidrs.join(",");
  if (cidrCache && cidrCache.sig === sig) return cidrCache.parsed;
  const parsed: ParsedCidr[] = [];
  for (const c of policy.cidrs) {
    const p = parseCidr(c);
    if (p) parsed.push(p);
  }
  cidrCache = { sig, parsed };
  return parsed;
}

export function isLoopback(ip: string): boolean {
  const n = normalizeIp(ip);
  if (!n) return false;
  return n === "127.0.0.1" || n === "::1";
}

export type CheckDecision =
  | { allowed: true; reason: "policy-disabled" | "loopback" | "matched" }
  | { allowed: false; reason: "no-ip" | "not-matched"; ip: string };

export function decideAllowed(req: Request, policy: NetworkPolicy): CheckDecision {
  if (!policy.enabled) return { allowed: true, reason: "policy-disabled" };
  const ip = clientIpFromRequest(req);
  if (!ip) return { allowed: false, reason: "no-ip", ip: "" };
  if (isLoopback(ip)) return { allowed: true, reason: "loopback" };
  const parsed = parsedCidrs(policy);
  if (parsed.length === 0) {
    // Defensive: store should prevent this, but never lock out if somehow empty.
    return { allowed: true, reason: "policy-disabled" };
  }
  return ipMatchesAny(ip, parsed)
    ? { allowed: true, reason: "matched" }
    : { allowed: false, reason: "not-matched", ip };
}

// Test seam.
export function _resetCache(): void {
  cidrCache = null;
}

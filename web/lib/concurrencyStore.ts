// Per-workspace concurrent request limit for /api/v1/*.
//
// Procurement reality: enterprise customers share an API key (or a small
// pool) across multiple internal services. Per-minute rate limits don't
// protect against a single misbehaving client opening dozens of long
// inference requests at once and starving everyone else. SOC2 reviewers
// also ask for a "noisy neighbour" control as part of capacity planning.
//
// This module persists a single integer policy at <DATA_DIR>/concurrency.json
// and tracks the live in-flight counter in-process. Enforcement lives in
// lib/v1Guard.ts so every authenticated v1 route is covered.
//
// - GET state via getConcurrencyPolicy()
// - SET via setConcurrencyPolicy({ limit, actor })
// - CLEAR via clearConcurrencyPolicy({ actor })
// - At request start the v1 guard calls tryAcquire(); on block it returns
//   429 with x-concurrency-* headers and never invokes the handler.
// - At request end the v1 guard calls release() in a finally so a thrown
//   handler does not leak slots.
//
// Single-node by design: this is in-process. Multi-node deployments should
// reuse the same lever in their reverse proxy or shared store; the policy
// itself stays the source of truth.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "concurrency.json");

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 10_000;

export type ConcurrencyPolicy = {
  // null means "no per-workspace concurrency cap"; the global per-key rate
  // limit still applies as before.
  limit: number | null;
  updated_at: string | null;
  updated_by: string | null;
};

const DEFAULT_POLICY: ConcurrencyPolicy = {
  limit: null,
  updated_at: null,
  updated_by: null,
};

function clone(p: ConcurrencyPolicy): ConcurrencyPolicy {
  return { ...p };
}

let _cache: { policy: ConcurrencyPolicy; loadedAt: number } | null = null;
const CACHE_TTL_MS = 1_000;

// In-flight counter is process-local. Stored on globalThis so hot-reload in
// dev does not zero it under load.
type Counter = { inFlight: number };
function counter(): Counter {
  const g = globalThis as any;
  if (!g.__signalclawConcurrency) {
    g.__signalclawConcurrency = { inFlight: 0 } as Counter;
  }
  return g.__signalclawConcurrency as Counter;
}

export function __resetConcurrency(): void {
  _cache = null;
  counter().inFlight = 0;
}

export function getInFlight(): number {
  return counter().inFlight;
}

async function readFromDisk(): Promise<ConcurrencyPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return clone(DEFAULT_POLICY);
    const lim = j.limit;
    const limit =
      typeof lim === "number" && Number.isFinite(lim) && lim >= MIN_LIMIT && lim <= MAX_LIMIT
        ? Math.floor(lim)
        : null;
    return {
      limit,
      updated_at: typeof j.updated_at === "string" ? j.updated_at : null,
      updated_by: typeof j.updated_by === "string" ? j.updated_by : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return clone(DEFAULT_POLICY);
    throw e;
  }
}

export async function getConcurrencyPolicy(): Promise<ConcurrencyPolicy> {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return clone(_cache.policy);
  }
  const p = await readFromDisk();
  _cache = { policy: p, loadedAt: now };
  return clone(p);
}

async function writeToDisk(p: ConcurrencyPolicy): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2) + "\n", "utf8");
  await fs.rename(tmp, POLICY_FILE);
  _cache = { policy: clone(p), loadedAt: Date.now() };
}

export type SetInput = { limit: number; actor?: string | null };

export type SetResult =
  | { ok: true; policy: ConcurrencyPolicy; before: ConcurrencyPolicy }
  | { ok: false; code: "bad_limit"; message: string };

export async function setConcurrencyPolicy(input: SetInput): Promise<SetResult> {
  const n = input.limit;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.floor(n) !== n) {
    return { ok: false, code: "bad_limit", message: "limit must be an integer" };
  }
  if (n < MIN_LIMIT || n > MAX_LIMIT) {
    return {
      ok: false,
      code: "bad_limit",
      message: `limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    };
  }
  const before = await getConcurrencyPolicy();
  const next: ConcurrencyPolicy = {
    limit: n,
    updated_at: new Date().toISOString(),
    updated_by: input.actor ?? null,
  };
  await writeToDisk(next);
  return { ok: true, policy: next, before };
}

export async function clearConcurrencyPolicy(input: {
  actor?: string | null;
}): Promise<{ policy: ConcurrencyPolicy; before: ConcurrencyPolicy }> {
  const before = await getConcurrencyPolicy();
  const next: ConcurrencyPolicy = {
    limit: null,
    updated_at: new Date().toISOString(),
    updated_by: input.actor ?? null,
  };
  await writeToDisk(next);
  return { policy: next, before };
}

export type AcquireDecision =
  | { allowed: true; inFlight: number; limit: number | null }
  | { allowed: false; inFlight: number; limit: number; retryAfter: number };

// Atomic-enough for single-process Node: check then increment, both
// synchronous. Concurrent micro-tasks may race the read but the worst case
// is one extra slot above the cap, which is acceptable for a soft control.
export function tryAcquire(policy: ConcurrencyPolicy): AcquireDecision {
  const c = counter();
  if (policy.limit === null) {
    c.inFlight += 1;
    return { allowed: true, inFlight: c.inFlight, limit: null };
  }
  if (c.inFlight >= policy.limit) {
    return {
      allowed: false,
      inFlight: c.inFlight,
      limit: policy.limit,
      retryAfter: 1,
    };
  }
  c.inFlight += 1;
  return { allowed: true, inFlight: c.inFlight, limit: policy.limit };
}

export function release(): void {
  const c = counter();
  c.inFlight = Math.max(0, c.inFlight - 1);
}

export function applyConcurrencyHeaders(
  headers: Headers,
  decision: AcquireDecision,
): void {
  if (decision.limit !== null) {
    headers.set("x-concurrency-limit", String(decision.limit));
  }
  headers.set("x-concurrency-in-flight", String(decision.inFlight));
  if (!decision.allowed) {
    headers.set("retry-after", String(decision.retryAfter));
  }
}
